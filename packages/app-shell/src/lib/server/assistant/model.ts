// The model seam. The turn loop talks to an `AssistantModel`; production wraps
// an `@happyvertical/ai` client built from the configured API key (config.ts),
// tests inject a stub through the factory so nothing ever reaches a network.
import type { AIClient, AIClientOptions } from '@happyvertical/ai';
import {
  type AiRunContext,
  createTrackedAiClient,
  type TrackedAiClient,
} from '@happyvertical/smrt-core';
import {
  type ResolvedPrompt,
  trackedPromptCall,
} from '@happyvertical/smrt-prompts';
import type { AssistantEngineId } from '../../assistant/events.ts';
import {
  CHATGPT_SETTINGS_HREF,
  CHATGPT_TOOL_NAMESPACE,
  chatgptConnection,
} from '../chatgpt.ts';
import { getShellDb } from '../host.ts';
import type { Principal } from '../owner.ts';
import type { AssistantConfigOptions } from './config.ts';
import {
  assertApiKeyOptions,
  resolveAssistantOptions,
  resolveChatGPTAssistantModel,
} from './config.ts';
import { resolveAssistantPrompt } from './guidance.ts';

export {
  type EngineModel as AssistantModel,
  EngineModelFailure as ModelFailure,
  type EngineModelReply as ModelReply,
  type EngineModelRequest as ModelRequest,
  type EngineModelToolCall as ModelToolCall,
} from '@happyvertical/smrt-inference/server';

import {
  type EngineModel as AssistantModel,
  createChatGPTModel,
  engineModelReply as toolCallsOf,
} from '@happyvertical/smrt-inference/server';

/**
 * An assistant model whose calls are tracked (#5005): they go through core's
 * tracked client on the shell database, tagged with the assistant's prompt
 * key. `bind` returns the model for one turn's run, so each call of the turn
 * is a reserved, settled call of that run.
 */
export interface TrackedAssistantModel extends AssistantModel {
  readonly tracked: TrackedAiClient;
  bind(prompt: ResolvedPrompt, run: AiRunContext): AssistantModel;
}

export function isTrackedAssistantModel(
  model: AssistantModel,
): model is TrackedAssistantModel {
  return (
    typeof (model as Partial<TrackedAssistantModel>).bind === 'function' &&
    Boolean((model as Partial<TrackedAssistantModel>).tracked)
  );
}

/**
 * Builds the model for a turn. The principal is the verified owner; `engine`
 * is the owner's choice (`chatgpt` or, by default, the API key).
 */
export type AssistantModelFactory = (context: {
  principal: Principal;
  engine?: AssistantEngineId;
}) => Promise<AssistantModel>;

/**
 * Production factory: resolves the tier binding and key (refusing
 * subscription providers) and adapts `ai.chat()` on the tracked client of
 * the owner's tenant and the shell database (the provider SDK loads per
 * turn, never at mount).
 */
export function createAiModelFactory(
  config: AssistantConfigOptions = {},
): AssistantModelFactory {
  return async ({ principal, engine }) => {
    if (engine === 'chatgpt') {
      const connection = await chatgptConnection();
      const model = await resolveChatGPTAssistantModel(principal, config);
      return createChatGPTModel({
        connection,
        model,
        toolNamespace: CHATGPT_TOOL_NAMESPACE,
        settingsHref: CHATGPT_SETTINGS_HREF,
      });
    }
    const options = await resolveAssistantOptions(principal, config);
    assertApiKeyOptions(options);
    const db = await getShellDb();
    // The tier is already bound in `options`; the thread is stored in
    // shell.db, so no transcript copy is made.
    const tracked = createTrackedAiClient({
      db,
      tenantId: principal.tenantId,
      className: 'AppShellAssistant',
      ai: options as AIClientOptions,
      transcript: false,
    });
    const send = async (
      ai: AIClient,
      request: Parameters<AssistantModel['complete']>[0],
    ) => {
      const response = await (ai as unknown as AiChat).chat(request.messages, {
        tools: request.tools,
        toolChoice: 'auto',
        maxTokens: request.maxTokens,
        signal: request.signal,
        stream: true,
        onProgress: request.onText,
      });
      return toolCallsOf(response);
    };
    return {
      tracked,
      // Outside a run (a caller that did not bind one): a single tracked call.
      async complete(request) {
        const prompt = await resolveAssistantPrompt({
          db,
          tenantId: principal.tenantId,
        });
        return send(await tracked.client(trackedPromptCall(prompt)), request);
      },
      bind(prompt, run) {
        return {
          async complete(request) {
            return send(
              await tracked.client(trackedPromptCall(prompt), {
                runContext: run,
              }),
              request,
            );
          },
        };
      },
    } satisfies TrackedAssistantModel;
  };
}

type AiChat = {
  chat(
    messages: Parameters<AssistantModel['complete']>[0]['messages'],
    options: Record<string, unknown>,
  ): Promise<Parameters<typeof toolCallsOf>[0]>;
};
