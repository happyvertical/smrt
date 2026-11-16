import type { AIMessage, AITool, AIToolCall } from '@happyvertical/ai';
import type {
  InferenceTierRequest,
  ReasoningEffort,
} from '@happyvertical/smrt-core';
import {
  type EngineModel,
  EngineModelFailure,
  engineModelReply,
} from '../engine-model.js';
import {
  engineTierModel,
  nextEngineModel,
  type RankedModel,
  validateModelId,
} from '../engine-tiers.js';
import {
  type EngineExecution,
  type ModelFallbackStore,
  runWithModelFallback,
} from '../model-fallback.js';
import type { ChatGPTPlanConnection } from './connection.js';
import { chatgptFailureNote } from './support.js';

export interface ChatGPTModelOptions {
  connection: Pick<ChatGPTPlanConnection, 'clientOptions'> &
    Partial<Pick<ChatGPTPlanConnection, 'models'>>;
  /** An explicit model; otherwise `tier` picks one from the plan's catalog. */
  model?: string;
  /** The tier the prompt asks for (#5005), bound to the plan's ranked models. */
  tier?: InferenceTierRequest;
  /**
   * Recorded on the execution, never sent: the ChatGPT plan provider
   * rejects reasoning options.
   */
  effort?: ReasoningEffort;
  catalog?: readonly RankedModel[];
  fallback?: {
    ownerId: string;
    connectionKey: string;
    nextModel?: string;
    store: ModelFallbackStore;
    notify?(message: string): void;
  };
  recordExecution?(execution: EngineExecution): Promise<void>;
  toolNamespace: { name: string; description: string };
  settingsHref?: string;
  /** Tests/hosts may supply a provider factory; never a raw API-key fallback. */
  createClient?(options: Record<string, unknown>): Promise<{
    chat(
      messages: AIMessage[],
      options: {
        tools: AITool[];
        signal: AbortSignal;
        onProgress(delta: string): void;
      },
    ): Promise<{
      model?: string;
      content?: string;
      toolCalls?: AIToolCall[];
      usage?: { totalTokens?: number };
    }>;
  }>;
}

/** A model-round adapter for hosts that own the tool loop. Uses only chat + onProgress. */
export async function createChatGPTModel(
  input: ChatGPTModelOptions,
): Promise<EngineModel> {
  const catalog =
    input.catalog ??
    (input.tier && !input.model
      ? await input.connection.models?.()
      : undefined);
  const selectedModel =
    input.model ??
    (input.tier
      ? engineTierModel({ engine: 'chatgpt', tier: input.tier, catalog })
      : undefined);
  if (input.tier && !selectedModel)
    throw new Error('The connected engine has no available model.');
  if (selectedModel !== undefined) validateModelId(selectedModel);
  const options = await input.connection.clientOptions({
    ...(selectedModel ? { model: selectedModel } : {}),
    toolNamespace: input.toolNamespace,
  });
  const createClient =
    input.createClient ??
    (async (options) => {
      const { getAI } = await import('@happyvertical/ai');
      return getAI(options as unknown as Parameters<typeof getAI>[0]);
    });
  let ai = await createClient(options);
  let actualModel = selectedModel;
  return {
    async complete(request) {
      try {
        const startedAt = Date.now();
        const execute = async (
          model?: string,
          activity?: { markOutput(): void },
        ) => {
          if (model && model !== actualModel) {
            ai = await createClient(
              await input.connection.clientOptions({
                model,
                toolNamespace: input.toolNamespace,
              }),
            );
            actualModel = model;
          }
          return engineModelReply(
            await ai.chat(request.messages, {
              tools: request.tools,
              signal: request.signal,
              onProgress: activity
                ? (delta) => {
                    if (delta) activity.markOutput();
                    request.onText(delta);
                  }
                : request.onText,
            }),
          );
        };
        let fallback: EngineExecution['fallback'];
        let reply: Awaited<ReturnType<typeof execute>>;
        if (selectedModel && input.fallback) {
          const outcome = await runWithModelFallback({
            ...input.fallback,
            nextModel:
              input.fallback.nextModel ??
              nextEngineModel({
                engine: 'chatgpt',
                model: selectedModel,
                catalog: catalog ?? [],
              }),
            engine: 'chatgpt',
            model: selectedModel,
            notify: (message) => {
              input.fallback?.notify?.(message);
              request.onText(`${message}\n\n`);
            },
            execute,
            isPlanModelRefusal: (error) =>
              [
                'MODEL_NOT_AVAILABLE',
                'MODEL_ACCESS_DENIED',
                'model_not_available',
                'model_access_denied',
              ].includes((error as { code?: string })?.code ?? ''),
          });
          reply = outcome.result;
          fallback = outcome.fallback;
        } else reply = await execute(actualModel);
        await input.recordExecution?.({
          engine: 'chatgpt',
          ...(reply.model ? { model: reply.model } : {}),
          ...(actualModel ? { requestedModel: actualModel } : {}),
          ...(input.effort ? { effort: input.effort } : {}),
          durationMs: Date.now() - startedAt,
          ...(reply.totalTokens !== undefined
            ? { tokens: reply.totalTokens }
            : {}),
          toolCalls: reply.toolCalls.length,
          ...(fallback ? { fallback } : {}),
        });
        return reply;
      } catch (error) {
        const note = chatgptFailureNote(error, input.settingsHref);
        if (note)
          throw new EngineModelFailure(note.code, note.message, note.action, {
            cause: error,
          });
        throw error;
      }
    },
  };
}
