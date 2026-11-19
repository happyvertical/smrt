// Changes waiting (#5178), browser side: the JSON client for
// `/api/shell/changes*` and the pure rules the header pill, the changes view
// and History read. Shapes live in `types.ts`; the routes' headers
// (`routes/api/shell/changes/**`) are the contract. The server module
// `lib/server/changes.ts` owns the batch; nothing here decides anything.
import { api } from './api.ts';
import type { ChangeCardView, ChangesState } from './types.ts';

/** The working copy's name: History titles an applied batch from it. */
export const CHANGES_WAITING_NAME = 'Changes waiting';

/** The summary the owner's Apply approval is recorded with (and recognized by). */
export function applySummary(count: number): string {
  return `Apply ${count} waiting change${count === 1 ? '' : 's'}`;
}

/** The owner's own Apply already says "Applied"; its approval is not announced again. */
export function isApplySummary(summary: string): boolean {
  return /^Apply \d+ waiting changes?$/.test(summary);
}

export const plural = (count: number, word: string): string =>
  `${count} ${word}${count === 1 ? '' : 's'}`;

// ---------- the client ----------

type Write = { generation?: number };
const call = <T>(path: string, method: string, body?: unknown) =>
  api<T>(`/api/shell/changes${path}`, { method, body, target: null });

export interface QuickEdit {
  label?: string;
  choices?: string[];
  /** Which field of a "new table" change. */
  field?: string;
}

export const changesApi = {
  get: () => call<ChangesState>('', 'GET'),
  removeCard: (id: string, w: Write = {}) =>
    call<ChangesState>(`/cards/${encodeURIComponent(id)}/remove`, 'POST', w),
  restoreCard: (id: string, w: Write = {}) =>
    call<ChangesState>(`/cards/${encodeURIComponent(id)}/restore`, 'POST', w),
  editCard: (id: string, edit: QuickEdit, w: Write = {}) =>
    call<ChangesState>(`/cards/${encodeURIComponent(id)}`, 'PATCH', {
      ...edit,
      ...w,
    }),
  /** `expect` is the digest of the state the owner reviewed (409: review again). */
  apply: (expect: string, w: Write = {}, source?: 'chat') =>
    call<{ id: string; status: string }>('/apply', 'POST', {
      expect,
      ...w,
      ...(source ? { source } : {}),
    }),
  /** Comment on one change: the assistant revises that card (never applies). */
  comment: (id: string, text: string) =>
    call<ChangesState>(`/cards/${encodeURIComponent(id)}/comment`, 'POST', {
      text,
    }),
  /** Click a choice of a review question (`choice` is its index). */
  answer: (questionId: string, choice: number, w: Write = {}) =>
    call<ChangesState>(
      `/questions/${encodeURIComponent(questionId)}/answer`,
      'POST',
      { choice, ...w },
    ),
  /** "Remove those too": the flagged change and every other that needs the same removed one. */
  removeDependents: (id: string, w: Write = {}) =>
    call<ChangesState>(
      `/cards/${encodeURIComponent(id)}/remove-dependents`,
      'POST',
      w,
    ),
  discard: (w: Write = {}) => call<ChangesState>('/discard', 'POST', w),
  /** "Put them back" after a discard. */
  restoreDiscarded: (w: Write = {}) =>
    call<ChangesState>('/restore', 'POST', w),
  /** `expect` is `lastApplied.undoDigest`. */
  undo: (batchId: string, expect: string) =>
    call<{ batchId: string; version: number; summary: string }>(
      '/undo',
      'POST',
      { batchId, expect },
    ),
};

// ---------- the header pill ----------

export type PillState = 'ready' | 'checking' | 'blocked';

export interface PillPlan {
  count: number;
  state: PillState;
  /** "changes waiting" beside the count chip (wide screens). */
  long: string;
  /** "waiting" beside the count chip (phones, under 480px). */
  short: string;
  /** Screen readers hear one stable sentence whatever the width. */
  label: string;
}

/** Null when nothing waits: then there is no pill and no bar at all. */
export function planPill(
  changes: ChangesState | null | undefined,
): PillPlan | null {
  if (!changes || changes.count <= 0) return null;
  const count = changes.count;
  const state: PillState =
    changes.checkState === 'blocked' || changes.blockers.length
      ? 'blocked'
      : changes.checkState === 'stale' || changes.checkState === 'checking'
        ? 'checking'
        : 'ready';
  const waiting = `${plural(count, 'change')} waiting`;
  return {
    count,
    state,
    // The count rides in the pill's own number chip, except while checking.
    long:
      state === 'blocked'
        ? `${waiting} · needs a look`
        : state === 'checking'
          ? waiting
          : `${count === 1 ? 'change' : 'changes'} waiting`,
    short:
      state === 'blocked'
        ? 'Needs a look'
        : state === 'checking'
          ? `${count} waiting`
          : 'waiting',
    label:
      state === 'blocked'
        ? `${waiting}. Needs a look. Review.`
        : state === 'checking'
          ? `${waiting}. Checking. Review.`
          : `${waiting}. Review.`,
  };
}

// ---------- cards ----------

export type CardKind = 'table' | 'field' | 'data' | 'report' | 'other';

const KIND: Record<string, CardKind> = {
  defineModel: 'table',
  removeModel: 'table',
  addField: 'field',
  renameField: 'field',
  removeField: 'field',
  hideField: 'field',
  changeFieldType: 'field',
  setCalculation: 'field',
  loadRecords: 'data',
  mergeRecords: 'data',
  extractModel: 'data',
  defineReport: 'report',
  renameReport: 'report',
  removeReport: 'report',
};

export function cardKind(card: ChangeCardView): CardKind {
  const type = card.commands[0]?.type;
  return (typeof type === 'string' && KIND[type]) || 'other';
}

export interface QuickEditField {
  /** `field` of the PATCH (a "new table" change names one of its fields). */
  field?: string;
  /** What the choice list is called on screen. */
  name: string;
  choices: string[];
}

export interface QuickEditPlan {
  /** The current name (label) of the new thing, or null when it has none to edit. */
  label: string | null;
  labelName: string;
  fields: QuickEditField[];
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null;

/**
 * What Quick edit offers for a card, or null when the server would refuse it:
 * one command of a whitelisted kind, never an adopted (opaque) change. Mirrors
 * `patchCommand` in `lib/server/changes.ts`. No default is offered (slice 2).
 */
export function planQuickEdit(card: ChangeCardView): QuickEditPlan | null {
  if (card.status !== 'active' || card.opaque || !card.editable) return null;
  // An imported table is its definition plus its loads: only the definition is edited.
  if (
    card.commands.length !== 1 &&
    !(card.source === 'import' && card.commands[0]?.type === 'defineModel')
  )
    return null;
  const command = card.commands[0];
  const choicesOf = (def: unknown): string[] | null => {
    const d = def as { type?: unknown; choices?: unknown } | null;
    return d?.type === 'choice' &&
      Array.isArray(d.choices) &&
      d.choices.every((c) => typeof c === 'string')
      ? (d.choices as string[])
      : null;
  };
  if (command.type === 'addField' || command.type === 'changeFieldType') {
    const def = (
      command.type === 'addField' ? command.definition : command.to
    ) as { label?: unknown } | undefined;
    const name = text(def?.label) ?? text(command.field) ?? '';
    const choices = choicesOf(def);
    return {
      label: name,
      labelName: 'Name',
      fields: choices ? [{ name: 'Choices', choices }] : [],
    };
  }
  if (command.type === 'defineModel') {
    const fields = Object.entries(
      (command.fields ?? {}) as Record<string, unknown>,
    ).flatMap(([field, def]) => {
      const choices = choicesOf(def);
      const label = text((def as { label?: unknown }).label) ?? field;
      return choices ? [{ field, name: `${label} choices`, choices }] : [];
    });
    return {
      label: text(command.label) ?? text(command.name) ?? '',
      labelName: 'Name',
      fields,
    };
  }
  return null;
}

/** The PATCH bodies a Quick edit save needs, one per changed piece (none when nothing changed). */
export function quickEditCalls(
  plan: QuickEditPlan,
  next: { label: string; choices: string[][] },
): QuickEdit[] {
  const calls: QuickEdit[] = [];
  const addField = plan.fields.length > 0 && plan.fields[0].field === undefined;
  const label = next.label.trim();
  if (plan.label !== null && label && label !== plan.label) {
    // A "new field" change keeps its label and choices in one command; a "new
    // table" change sends the table's name without `field`.
    calls.push({ label });
  }
  plan.fields.forEach((f, i) => {
    const choices = (next.choices[i] ?? f.choices)
      .map((c) => c.trim())
      .filter(Boolean);
    if (JSON.stringify(choices) === JSON.stringify(f.choices)) return;
    calls.push(addField ? { choices } : { field: f.field, choices });
  });
  return calls;
}

/** One line for the screen: what Apply replaces and what Undo can bring back. */
export function overwriteLines(changes: ChangesState): string[] {
  const o = changes.overwrites;
  const replaced = (o?.recordsUpdated ?? 0) + (o?.recordsMerged ?? 0);
  const lines = [
    replaced === 0
      ? 'No existing records are replaced'
      : `${plural(replaced, 'existing record')} replaced`,
  ];
  if (o && (o.archivedValues > 0 || o.archivedTables > 0))
    lines.push(
      `${plural(o.archivedValues, 'value')} kept aside so Undo can bring them back`,
    );
  return lines;
}

/** True while a check is queued or running (Apply waits for it). */
export const isChecking = (changes: ChangesState): boolean =>
  changes.checkState === 'stale' || changes.checkState === 'checking';

/**
 * What a card that needs a removed change offers: "Put it back" (restores the
 * removed change named by `cause`, when known) and "Remove those too".
 */
export function dependencyActions(
  card: ChangeCardView,
): { putBack: string | null } | null {
  const flag = card.checks.find((c) => c.code === 'depends_on_removed');
  if (!flag || card.status !== 'active') return null;
  return { putBack: flag.cause || null };
}

/** Cards in the order they were made. */
export const activeCards = (changes: ChangesState): ChangeCardView[] =>
  changes.cards
    .filter((c) => c.status === 'active')
    .sort((a, b) => a.position - b.position);

export const removedCards = (changes: ChangesState): ChangeCardView[] =>
  changes.cards
    .filter((c) => c.status === 'removed')
    .sort((a, b) => a.position - b.position);

/** What /changes lists: a lone card, or an import's cards under one collapsible header. */
export type CardRow =
  | { kind: 'card'; card: ChangeCardView }
  | { kind: 'group'; id: string; title: string; cards: ChangeCardView[] };

/** The words on a group's header: `import:<id>` is a workbook import. */
export const groupTitle = (group: string): string =>
  group.startsWith('import:') ? 'Imported from your workbook' : 'Changes';

/**
 * Cards in order, with each run of cards sharing a group key collapsed into
 * one row. A card whose group is empty stands alone, so ordinary changes keep
 * their order and look.
 */
export function groupCards(cards: ChangeCardView[]): CardRow[] {
  const rows: CardRow[] = [];
  for (const card of cards) {
    const last = rows[rows.length - 1];
    if (card.group && last?.kind === 'group' && last.id === card.group)
      last.cards.push(card);
    else if (card.group)
      rows.push({
        kind: 'group',
        id: card.group,
        title: groupTitle(card.group),
        cards: [card],
      });
    else rows.push({ kind: 'card', card });
  }
  return rows;
}

/** Why Apply cannot be used right now, in plain words; null when it can. */
export function applyBlock(changes: ChangesState): string | null {
  if (changes.held) return changes.held;
  if (changes.blockers.length) return "Can't apply yet";
  if (changes.checkState === 'stale' || changes.checkState === 'checking')
    return 'Checking your changes…';
  if (!changes.canApply) return 'These changes are not ready to apply yet.';
  return null;
}

/** The note beside a disabled History Undo while changes wait. */
export const undoBlockedNote = (count: number): string =>
  `Apply or discard your ${plural(count, 'waiting change')} first.`;

// ---------- the assistant's reply block ----------

export interface ReplyBlock {
  count: number;
  /** What each change is, plain words (the first few). */
  lines: string[];
  more: number;
  /** Questions still unanswered: Review leads while any are open. */
  questions: number;
  /** `review`: Review is the main button; `apply`: Apply is. */
  lead: 'review' | 'apply';
  /** One small change the owner asked for: the main button reads "Apply now". */
  applyNow: boolean;
  /** Apply is offered (nothing blocks and the check is done). */
  canApply: boolean;
  /** Plain "N changes waiting" for the block's heading and screen readers. */
  label: string;
}

/** Null when nothing waits: the block then shows nothing (no stale status). */
export function planReplyBlock(
  changes: ChangesState | null | undefined,
): ReplyBlock | null {
  if (!changes || changes.count <= 0) return null;
  const active = changes.cards.filter((c) => c.status === 'active');
  const questions = active.reduce(
    (n, c) => n + c.questions.filter((q) => q.state === 'open').length,
    0,
  );
  const lines = active.slice(0, 4).map((c) => c.summary || 'A change');
  return {
    count: changes.count,
    lines,
    more: Math.max(0, active.length - lines.length),
    questions,
    lead: questions > 0 || !changes.canApply ? 'review' : 'apply',
    applyNow: changes.applyNow,
    canApply: changes.canApply,
    label: `${plural(changes.count, 'change')} waiting`,
  };
}

/** The open questions of the whole batch, in card order. */
export const openQuestions = (changes: ChangesState) =>
  changes.cards
    .filter((c) => c.status === 'active')
    .flatMap((c) => c.questions.filter((q) => q.state === 'open'));
