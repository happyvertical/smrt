import type { AIMessage, AITool, AIToolCall } from '@happyvertical/ai';

/** One call the model asked for. */
export interface EngineModelToolCall {
  id: string;
  name: string;
  /** JSON text, as the provider sent it. */
  arguments: string;
}

export interface EngineModelRequest {
  messages: AIMessage[];
  tools: AITool[];
  maxTokens: number;
  /** Aborts on client disconnect, the per-call timeout or the turn timeout. */
  signal: AbortSignal;
  /** Called with reply text as it arrives (may never be called). */
  onText(delta: string): void;
}

export interface EngineModelReply {
  text: string;
  toolCalls: EngineModelToolCall[];
  /** Total tokens the call used, when the provider reports it. */
  totalTokens?: number;
  /** Provider tool-call records, replayed verbatim on the next step. */
  raw?: AIToolCall[];
}

export interface EngineModel {
  complete(request: EngineModelRequest): Promise<EngineModelReply>;
}

/**
 * A model failure with words for the dock (and an optional fix). The turn
 * loop shows `message` and `action` and logs only the cause's class and code.
 */
export class EngineModelFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly action?: { label: string; href: string },
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'EngineModelFailure';
  }
}

export function engineModelReply(response: {
  content?: string;
  toolCalls?: AIToolCall[];
  usage?: { totalTokens?: number };
}): EngineModelReply {
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
