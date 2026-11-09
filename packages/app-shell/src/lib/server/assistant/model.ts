// The model seam. The turn loop talks to an `AssistantModel`; production wraps
// an `@happyvertical/ai` client built from the configured API key (config.ts),
// tests inject a stub through the factory so nothing ever reaches a network.
import type { AIMessage, AITool, AIToolCall } from '@happyvertical/ai';
import type { Principal } from '../owner.ts';
import type { AssistantConfigOptions } from './config.ts';
import { assertApiKeyOptions, resolveAssistantOptions } from './config.ts';

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

/** Builds the model for a turn. The principal is the verified owner. */
export type AssistantModelFactory = (context: {
  principal: Principal;
}) => Promise<AssistantModel>;

/**
 * Production factory: resolves the tier binding and key (refusing
 * subscription providers), builds the client lazily (the provider SDK loads
 * per turn, never at mount) and adapts `ai.chat()`.
 */
export function createAiModelFactory(
  config: AssistantConfigOptions = {},
): AssistantModelFactory {
  return async ({ principal }) => {
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
      },
    };
  };
}
