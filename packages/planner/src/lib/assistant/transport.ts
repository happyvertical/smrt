import {
  ASSISTANT_QUESTION_KIND,
  type AssistantAnswerQuestionInput,
  type AssistantMessage,
  type AssistantQuestion,
  type AssistantQuestionAnswer,
  type AssistantSendMessageInput,
  type AssistantSendMessageResult,
  type AssistantThreadSummary,
  type AssistantTransport,
  matchAssistantQuestionText,
  validateAssistantQuestionAnswer,
} from '@happyvertical/smrt-chat/svelte';
import { resolveRuntimeReportTimeRange } from '@happyvertical/smrt-reports/spec';
import {
  createSliceController,
  type PlannerController,
} from '../planner/commands/index.ts';
import type { Recipe } from '../recipes/types.ts';
import {
  type ReportFollowUp,
  type ReportFollowUpOption,
  type ReportIntent,
  sourceFollowUp,
  whichSourceQuestion,
} from '../reports/intent.ts';
import type { PlannerReports } from '../reports/store.ts';
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
import {
  buildSystemPrompt,
  type CookbookBrief,
  REPORTS_RECIPE,
} from './prompt.ts';
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
  /**
   * The menu sections the assistant may open (`focus` with a `section`):
   * only where the running app navigates to them. Omitted or empty, the
   * assistant cannot navigate and the schema has no `open`.
   */
  menu?: () => readonly { id: string; label: string }[];
  /**
   * Runtime reports over the app's sample data (#4100). With it the model may
   * answer a report request with a `report` intent, which the transport turns
   * into smrt-reports' `reports.runtime.*` steps: sources, define (preview),
   * run; the person's approval saves. Null or omitted: no report building.
   */
  reports?: () => PlannerReports | null;
}

export interface BrowserAssistantTransport extends AssistantTransport {
  /** Stop the turn in flight, if any. */
  abort(): void;
  /**
   * Record how a report preview was answered on the transcript's own tool
   * data, so a reloaded transcript shows the outcome, not live buttons.
   */
  recordReportOutcome(specHash: string, outcome: unknown): void;
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

/** Said when a turn changed nothing and the model's sentence was not a question. */
export const NOTHING_CHANGED = 'Nothing in the app changed.';

/** Said after a report request where this planner has no sample data to report on. */
export const REPORTS_UNAVAILABLE =
  'Building a report needs the planner app and its sample records; it will live under Reports.';

/** The tool call a report preview rides on, as smrt-chat names it. */
export const REPORT_DEFINE_TOOL = 'reports.runtime.define';

/** A report follow-up as smrt-chat's structured question (a form in the dock). */
export function reportQuestion(
  followUp: ReportFollowUp,
  id: string,
): AssistantQuestion {
  return {
    kind: ASSISTANT_QUESTION_KIND,
    id,
    prompt: followUp.prompt,
    fields: [
      {
        name: followUp.field,
        label: followUp.label,
        type: 'choice',
        options: followUp.options.map(({ value, label, keywords }) => ({
          value,
          label,
          ...(keywords ? { keywords } : {}),
        })),
        default: followUp.default,
        required: true,
      },
    ],
  };
}

/** Merge a follow-up pick or a model's partial answer into a pending intent. */
function mergeIntent(
  base: ReportIntent,
  patch: Partial<ReportIntent>,
): ReportIntent {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete out[key];
    else out[key] = value;
  }
  return out as unknown as ReportIntent;
}

/** Words that are filler, or time words the report reads itself. */
const ANSWER_FILLER = new Set([
  'a',
  'an',
  'and',
  'the',
  'by',
  'per',
  'of',
  'in',
  'on',
  'for',
  'to',
  'with',
  'please',
  'use',
  'i',
  'want',
  'it',
  'its',
  'group',
  'grouped',
  'show',
  'me',
  'just',
  'ok',
  'okay',
  'yes',
  'that',
  'one',
  'option',
  'last',
  'this',
  'past',
  'previous',
  'current',
  'day',
  'week',
  'month',
  'quarter',
  'year',
  'today',
  'yesterday',
  'ytd',
  'date',
  'time',
]);
const answerWords = (text: string) =>
  text
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w));

/**
 * A typed reply that answers the pending question and says nothing else
 * ("the date month", "status", "status last month"): every word is an
 * option's word, filler, or a time word the report reads itself. Anything
 * more ("invoices over $500", "add invoicing") goes to the model with the
 * pending question in its prompt, so nothing the person said is dropped.
 */
function directAnswer(
  followUp: ReportFollowUp,
  question: AssistantQuestion,
  text: string,
): ReportFollowUpOption | undefined {
  const values = matchAssistantQuestionText(question, text);
  if (!values) return undefined;
  const known = new Set(
    followUp.options.flatMap((o) =>
      answerWords([o.label, o.value, ...(o.keywords ?? [])].join(' ')),
    ),
  );
  // A number counts only when it is part of a period the time parser read
  // ("last 90 days", "Q3", "2025"); "over 500" is a threshold for the model.
  const period = resolveRuntimeReportTimeRange(text, new Date()) !== null;
  const extra = answerWords(text).filter(
    (w) =>
      !known.has(w) &&
      !ANSWER_FILLER.has(w) &&
      !(period && (/^\d+$/.test(w) || /^q[1-4]$/.test(w))),
  );
  if (extra.length) return undefined;
  const chosen = values[followUp.field];
  const value = Array.isArray(chosen) ? chosen[0] : chosen;
  return followUp.options.find((o) => o.value === value);
}

const sameFollowUp = (a: ReportFollowUp, b: ReportFollowUp) =>
  a.field === b.field &&
  a.prompt === b.prompt &&
  a.options.map((o) => o.value).join('|') ===
    b.options.map((o) => o.value).join('|');

/** What the chat says under a report preview. */
export function reportPreviewText(title: string, rows: number): string {
  return `Here is a preview of ${title} (${rows} ${rows === 1 ? 'row' : 'rows'}). Approve it to save it under Saved reports.`;
}

/** The Reports menu entry (reports.runtime's RuntimeReport). */
const REPORTS_ITEM = 'item:reports:RuntimeReport';

/**
 * What the chat says for a turn. When something ran, the commands' own
 * summaries ("Added Invoicing.", "Opened Billing."), never the model's
 * sentence, which may claim more than ran ("Added a sales report"). When
 * nothing ran, the model's sentence (an answer or a question), plus a plain
 * note that nothing changed unless it asks something or offers a cookbook.
 */
export function honestReply(
  line: string,
  summary: string,
  offered: boolean,
): string {
  if (summary) return summary;
  if (offered || line.trim().endsWith('?')) return line;
  return [line, NOTHING_CHANGED].filter(Boolean).join(' ');
}

/** Open a menu section through `focus`; what happened, failure included. */
function openSection(
  controller: PlannerController,
  id: string,
  menu: readonly { id: string; label: string }[],
): string {
  const label = menu.find((section) => section.id === id)?.label ?? id;
  const result = controller.run({ name: 'focus', input: { section: id } });
  return result.ok
    ? `Opened ${label}.`
    : `Could not open ${label}: ${result.error.message}`;
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
 * recipe store the Planner cards drive. It navigates only to a menu section
 * `menu` offers. What it says it did is what the commands' results say: the
 * model's own sentence stands only when nothing changed, and then says so.
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
  /**
   * The report follow-up waiting for an answer: the intent so far, the
   * question asked (its options from the source descriptor), and the words
   * of the original request (their time words still count).
   */
  let pending: {
    intent: ReportIntent;
    followUp: ReportFollowUp;
    question: AssistantQuestion;
    text: string;
  } | null = null;
  let questions = 0;

  /**
   * `reports.runtime.define` (preview) then `run`, by code. A follow-up the
   * intent still needs becomes a form (and the pending question); asking the
   * identical question twice is never done: the sensible default is taken
   * and the reply says so.
   */
  async function buildReport(
    reports: PlannerReports,
    intent: ReportIntent,
    text: string,
    previous: ReportFollowUp | null,
  ): Promise<{ text: string; ref?: unknown; added: string[] }> {
    const defined = await reports.define(intent, text);
    if (defined.ok) {
      pending = null;
      // Reports must be on to keep the report; turning it on is a command
      // like any other, so the reply says it ran.
      const added = options.store.ids.includes(REPORTS_RECIPE)
        ? []
        : applyRecipes(planner, { add: [REPORTS_RECIPE], remove: [] }).added;
      return {
        added,
        ref: {
          name: REPORT_DEFINE_TOOL,
          phase: 'preview',
          result: defined.proposal,
        },
        text: reportPreviewText(
          defined.proposal.spec.title,
          defined.proposal.preview.rowCount,
        ),
      };
    }
    const followUp = defined.followUp;
    if (!followUp) {
      pending = null;
      return { added: [], text: defined.question };
    }
    if (previous && sameFollowUp(previous, followUp)) {
      const pick = followUp.options.find((o) => o.value === followUp.default);
      if (pick) {
        const next = await buildReport(
          reports,
          mergeIntent(intent, pick.apply),
          text,
          followUp,
        );
        return { ...next, text: `I went with ${pick.label}. ${next.text}` };
      }
    }
    const question = reportQuestion(followUp, `report-${++questions}`);
    pending = { intent, followUp, question, text };
    return { added: [], ref: question, text: followUp.prompt };
  }

  /** The option a form submission or a typed answer picked. */
  function pickedOption(
    followUp: ReportFollowUp,
    values: AssistantQuestionAnswer,
  ): ReportFollowUpOption | undefined {
    const chosen = values[followUp.field];
    const value = Array.isArray(chosen) ? chosen[0] : chosen;
    return followUp.options.find((o) => o.value === value);
  }

  /** Continue a pending report with a picked option, with no model turn. */
  async function answerPending(
    reports: PlannerReports,
    option: ReportFollowUpOption,
    reply = '',
  ): Promise<{ content: string; refs?: unknown }> {
    const current = pending;
    if (!current) return { content: '' };
    const built = await buildReport(
      reports,
      mergeIntent(current.intent, option.apply),
      `${current.text} ${reply}`.trim(),
      current.followUp,
    );
    const content = [
      describeChange(
        { added: built.added, removed: [], kept: [] },
        options.recipes,
      ),
      built.text,
    ]
      .filter(Boolean)
      .join(' ');
    if (content) options.onReply?.(content);
    return { content, refs: built.ref };
  }

  const reportsHost = () =>
    options.recipes.some((r) => r.id === REPORTS_RECIPE)
      ? (options.reports?.() ?? null)
      : null;

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
    // A typed answer to the pending report question resolves against its
    // options in code: no model turn, and "the date month" means the date by
    // month whatever the model would have made of it.
    const pendingReports = pending ? reportsHost() : null;
    if (pending && pendingReports) {
      const option = directAnswer(pending.followUp, pending.question, text);
      // The reply's own time words ("status last month") still count.
      if (option) return answerPending(pendingReports, option, text);
    }
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
      const menu = options.menu?.() ?? [];
      // `reports.runtime.sources`: what a report may cover in this app.
      const reports = reportsHost();
      const reportSources = reports?.sources() ?? [];
      const asked = pending;
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
              menu,
              reportSources.map(({ id, label }) => ({ id, label })),
              asked
                ? {
                    source: asked.intent.source,
                    prompt: asked.followUp.prompt,
                    options: asked.followUp.options.map((o) => o.label),
                  }
                : undefined,
            ),
          },
          ...prior,
        ],
        responseSchema: buildResponseSchema(
          options.recipes,
          cookbooks,
          !!options.settings,
          !!options.theme,
          menu.map((section) => section.id),
          reportSources.map((source) => source.id),
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
        sections: menu.map((section) => section.id),
        reports: reportSources.length > 0,
      });
      // A report turn is driven by code, not by the model's other choices: a
      // report is never a recipe to add or a section to open ("sales report"
      // must not land in the product catalogue). Settings and theme still apply.
      if (change.report) {
        change.add = [];
        change.remove = [];
        delete change.open;
      }
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
      // A request for a report or a summary of the data (the keyword match
      // finds reports.runtime) goes to Reports or nowhere: an `open` of any
      // other section (the product catalogue, say) is dropped.
      const reportRequest = matches.some(
        (m) => m.kind === 'recipe' && m.id === REPORTS_RECIPE,
      );
      const reportsSection = planner
        .snapshot()
        .sections.find((s) => s.items.some((i) => i.id === REPORTS_ITEM))?.id;
      const open =
        change.open && (!reportRequest || change.open === reportsSection)
          ? change.open
          : undefined;
      const openText = open ? openSection(planner, open, menu) : '';
      // `reports.runtime.define` (preview) then `reports.runtime.run`, by code
      // (`buildReport`). An answer to a pending follow-up merges into its
      // intent; a turn that answers nothing takes the sensible default rather
      // than asking the same question again.
      let reportText = '';
      let reportRef: unknown;
      let reportIntent: ReportIntent | null = null;
      let reportWords = text;
      if (asked && change.report) {
        reportIntent = mergeIntent(asked.intent, change.report);
        reportWords = `${asked.text} ${text}`;
      } else if (change.report) {
        reportIntent = change.report;
      }
      const didOther =
        applied.added.length > 0 ||
        applied.removed.length > 0 ||
        !!settingsText ||
        !!themed?.summary ||
        !!commandText ||
        !!openText ||
        !!change.cookbook;
      if (reports && reportIntent) {
        const built = await buildReport(
          reports,
          reportIntent,
          reportWords,
          asked?.followUp ?? null,
        );
        applied.added.push(...built.added);
        reportText = built.text;
        reportRef = built.ref;
      } else if (reports && asked && !didOther) {
        // A second miss: never the identical question again.
        const pick = asked.followUp.options.find(
          (o) => o.value === asked.followUp.default,
        );
        if (pick) {
          const built = await buildReport(
            reports,
            mergeIntent(asked.intent, pick.apply),
            asked.text,
            asked.followUp,
          );
          applied.added.push(...built.added);
          reportText = `I went with ${pick.label}. ${built.text}`;
          reportRef = built.ref;
        }
      } else if (asked) {
        // The person moved on to something else.
        pending = null;
      }
      const ran = [
        describeChange(applied, options.recipes),
        settingsText,
        themed?.summary ?? '',
        commandText,
        openText,
      ]
        .filter(Boolean)
        .join(' ');
      // The model adding Reports is a report request too, whatever the words.
      const askedForReport =
        reportRequest || applied.added.includes(REPORTS_RECIPE);
      if (
        askedForReport &&
        !change.report &&
        !asked &&
        !openText &&
        !applied.removed.length
      ) {
        // Asked for a report but named nothing to build (adding Reports alone
        // builds nothing): ask which records, never guess, or say this planner
        // cannot build one. Going to the Reports section needs no question.
        const followUp = reports ? sourceFollowUp(reportSources) : null;
        if (followUp) {
          const question = reportQuestion(followUp, `report-${++questions}`);
          pending = { intent: { source: '' }, followUp, question, text };
          reportText = followUp.prompt;
          reportRef = question;
        } else {
          reportText = reports
            ? whichSourceQuestion(reportSources)
            : REPORTS_UNAVAILABLE;
        }
      }
      const summary = [ran, reportText].filter(Boolean).join(' ');
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
      const reply = honestReply(line, summary, !!offer);
      if (reply) options.onReply?.(reply);
      // One ref renders as is; several in one turn (a cookbook offer, a theme
      // Undo, a report preview) ride together.
      const all = [offer, undo, reportRef].filter(Boolean);
      const refs = all.length > 1 ? all : all[0];
      return { content: reply, refs };
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
    /**
     * The report follow-up's form, submitted: its pick merges into the
     * pending intent and the flow continues (preview, then confirmation) with
     * no model turn. The question is marked answered for the transcript.
     */
    async answerQuestion(
      input: AssistantAnswerQuestionInput,
    ): Promise<AssistantSendMessageResult> {
      const cached = seen.get(input.clientRequestId);
      if (cached) return cached;
      const reports = reportsHost();
      if (!pending || !reports || pending.question.id !== input.questionId) {
        throw new Error('That question is no longer open. Ask again?');
      }
      const values = validateAssistantQuestionAnswer(
        pending.question,
        input.values,
      );
      const option = values
        ? pickedOption(pending.followUp, values)
        : undefined;
      if (!values || !option) throw new Error('Choose one of the options.');
      const asked = messages.find((m) => m.id === input.messageId);
      if (asked) {
        const mark = (ref: unknown) => {
          const item = ref as { kind?: string; id?: string } | null;
          return item?.kind === ASSISTANT_QUESTION_KIND &&
            item.id === input.questionId
            ? { ...item, answer: values }
            : ref;
        };
        asked.toolCallData = Array.isArray(asked.toolCallData)
          ? asked.toolCallData.map(mark)
          : mark(asked.toolCallData);
      }
      const reply = await answerPending(reports, option);
      const result: AssistantSendMessageResult = {
        inProgress: false,
        ...(asked ? { messages: [asked] } : {}),
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
    recordReportOutcome(specHash: string, outcome: unknown) {
      for (const message of messages) {
        const refs = Array.isArray(message.toolCallData)
          ? message.toolCallData
          : [message.toolCallData];
        for (const ref of refs) {
          const item = ref as {
            name?: string;
            result?: { specHash?: string };
            outcome?: unknown;
          } | null;
          if (
            item?.name === REPORT_DEFINE_TOOL &&
            item.result?.specHash === specHash
          ) {
            item.outcome = outcome;
          }
        }
      }
    },
    async uploadAttachment(file: File) {
      throw new Error(`The assistant cannot take attachments (${file.name}).`);
    },
    abort() {
      controller?.abort();
    },
  };
}
