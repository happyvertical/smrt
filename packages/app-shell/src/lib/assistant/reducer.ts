// The dock's state as a pure reducer: the thread, the streaming reply,
// tool-call chips and approval cards. No DOM, no fetch.

import {
  plainStep,
  type SummaryDefinition,
  versionSummary,
} from '../ui/command-summary.ts';
import { humanize, singularLabel } from '../ui/fields.ts';
import type {
  AssistantStatus,
  ThreadMessage,
  TurnEvent,
  TurnStop,
} from './events.ts';
import {
  reportLink,
  reportPresentation,
  shownSummary,
} from './tool-summary.ts';

export type ApprovalState =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'failed'
  | 'timeout';

export type Item =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; streaming: boolean }
  | {
      kind: 'tool';
      copy?: 'live' | 'draft';
      id: string;
      name: string;
      state: 'running' | 'ok' | 'error';
      summary: string;
      report?: ReturnType<typeof reportPresentation>;
      reportHref?: string;
    }
  | {
      kind: 'approval';
      id: string;
      approvalId: string;
      summary: string;
      preview: unknown;
      state: ApprovalState;
      busy: boolean;
      message: string;
      /** Left over from an earlier turn (the turn that asked is gone). */
      detached: boolean;
    }
  /** The "N changes waiting" block: its numbers come from the live changes state. */
  | { kind: 'changes'; id: string }
  | {
      kind: 'note';
      id: string;
      tone: 'error' | 'info';
      text: string;
      /** A fix for the problem ("Sign in again"), when there is one. */
      action?: { label: string; href: string };
    };

export interface DockState {
  threadId: string | null;
  items: Item[];
  running: boolean;
  stop: TurnStop | null;
  /** `unknown` until the first status answer. */
  availability: 'unknown' | 'ready' | 'unavailable';
  unavailableMessage: string;
  /** Where to fix an unavailable assistant (a link in the dock), if anywhere. */
  unavailableAction: { label: string; href: string } | null;
  /** Plain-text name of the engine in effect, for the dock's caption. */
  engineLabel: string;
  seq: number;
}

export const initialState: DockState = {
  threadId: null,
  items: [],
  running: false,
  stop: null,
  availability: 'unknown',
  unavailableMessage: '',
  unavailableAction: null,
  engineLabel: '',
  seq: 0,
};

export type Action =
  | { type: 'status'; status: AssistantStatus }
  | { type: 'send'; text: string }
  | { type: 'event'; event: TurnEvent }
  | { type: 'loaded'; threadId: string; messages: ThreadMessage[] }
  | { type: 'reset' }
  | {
      type: 'pending_approvals';
      approvals: { id: string; summary: string; preview: unknown }[];
    }
  | { type: 'approval_busy'; approvalId: string; busy: boolean }
  | {
      type: 'approval_result';
      approvalId: string;
      state: ApprovalState | null;
      message: string;
    }
  | { type: 'note'; tone: 'error' | 'info'; text: string }
  | {
      type: 'unavailable';
      message: string;
      action?: { label: string; href: string };
    }
  | { type: 'ended' };

const next = (s: DockState, prefix: string) => `${prefix}${s.seq + 1}`;

function closeStreaming(items: Item[]): Item[] {
  return items.map((i) =>
    i.kind === 'assistant' && i.streaming ? { ...i, streaming: false } : i,
  );
}

function patch(
  items: Item[],
  match: (i: Item) => boolean,
  change: (i: Item) => Item,
): Item[] {
  return items.map((i) => (match(i) ? change(i) : i));
}

export function reduce(state: DockState, action: Action): DockState {
  switch (action.type) {
    case 'status':
      return action.status.configured
        ? {
            ...state,
            availability: 'ready',
            unavailableMessage: '',
            unavailableAction: null,
            engineLabel: action.status.engineLabel ?? '',
          }
        : {
            ...state,
            availability: 'unavailable',
            unavailableMessage:
              action.status.message ?? 'The assistant is not available.',
            unavailableAction: action.status.action ?? null,
            // Never claim an engine is "in use" when it cannot answer.
            engineLabel: '',
          };
    case 'unavailable':
      return {
        ...state,
        running: false,
        availability: 'unavailable',
        unavailableMessage: action.message,
        unavailableAction: action.action ?? state.unavailableAction,
        items: state.items.filter(
          (i) => !(i.kind === 'user' && i.id === `u${state.seq}`),
        ),
      };
    case 'send':
      return {
        ...state,
        running: true,
        stop: null,
        seq: state.seq + 1,
        items: [
          ...closeStreaming(state.items),
          { kind: 'user', id: `u${state.seq + 1}`, text: action.text },
        ],
      };
    case 'reset':
      return {
        ...initialState,
        availability: state.availability,
        unavailableMessage: state.unavailableMessage,
        unavailableAction: state.unavailableAction,
        engineLabel: state.engineLabel,
        seq: state.seq,
      };
    case 'ended':
      return {
        ...state,
        running: false,
        items: closeStreaming(state.items),
      };
    case 'note':
      return {
        ...state,
        seq: state.seq + 1,
        items: [
          ...state.items,
          {
            kind: 'note',
            id: next(state, 'n'),
            tone: action.tone,
            text: action.text,
          },
        ],
      };
    case 'loaded': {
      let seq = state.seq;
      const items: Item[] = [];
      for (const m of action.messages) {
        seq += 1;
        if (m.role === 'user')
          items.push({ kind: 'user', id: `m${seq}`, text: m.content });
        else if (m.block === 'changes')
          items.push({ kind: 'changes', id: `m${seq}` });
        else if (m.role === 'assistant')
          items.push({
            kind: 'assistant',
            id: `m${seq}`,
            text: m.content,
            streaming: false,
          });
        else if (m.tool)
          items.push({
            kind: 'tool',
            id: `m${seq}`,
            name: m.tool.name,
            state: m.tool.ok ? 'ok' : 'error',
            summary: shownSummary(m.tool.name, m.tool.summary, m.tool.ok),
            ...(reportLink(m.tool.reportHref)
              ? { reportHref: reportLink(m.tool.reportHref) }
              : {}),
            ...(m.tool.copy ? { copy: m.tool.copy } : {}),
          });
      }
      return {
        ...state,
        threadId: action.threadId,
        items,
        seq,
        running: false,
        stop: null,
      };
    }
    case 'pending_approvals': {
      const have = new Set(
        state.items.flatMap((i) =>
          i.kind === 'approval' ? [i.approvalId] : [],
        ),
      );
      let seq = state.seq;
      const added: Item[] = [];
      for (const a of action.approvals) {
        if (have.has(a.id)) continue;
        seq += 1;
        added.push({
          kind: 'approval',
          id: `a${seq}`,
          approvalId: a.id,
          summary: a.summary,
          preview: a.preview,
          state: 'pending',
          busy: false,
          message: '',
          detached: true,
        });
      }
      return added.length
        ? { ...state, seq, items: [...state.items, ...added] }
        : state;
    }
    case 'approval_busy':
      return {
        ...state,
        items: patch(
          state.items,
          (i) => i.kind === 'approval' && i.approvalId === action.approvalId,
          (i) => ({
            ...(i as Extract<Item, { kind: 'approval' }>),
            busy: action.busy,
            message: '',
          }),
        ),
      };
    case 'approval_result':
      return {
        ...state,
        items: patch(
          state.items,
          (i) => i.kind === 'approval' && i.approvalId === action.approvalId,
          (i) => {
            const a = i as Extract<Item, { kind: 'approval' }>;
            return {
              ...a,
              busy: false,
              message: action.message,
              state: action.state ?? a.state,
            };
          },
        ),
      };
    case 'event':
      return onEvent(state, action.event);
  }
}

function onEvent(state: DockState, e: TurnEvent): DockState {
  switch (e.type) {
    case 'thread':
      return { ...state, threadId: e.threadId };
    case 'changes_block':
      return {
        ...state,
        seq: state.seq + 1,
        items: [
          ...closeStreaming(state.items),
          { kind: 'changes', id: next(state, 'c') },
        ],
      };
    case 'text': {
      const last = state.items.at(-1);
      if (last?.kind === 'assistant' && last.streaming)
        return {
          ...state,
          items: [
            ...state.items.slice(0, -1),
            { ...last, text: last.text + e.delta },
          ],
        };
      return {
        ...state,
        seq: state.seq + 1,
        items: [
          ...state.items,
          {
            kind: 'assistant',
            id: next(state, 'r'),
            text: e.delta,
            streaming: true,
          },
        ],
      };
    }
    case 'tool_call':
      return {
        ...state,
        seq: state.seq + 1,
        items: [
          ...closeStreaming(state.items),
          {
            kind: 'tool',
            id: `t:${e.id}`,
            name: e.name,
            state: 'running',
            summary: '',
          },
        ],
      };
    case 'tool_result':
      return {
        ...state,
        items: patch(
          state.items,
          (i) => i.kind === 'tool' && i.id === `t:${e.id}`,
          (i) => ({
            ...(i as Extract<Item, { kind: 'tool' }>),
            state: e.ok ? 'ok' : 'error',
            summary: shownSummary(e.name, e.summary, e.ok),
            ...(e.report && reportPresentation(e.name, e.report.result, e.ok)
              ? {
                  report: {
                    result: e.report.result,
                    href: reportLink(e.report.href),
                  },
                }
              : {}),
            ...(e.copy ? { copy: e.copy } : {}),
          }),
        ),
      };
    case 'approval_required':
      return {
        ...state,
        seq: state.seq + 1,
        items: [
          ...closeStreaming(state.items).filter(
            (i) => !(i.kind === 'approval' && i.approvalId === e.approvalId),
          ),
          {
            kind: 'approval',
            id: `a:${e.id}`,
            approvalId: e.approvalId,
            summary: e.summary,
            preview: e.preview,
            state: 'pending',
            busy: false,
            message: '',
            detached: false,
          },
        ],
      };
    case 'approval_decided':
      return {
        ...state,
        items: patch(
          state.items,
          (i) => i.kind === 'approval' && i.approvalId === e.approvalId,
          (i) => ({
            ...(i as Extract<Item, { kind: 'approval' }>),
            state: e.status,
            busy: false,
            message: '',
          }),
        ),
      };
    case 'error':
      return {
        ...state,
        seq: state.seq + 1,
        items: [
          ...closeStreaming(state.items),
          {
            kind: 'note',
            id: next(state, 'n'),
            tone: 'error',
            text: e.message,
            ...(e.action ? { action: e.action } : {}),
          },
        ],
      };
    case 'done':
      return {
        ...state,
        running: false,
        stop: e.stop,
        items: closeStreaming(state.items),
      };
  }
}

const TOOL_LABELS: Record<string, string> = {
  app_definereport: 'Making a report',
  app_renamereport: 'Renaming a report',
  app_removereport: 'Removing a report',
  app_runreport: 'Running a report',
  app_describe: 'Looking at your app',
  app_history: 'Checking recent changes',
  approval_pending: 'Checking what needs your approval',
  app_setcalculation: 'Setting up a calculated field',
  app_loadrecords: 'Loading records',
  app_extractmodel: 'Splitting out linked records',
  app_mergerecords: 'Merging records',
};

/** A short label for a tool chip: `chore_create` -> `Chore create`. */
export function toolLabel(name: string): string {
  if (TOOL_LABELS[name]) return TOOL_LABELS[name];
  const words = name.replace(/^app_/, '').replace(/[_-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : name;
}

/** What a step is in plain words; a tool nobody wrote words for shows no internal name. */
export function stepLabel(name: string): string {
  return TOOL_LABELS[name] ?? 'Working on it';
}

/** What to tell the person when a turn ended early. */
export function stopNote(stop: TurnStop | null): string {
  switch (stop) {
    case 'max_steps':
    case 'max_tokens':
      return 'I stopped to keep things short. Ask me to continue if you want more.';
    case 'timeout':
      return 'That took too long, so I stopped.';
    case 'waiting':
      return 'Waiting for your decision. Nothing has changed yet.';
    case 'aborted':
      return 'Stopped.';
    default:
      return '';
  }
}

/**
 * What the screen-reader live region says. Never the reply itself: the reply
 * is already in the log, and repeating its text there made every answer appear
 * twice (once in the log, once in the hidden live region) to text extraction
 * and to a screen reader.
 */
export function announcement(state: DockState): string {
  if (state.running) return 'The assistant is working.';
  return state.items.at(-1)?.kind === 'assistant'
    ? 'The assistant replied.'
    : '';
}

type ToolItem = Extract<Item, { kind: 'tool' }>;
export type ViewItem = Item | (ToolItem & { failures: number });

/**
 * Consecutive failed tool cards (retries) collapse into one card that keeps
 * the newest plain reason and counts the attempts.
 */
export function collapseFailures(items: Item[]): ViewItem[] {
  const out: ViewItem[] = [];
  for (const item of items) {
    const prev = out.at(-1);
    if (item.kind === 'tool' && item.state === 'error') {
      if (prev?.kind === 'tool' && prev.state === 'error') {
        const failures = ('failures' in prev ? prev.failures : 1) + 1;
        out[out.length - 1] = { ...item, id: prev.id, failures };
        continue;
      }
      out.push({ ...item, failures: 1 });
      continue;
    }
    out.push(item);
  }
  return out;
}

/** The visible working line, from send until the reply finishes. */
export function workingStep(state: DockState): string {
  if (!state.running) return '';
  const last = state.items.at(-1);
  if (last?.kind === 'tool' && last.state === 'running')
    return stepLabel(last.name);
  if (last?.kind === 'approval' && last.state === 'pending')
    return 'Waiting for your decision';
  if (last?.kind === 'assistant' && last.streaming) return 'Writing a reply';
  return 'Thinking';
}

/** The newest assistant reply: it always shows in full. */
export function newestReplyId(items: Item[]): string | undefined {
  return items.findLast((i) => i.kind === 'assistant')?.id;
}

/** Lines of a reply that stay visible when an older one is folded. */
const FOLD_LINES = 7;
/** Roughly one line of the 400px column. */
const LINE_CHARS = 44;

/**
 * Whether an older reply is long enough to fold to "Show more": taller than
 * about seven lines (counted from the text, as the DOM has no height to ask
 * while it renders).
 */
export function foldsReply(text: string): boolean {
  let lines = 0;
  for (const line of text.split('\n'))
    lines += Math.max(1, Math.ceil(line.length / LINE_CHARS));
  return lines > FOLD_LINES;
}

export interface StepRow {
  id: string;
  /** Plain words: what was done, or why it did not work. */
  label: string;
  state: 'running' | 'ok' | 'error';
  failures: number;
  /** What the assistant said between steps (not a step): no tick, kept in order. */
  narration?: boolean;
}

/** A turn's tool steps as one quiet line that opens to the list. */
export interface StepsView {
  kind: 'steps';
  id: string;
  rows: StepRow[];
  /** The one line: the step in progress, or up to two finished phrases. */
  line: string;
  /** The turn's last step did not work: red, opens itself, offers Try again. */
  failed: boolean;
  /** The turn is still running (the line shows the step in progress). */
  live: boolean;
  /** What was asked, to send again. */
  retry: string;
}

/** A report a step produced, shown after the reply text. */
export interface ReportView {
  kind: 'report';
  id: string;
  report?: ToolItem['report'];
  href?: string;
}

export type TurnView = Exclude<Item, { kind: 'tool' }> | StepsView | ReportView;

const PHRASES_SHOWN = 2;

/** The app's models and fields, as the changes cards read them (the layout's description). */
export type StepDefinition = SummaryDefinition;

const squash = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
const lowerFirst = (text: string) =>
  /^[A-Z][a-z]/.test(text)
    ? text.charAt(0).toLowerCase() + text.slice(1)
    : text;
const upperFirst = (text: string) =>
  text.charAt(0).toUpperCase() + text.slice(1);

function pluralNoun(word: string): string {
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(?:s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  return `${word}s`;
}

const RECORD_WRITE =
  /^([a-z][a-z\d]*(?:[._-][a-z][a-z\d]*)*)[._-](create|update|delete|remove)$/i;
const RECORD_VERB = {
  create: 'Added',
  update: 'Updated',
  delete: 'Deleted',
  remove: 'Deleted',
} as const;

/** A record tool (`customer_create`) as what it did and to which model. */
function recordWrite(name: string, def: StepDefinition) {
  const match = name.startsWith('app_') ? null : RECORD_WRITE.exec(name);
  if (!match) return;
  const key = match[1];
  const wanted = squash(key);
  const found = Object.entries(def.models).find(
    ([model, info]) => info?.label && squash(model) === wanted,
  );
  const label = found?.[1].label?.trim();
  // The model's label is its plural ("Orders"); its singular comes from the
  // same label. A label that does not look plural, or a key with no label,
  // gets a regular plural only for the many form.
  const one = label
    ? singularLabel(label)
    : humanize(key.replace(/[._-]/g, ' '));
  const many = label && label !== one ? label : pluralNoun(one);
  return {
    verb: RECORD_VERB[match[2].toLowerCase() as keyof typeof RECORD_VERB],
    one: lowerFirst(one),
    many: lowerFirst(many),
    key: `${match[2].toLowerCase() === 'remove' ? 'delete' : match[2].toLowerCase()}:${wanted}`,
  };
}

/**
 * A structural step ("add Order.priority", "enable profiles") in the changes
 * cards' words (versionSummary / commandSummary), in the past tense. Anything
 * that is not engine grammar keeps its own words.
 */
function structuralPhrase(summary: string, def: StepDefinition): string {
  const card = versionSummary(summary, def, def);
  if (card === 'Change your app') return summary;
  return plainStep(card, 'past');
}

function stepRow(
  item: ViewItem & { kind: 'tool' },
  def: StepDefinition,
): StepRow {
  const failures = 'failures' in item ? item.failures : 1;
  const label =
    item.state === 'running'
      ? stepLabel(item.name)
      : item.state === 'ok' && item.summary
        ? structuralPhrase(item.summary, def)
        : item.summary ||
          (item.state === 'ok' ? stepLabel(item.name) : 'This did not work.');
  return { id: item.id, label: upperFirst(label), state: item.state, failures };
}

/**
 * The step rows: finished record writes ("customer_create" four times) are
 * ONE row in plain words from the model's label ("Added 4 customers"); the
 * narration between steps keeps its place as a row without a tick.
 */
function stepRows(items: ViewItem[], def: StepDefinition): StepRow[] {
  const rows: StepRow[] = [];
  const groups = new Map<string, { row: StepRow; n: number }>();
  for (const item of items) {
    if (item.kind === 'assistant') {
      rows.push({
        id: item.id,
        label: item.text.trim(),
        state: 'ok',
        failures: 1,
        narration: true,
      });
      continue;
    }
    if (item.kind !== 'tool') continue;
    const write = item.state === 'ok' ? recordWrite(item.name, def) : undefined;
    if (!write) {
      rows.push(stepRow(item, def));
      continue;
    }
    const group = groups.get(write.key);
    if (group) {
      group.n += 1;
      group.row.label = recordPhrase(write, group.n);
      continue;
    }
    const row: StepRow = {
      id: item.id,
      label: recordPhrase(write, 1),
      state: 'ok',
      failures: 1,
    };
    groups.set(write.key, { row, n: 1 });
    rows.push(row);
  }
  return rows;
}

function recordPhrase(
  write: NonNullable<ReturnType<typeof recordWrite>>,
  n: number,
) {
  return `${write.verb} ${n} ${n === 1 ? write.one : write.many}`;
}

/** Sentence case: the line starts with a capital, later phrases do not. */
function stepsLine(rows: StepRow[], failed: boolean): string {
  if (failed) return "Something didn't work";
  const done = [
    ...new Set(
      rows.filter((r) => r.state === 'ok' && !r.narration).map((r) => r.label),
    ),
  ];
  if (done.length === 0) return 'Working on it';
  const shown = done
    .slice(0, PHRASES_SHOWN)
    .map((label, i) => (i === 0 ? upperFirst(label) : lowerFirst(label)))
    .join(' · ');
  const more = done.length - PHRASES_SHOWN;
  return more > 0 ? `${shown} and ${more} more` : shown;
}

/**
 * The thread as the panel draws it: each turn's (the stretch after one of the
 * owner's messages) tool steps fold into ONE line before the reply, and a
 * report a step made moves after the reply text. Works on a reopened thread
 * the same as on a live one.
 */
export function groupTurns(
  state: DockState,
  definition: StepDefinition = { models: {} },
): TurnView[] {
  const items = collapseFailures(state.items);
  const out: TurnView[] = [];
  let start = 0;
  while (start < items.length) {
    let end = start + 1;
    while (end < items.length && items[end].kind !== 'user') end += 1;
    const turn = items.slice(start, end);
    start = end;
    const tools = turn.filter(
      (i): i is ViewItem & { kind: 'tool' } => i.kind === 'tool',
    );
    if (tools.length === 0) {
      out.push(...(turn as TurnView[]));
      continue;
    }
    // One reply per turn: the final text. Earlier chunks (the engine
    // narrating between tool calls) move into the steps list.
    const replies = turn.filter((i) => i.kind === 'assistant');
    const finalReply = replies.at(-1);
    const rows = stepRows(
      turn.filter(
        (i) =>
          i.kind === 'tool' || (i.kind === 'assistant' && i !== finalReply),
      ),
      definition,
    );
    const failed = rows.findLast((r) => !r.narration)?.state === 'error';
    const live = state.running && end === items.length;
    const asked = turn[0].kind === 'user' ? turn[0].text : '';
    const steps: StepsView = {
      kind: 'steps',
      id: tools[0].id,
      rows,
      live,
      failed: failed && !live,
      line: live ? `${workingStep(state)}…` : stepsLine(rows, failed),
      retry: asked,
    };
    const reports: ReportView[] = tools.flatMap((t) =>
      t.report || t.reportHref
        ? [
            {
              kind: 'report' as const,
              id: `${t.id}:report`,
              ...(t.report ? { report: t.report } : {}),
              ...(t.reportHref ? { href: t.reportHref } : {}),
            },
          ]
        : [],
    );
    const rest = turn.filter(
      (i) => i.kind !== 'tool' && !(i.kind === 'assistant' && i !== finalReply),
    ) as TurnView[];
    const lastReply = rest.findLastIndex((i) => i.kind === 'assistant');
    const at = lastReply === -1 ? rest.length : lastReply + 1;
    const first = rest[0]?.kind === 'user' ? 1 : 0;
    out.push(
      ...rest.slice(0, first),
      steps,
      ...rest.slice(first, at),
      ...reports,
      ...rest.slice(at),
    );
  }
  return out;
}
