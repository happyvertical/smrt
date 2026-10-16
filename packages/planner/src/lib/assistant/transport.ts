import type {
  AssistantMessage,
  AssistantSendMessageInput,
  AssistantSendMessageResult,
  AssistantThreadSummary,
  AssistantTransport,
} from '@happyvertical/smrt-chat/svelte';
import {
  createSliceController,
  type PlannerController,
} from '../planner/commands/index.ts';
import type { Recipe } from '../recipes/types.ts';
import type { ThemeSetting } from '../theme/theme.ts';
import {
  type AppliedChange,
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
  themeUndos?: {
    record(
      previous: ThemeSetting | undefined,
      commandUndoId?: string,
    ): ThemeUndoRef;
  };
  /**
   * The planner controller every change goes through. Omitted, one is made
   * over `store`, `settings` and `theme`, so the assistant needs no more than
   * it did before; the app passes its own so manual edits and the assistant
   * share one Undo history and one snapshot.
   */
  controller?: PlannerController;
  /**
   * Apply `commands` a reply carries, through the controller. Only for a
   * server the host chose (host mode); a local or bring-your-own model's
   * reply is held to the schema's recipes, settings and theme.
   */
  acceptCommands?: boolean | (() => boolean);
  /** Said when `model()` is null; the default asks for a download. */
  unavailable?: string | (() => string);
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

const hasKeys = (value: object) => Object.keys(value).length > 0;

/** Run one command; what it said, or nothing when it was refused. */
function runCommand(
  controller: PlannerController,
  name: 'set_settings' | 'set_theme',
  input: object,
): { summary: string; undoId?: string } {
  const result = controller.run({ name, input });
  return result.ok
    ? { summary: result.receipt.summary, undoId: result.receipt.undoId }
    : { summary: '' };
}

const runSummary = (
  controller: PlannerController,
  name: 'set_settings' | 'set_theme',
  input: object,
) => runCommand(controller, name, input).summary;

/**
 * Command calls from a host server, in order. A refused one is said once and
 * stops the rest, so a half-applied sequence never looks complete.
 */
function runCommands(
  controller: PlannerController,
  calls: readonly { name: string; input: unknown }[],
): string {
  const lines: string[] = [];
  for (const call of calls) {
    const result = controller.run(call);
    if (!result.ok) {
      lines.push(
        `The server's ${call.name} was refused: ${result.error.message}`,
      );
      break;
    }
    if (result.receipt.summary) lines.push(result.receipt.summary);
  }
  return lines.join(' ');
}

/**
 * The model's `add` and `remove` as commands, reported as one change: what
 * really ended up on or off, after `requires`, and what was kept because
 * another recipe needs it.
 */
function applyRecipes(
  controller: PlannerController,
  change: { add: string[]; remove: string[] },
): AppliedChange {
  const added = change.add.length
    ? controller.run({ name: 'add_recipes', input: { ids: change.add } })
    : null;
  const removed = change.remove.length
    ? controller.run({ name: 'remove_recipes', input: { ids: change.remove } })
    : null;
  const on = added?.ok ? (added.receipt.changes?.added ?? []) : [];
  const off = removed?.ok ? (removed.receipt.changes?.removed ?? []) : [];
  return {
    // A recipe added and removed in one turn (one pulled in by the other) is neither.
    added: on.filter((id) => !off.includes(id)),
    removed: off.filter((id) => !on.includes(id)),
    kept: removed?.ok ? (removed.receipt.changes?.kept ?? []) : [],
  };
}

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
  const planner =
    options.controller ??
    createSliceController({
      store: options.store,
      settings: options.settings,
      theme: options.theme,
    });
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
          (typeof options.unavailable === 'function'
            ? options.unavailable()
            : options.unavailable) ??
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
      const change = parseChange(raw, options.recipes, cookbooks, {
        commands:
          typeof options.acceptCommands === 'function'
            ? options.acceptCommands()
            : options.acceptCommands,
      });
      const applied = applyRecipes(planner, change);
      const settingsText =
        options.settings && hasKeys(change.settings)
          ? runSummary(planner, 'set_settings', change.settings)
          : '';
      const previousTheme = options.theme?.read();
      const themed =
        options.theme && hasKeys(change.theme)
          ? runCommand(planner, 'set_theme', change.theme)
          : null;
      const undo =
        themed?.undoId && options.themeUndos
          ? options.themeUndos.record(previousTheme, themed.undoId)
          : undefined;
      const commandText = (change.commands ?? []).length
        ? runCommands(planner, change.commands ?? [])
        : '';
      const summary = [
        describeChange(applied, options.recipes),
        settingsText,
        themed?.summary ?? '',
        commandText,
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
