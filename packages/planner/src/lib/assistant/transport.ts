import type {
  AssistantMessage,
  AssistantSendMessageInput,
  AssistantSendMessageResult,
  AssistantThreadSummary,
  AssistantTransport,
} from '@happyvertical/smrt-chat/svelte';
import type { Recipe } from '../recipes/types.ts';
import type { ThemeSetting } from '../theme/theme.ts';
import {
  applyChange,
  applySettings,
  applyThemePatch,
  buildResponseSchema,
  describeChange,
  parseChange,
  type RecipeStore,
  type SettingsStore,
  type ThemeStore,
} from './change.ts';
import { buildMatchIndex, matchText } from './match.ts';
import type { OfferRef } from './offers.svelte.ts';
import { buildSystemPrompt, type CookbookBrief } from './prompt.ts';
import type { ThemeUndoRef } from './theme-undo.svelte.ts';

/** The slice of `@happyvertical/ai`'s provider the transport uses. */
export interface ChatModel {
  message(
    text: string,
    options?: {
      history?: { role: 'system' | 'user' | 'assistant'; content: string }[];
      responseSchema?: Record<string, unknown> | string;
      temperature?: number;
      maxTokens?: number;
      signal?: AbortSignal;
    },
  ): Promise<string>;
}

export interface BrowserTransportOptions {
  /** The loaded model; null until the visitor has downloaded one. */
  model: () => ChatModel | null;
  store: RecipeStore;
  recipes: readonly Recipe[];
  /** Cookbooks the assistant may offer (id, name, summary). */
  cookbooks?: readonly CookbookBrief[];
  /** Proposes a cookbook; the person's click applies it. Null: already pending. */
  offers?: {
    offer(cookbookId: string): OfferRef | null;
    /** True when a cookbook is applied or pending; omit to never back up. */
    engaged?(): boolean;
  };
  /** The app settings the assistant may read and change. */
  settings?: SettingsStore;
  /** The app theme the assistant may change; each change can be undone. */
  theme?: ThemeStore;
  themeUndos?: { record(previous: ThemeSetting | undefined): ThemeUndoRef };
  now?: () => number;
  /** Called with each reply the model produced (not errors), e.g. to read it aloud. */
  onReply?: (text: string) => void;
}

export interface BrowserAssistantTransport extends AssistantTransport {
  /** Stop the turn in flight, if any. */
  abort(): void;
}

const THREAD_TITLE = 'Plan your app';
/** The one line the chat opens with. */
export const GREETING = 'What would you like to build?';
/** Earlier turns sent back to the model; a small model needs a short context. */
const HISTORY_TURNS = 6;
/** A turn's JSON fits well inside this; a looping model is cut off, not left running. */
const MAX_REPLY_TOKENS = 400;

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
    toolCallData?: unknown,
  ): AssistantMessage => {
    const message: AssistantMessage = {
      id: id('m'),
      threadId: thread.id,
      content,
      role,
      createdAt: new Date(now()),
      ...(clientRequestId ? { clientRequestId } : {}),
    };
    if (toolCallData) message.toolCallData = toolCallData;
    messages.push(message);
    thread.messageCount = messages.length;
    thread.lastMessageAt = message.createdAt;
    return message;
  };
  const index = buildMatchIndex(options.recipes, options.cookbooks ?? [], {
    theme: !!options.theme,
  });
  const greeting = push('assistant', GREETING);

  async function turn(
    text: string,
  ): Promise<{ content: string; refs?: unknown }> {
    const model = options.model();
    if (!model) {
      return {
        content:
          'Download a model first, then I can help. The cards on the Planner page work without one.',
      };
    }
    controller = new AbortController();
    try {
      const cookbooks = options.cookbooks ?? [];
      const prior = messages
        .filter((m) => m !== greeting)
        .slice(0, -1)
        .slice(-HISTORY_TURNS)
        .map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        }));
      const matches = matchText(index, text);
      const raw = await model.message(text, {
        history: [
          {
            role: 'system',
            content: buildSystemPrompt(
              options.recipes,
              options.store.ids,
              cookbooks,
              options.settings?.read(),
              matches,
              options.theme ? { current: options.theme.read() } : undefined,
            ),
          },
          ...prior,
        ],
        responseSchema: buildResponseSchema(
          options.recipes,
          cookbooks,
          !!options.settings,
          !!options.theme,
        ),
        temperature: 0,
        maxTokens: MAX_REPLY_TOKENS,
        signal: controller.signal,
      });
      const change = parseChange(raw, options.recipes, cookbooks);
      const applied = applyChange(options.store, change);
      const themed = options.theme
        ? applyThemePatch(options.theme, change.theme)
        : null;
      const undo =
        themed && options.themeUndos
          ? options.themeUndos.record(themed.previous)
          : undefined;
      const summary = [
        describeChange(applied, options.recipes),
        options.settings
          ? applySettings(options.settings, change.settings)
          : '',
        themed?.text ?? '',
      ]
        .filter(Boolean)
        .join(' ');
      // Backstop: a small model sometimes misses a plain "I run a bakery".
      // A strong cookbook match is offered anyway (never applied without the
      // click) when the model offered none and none is applied or pending.
      // Strong recipe matches are only hinted, never added.
      const strongCookbook = matches.find(
        (m) => m.kind === 'cookbook' && m.confidence === 'strong',
      )?.id;
      const cookbookId =
        change.cookbook ??
        (strongCookbook && options.offers?.engaged?.() === false
          ? strongCookbook
          : null);
      const offer = cookbookId
        ? (options.offers?.offer(cookbookId) ?? undefined)
        : undefined;
      const offered = offer
        ? cookbooks.find((c) => c.id === cookbookId)
        : undefined;
      const line = change.reply || (offered ? `Set up ${offered.name}?` : '');
      const reply = [line, summary].filter(Boolean).join(' ');
      if (line) options.onReply?.(line);
      // One ref renders as is; a cookbook offer and a theme Undo in one turn ride together.
      const refs = offer && undo ? [offer, undo] : (offer ?? undo);
      return { content: reply || 'Done.', refs };
    } catch (error) {
      if (controller?.signal.aborted) return { content: 'Stopped.' };
      const detail = error instanceof Error ? error.message : String(error);
      return { content: `Sorry, the model could not answer: ${detail}` };
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
        assistantMessage: push(
          'assistant',
          reply.content,
          undefined,
          reply.refs,
        ),
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
