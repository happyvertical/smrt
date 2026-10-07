import type {
  AssistantMessage,
  AssistantSendMessageInput,
  AssistantSendMessageResult,
  AssistantThreadSummary,
  AssistantTransport,
} from '@happyvertical/smrt-chat/svelte';
import type { Recipe } from '../recipes/types.ts';
import {
  applyChange,
  buildResponseSchema,
  describeChange,
  parseChange,
  type RecipeStore,
} from './change.ts';
import { buildSystemPrompt } from './prompt.ts';

/** The slice of `@happyvertical/ai`'s provider the transport uses. */
export interface ChatModel {
  message(
    text: string,
    options?: {
      history?: { role: 'system' | 'user' | 'assistant'; content: string }[];
      responseSchema?: Record<string, unknown> | string;
      temperature?: number;
      signal?: AbortSignal;
    },
  ): Promise<string>;
}

export interface BrowserTransportOptions {
  /** The loaded model; null until the visitor has downloaded one. */
  model: () => ChatModel | null;
  store: RecipeStore;
  recipes: readonly Recipe[];
  now?: () => number;
}

export interface BrowserAssistantTransport extends AssistantTransport {
  /** Stop the turn in flight, if any. */
  abort(): void;
}

const THREAD_TITLE = 'Plan your app';
/** Earlier turns sent back to the model; a small model needs a short context. */
const HISTORY_TURNS = 6;

/**
 * An `AssistantTransport` that runs entirely in the browser: one thread, kept
 * in memory, whose turns go to the on-device model with the recipes as a
 * constrained schema. The model's `add`/`remove` are applied through the same
 * recipe store the Planner cards drive. It never navigates.
 */
export function createBrowserAssistantTransport(
  options: BrowserTransportOptions,
): BrowserAssistantTransport {
  const now = options.now ?? (() => Date.now());
  let counter = 0;
  const id = (prefix: string) => `${prefix}-${++counter}`;
  const thread: AssistantThreadSummary = {
    id: 'planner',
    title: THREAD_TITLE,
    isResolved: false,
    messageCount: 0,
    lastMessageAt: null,
  };
  const messages: AssistantMessage[] = [];
  const seen = new Map<string, AssistantSendMessageResult>();
  let controller: AbortController | null = null;

  const push = (
    role: 'user' | 'assistant',
    content: string,
    clientRequestId?: string,
  ): AssistantMessage => {
    const message: AssistantMessage = {
      id: id('m'),
      threadId: thread.id,
      content,
      role,
      createdAt: new Date(now()),
      ...(clientRequestId ? { clientRequestId } : {}),
    };
    messages.push(message);
    thread.messageCount = messages.length;
    thread.lastMessageAt = message.createdAt;
    return message;
  };

  async function turn(text: string): Promise<string> {
    const model = options.model();
    if (!model) {
      return 'Download a model first, then I can help. The cards on the Planner page work without one.';
    }
    controller = new AbortController();
    try {
      const prior = messages
        .slice(0, -1)
        .slice(-HISTORY_TURNS)
        .map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        }));
      const raw = await model.message(text, {
        history: [
          {
            role: 'system',
            content: buildSystemPrompt(options.recipes, options.store.ids),
          },
          ...prior,
        ],
        responseSchema: buildResponseSchema(options.recipes),
        temperature: 0,
        signal: controller.signal,
      });
      const change = parseChange(raw, options.recipes);
      const applied = applyChange(options.store, change);
      const summary = describeChange(applied, options.recipes);
      return [change.reply, summary].filter(Boolean).join('\n\n') || 'Done.';
    } catch (error) {
      if (controller?.signal.aborted) return 'Stopped.';
      const detail = error instanceof Error ? error.message : String(error);
      return `Sorry, the model could not answer: ${detail}`;
    } finally {
      controller = null;
    }
  }

  return {
    async listThreads() {
      return [thread];
    },
    async createThread() {
      return thread;
    },
    async loadMessages() {
      return [...messages];
    },
    async sendMessage(
      input: AssistantSendMessageInput,
    ): Promise<AssistantSendMessageResult> {
      const cached = seen.get(input.clientRequestId);
      if (cached) return cached;
      const userMessage = push('user', input.content, input.clientRequestId);
      const reply = await turn(input.content);
      const result: AssistantSendMessageResult = {
        inProgress: false,
        userMessage,
        assistantMessage: push('assistant', reply),
      };
      seen.set(input.clientRequestId, result);
      return result;
    },
    async uploadAttachment(file: File) {
      throw new Error(`The assistant cannot take attachments (${file.name}).`);
    },
    abort() {
      controller?.abort();
    },
  };
}
