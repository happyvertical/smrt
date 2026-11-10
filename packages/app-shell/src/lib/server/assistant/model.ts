// The model seam. The turn loop talks to an `AssistantModel`; production wraps
// an `@happyvertical/ai` client built from the configured API key (config.ts),
// tests inject a stub through the factory so nothing ever reaches a network.
import type { AIMessage, AITool, AIToolCall } from '@happyvertical/ai';
import type { AssistantEngineId } from '../../assistant/events.ts';
import {
  CHATGPT_TOOL_NAMESPACE,
  chatgptConnection,
  chatgptFailureNote,
} from '../chatgpt.ts';
import type { Principal } from '../owner.ts';
import type { AssistantConfigOptions } from './config.ts';
import {
  assertApiKeyOptions,
  resolveAssistantOptions,
  resolveChatGPTAssistantModel,
} from './config.ts';

/** One call the model asked for. */
export interface ModelToolCall {
  id: string;
  name: string;
  /** JSON text, as the provider sent it. */
  arguments: string;
}

export interface ModelRequest {
  messages: AIMessage[];
  tools: AITool[];
  maxTokens: number;
  /** Aborts on client disconnect, the per-call timeout or the turn timeout. */
  signal: AbortSignal;
  /** Called with reply text as it arrives (may never be called). */
  onText(delta: string): void;
}

export interface ModelReply {
  text: string;
  toolCalls: ModelToolCall[];
  /** Total tokens the call used, when the provider reports it. */
  totalTokens?: number;
  /** Provider tool-call records, replayed verbatim on the next step. */
  raw?: AIToolCall[];
}

export interface AssistantModel {
  complete(request: ModelRequest): Promise<ModelReply>;
}

/**
 * A model failure with words for the dock (and an optional fix). The turn
 * loop shows `message` and `action` and logs only the cause's class and code.
 */
export class ModelFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly action?: { label: string; href: string },
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ModelFailure';
  }
}

/**
 * Builds the model for a turn. The principal is the verified owner; `engine`
 * is the owner's choice (`chatgpt` or, by default, the API key).
 */
export type AssistantModelFactory = (context: {
  principal: Principal;
  engine?: AssistantEngineId;
}) => Promise<AssistantModel>;

function toolCallsOf(response: {
  content?: string;
  toolCalls?: AIToolCall[];
  usage?: { totalTokens?: number };
}): ModelReply {
  return {
    text: response.content ?? '',
    toolCalls: (response.toolCalls ?? []).map((c) => ({
      id: c.id,
      name: c.function.name,
      arguments: c.function.arguments,
    })),
    ...(response.usage?.totalTokens !== undefined
      ? { totalTokens: response.usage.totalTokens }
      : {}),
    ...(response.toolCalls ? { raw: response.toolCalls } : {}),
  };
}

/**
 * The `chatgpt` engine's model (Sign in with ChatGPT, a preview): a
 * `chatgpt-plan` client built from the signed-in account only. It drives the
 * tool loop with `chat()` and `onProgress` (the provider's `stream()` rejects
 * tools) and sends none of what the preview refuses: no `maxTokens`, sampling,
 * `user`, response format, reasoning option, `stream` flag or forced tool
 * choice. The loop's own step, time and token limits still bound the turn.
 */
async function createChatGPTModel(
  principal: Principal,
  config: AssistantConfigOptions,
): Promise<AssistantModel> {
  const connection = await chatgptConnection();
  const model = await resolveChatGPTAssistantModel(principal, config);
  const options = await connection.clientOptions({
    ...(model ? { model } : {}),
    toolNamespace: CHATGPT_TOOL_NAMESPACE,
  });
  const { getAI } = await import('@happyvertical/ai');
  const ai = await getAI(options as unknown as Parameters<typeof getAI>[0]);
  return {
    async complete(request) {
      try {
        return toolCallsOf(
          await ai.chat(request.messages, {
            tools: request.tools,
            signal: request.signal,
            onProgress: request.onText,
          }),
        );
      } catch (error) {
        const note = chatgptFailureNote(error);
        if (note)
          throw new ModelFailure(note.code, note.message, note.action, {
            cause: error,
          });
        throw error;
      }
    },
  };
}

/**
 * Production factory: resolves the tier binding and key (refusing
 * subscription providers), builds the client lazily (the provider SDK loads
 * per turn, never at mount) and adapts `ai.chat()`.
 */
export function createAiModelFactory(
  config: AssistantConfigOptions = {},
): AssistantModelFactory {
  return async ({ principal, engine }) => {
    if (engine === 'chatgpt') return createChatGPTModel(principal, config);
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
