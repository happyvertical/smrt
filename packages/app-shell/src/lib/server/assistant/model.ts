// The model seam. The turn loop talks to an `AssistantModel`; production wraps
// an `@happyvertical/ai` client built from the configured API key (config.ts),
// tests inject a stub through the factory so nothing ever reaches a network.
import type { AssistantEngineId } from '../../assistant/events.ts';
import {
  CHATGPT_SETTINGS_HREF,
  CHATGPT_TOOL_NAMESPACE,
  chatgptConnection,
} from '../chatgpt.ts';
import type { Principal } from '../owner.ts';
import type { AssistantConfigOptions } from './config.ts';
import {
  assertApiKeyOptions,
  resolveAssistantOptions,
  resolveChatGPTAssistantModel,
} from './config.ts';

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
 * Builds the model for a turn. The principal is the verified owner; `engine`
 * is the owner's choice (`chatgpt` or, by default, the API key).
 */
export type AssistantModelFactory = (context: {
  principal: Principal;
  engine?: AssistantEngineId;
}) => Promise<AssistantModel>;

/**
 * Production factory: resolves the tier binding and key (refusing
 * subscription providers), builds the client lazily (the provider SDK loads
 * per turn, never at mount) and adapts `ai.chat()`.
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
    const { getAI } = await import('@happyvertical/ai');
    const ai = await getAI(options as Parameters<typeof getAI>[0]);
    return {
      async complete(request) {
        const response = await ai.chat(request.messages, {
          tools: request.tools,
          toolChoice: 'auto',
          maxTokens: request.maxTokens,
          signal: request.signal,
          stream: true,
          onProgress: request.onText,
        });
        return toolCallsOf(response);
      },
    };
  };
}
