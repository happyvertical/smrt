import type { AIMessage, AITool, AIToolCall } from '@happyvertical/ai';
import {
  type EngineModel,
  EngineModelFailure,
  engineModelReply,
} from '../engine-model.js';
import {
  nextWorkModel,
  type ResolvedWorkProfile,
  resolveWorkProfile,
  runWorkModelWithFallback,
  validateWorkModel,
  type WorkModelCatalogEntry,
  type WorkModelFallbackStore,
  type WorkProfileName,
  type WorkProfileSettings,
  type WorkRunMetadata,
} from '../work-profiles.js';
import type { ChatGPTPlanConnection } from './connection.js';
import { chatgptFailureNote } from './support.js';

export interface ChatGPTModelOptions {
  connection: Pick<ChatGPTPlanConnection, 'clientOptions'> &
    Partial<Pick<ChatGPTPlanConnection, 'models'>>;
  model?: string;
  profile?: WorkProfileName;
  settings?: WorkProfileSettings;
  catalog?: readonly WorkModelCatalogEntry[];
  fallback?: {
    ownerId: string;
    connectionKey: string;
    nextModel?: string;
    store: WorkModelFallbackStore;
    notify?(message: string): void;
  };
  recordExecution?(metadata: WorkRunMetadata): Promise<void>;
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
    (input.profile ? await input.connection.models?.() : undefined);
  const profile: ResolvedWorkProfile | undefined = input.profile
    ? resolveWorkProfile({
        profile: input.profile,
        engine: 'chatgpt',
        settings: {
          ...input.settings,
          ...(input.model ? { model: input.model } : {}),
        },
        catalog,
      })
    : undefined;
  if (profile && profile.engine !== 'chatgpt')
    throw new Error('The work profile does not match this connected engine.');
  const selectedModel = profile?.model ?? input.model;
  if (selectedModel !== undefined) validateWorkModel(selectedModel);
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
        let fallback: WorkRunMetadata['fallback'];
        let reply: Awaited<ReturnType<typeof execute>>;
        if (profile && input.fallback) {
          const outcome = await runWorkModelWithFallback({
            ...input.fallback,
            nextModel:
              input.fallback.nextModel ??
              nextWorkModel(catalog ?? [], profile.model),
            profile,
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
        if (profile)
          await input.recordExecution?.({
            profile: profile.name,
            engine: 'chatgpt',
            model: reply.model,
            requestedModel: actualModel,
            effort: profile.effort,
            durationMs: Date.now() - startedAt,
            tokens: reply.totalTokens,
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
