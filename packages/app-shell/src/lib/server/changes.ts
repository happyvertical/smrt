// Changes waiting (#5178): the owner's batch of structural changes.
//
// Every structural command an assistant, tool, REST call or import makes
// becomes a CARD here instead of reaching the live app. The cards are the
// source of truth; the draft copy (drafts.ts, `AppDraft` + a second host) is a
// private working copy derived from the ACTIVE cards by the ChangeEngine
// (engine/change-engine.ts): appending at the tail executes on it directly,
// anything else (remove, put back, quick edit) rebuilds it from live. Live
// structure stays frozen while changes wait; live records keep working.
//
// Nothing here applies anything. `requestApply` only records an `apply-batch`
// Approval pinned to the digest the owner reviewed; the live change happens in
// `applyApproved`, which only approvals.ts calls (it owns the engine's
// `approved` flag) from the owner's own Apply click. `undoOwnBatch` is the
// owner's Undo click. Neither is reachable from a tool, `/mcp` or the assistant
// (`invariants.test.ts`).
import { createHash, randomUUID } from 'node:crypto';
import {
  type AppHost,
  type BatchBlocker,
  type BatchCheck,
  batchDigest,
  type ChangePrincipal,
  type ChangeResult,
  type Command,
  createSqliteChangeEngine,
  EngineError,
  type PublishResult,
  STRUCTURAL_COMMANDS,
} from '../../engine/index.ts';
import { AppDraftCollection } from '../objects/AppDraft.ts';
import {
  type ChangeBatch,
  ChangeBatchCollection,
} from '../objects/ChangeBatch.ts';
import {
  type ChangeCard,
  ChangeCardCollection,
  type ChangeCardSource,
} from '../objects/ChangeCard.ts';
import { applySummary, CHANGES_WAITING_NAME } from '../ui/changes.ts';
import { commandSummary, versionSummary } from '../ui/command-summary.ts';
import { type ApplyNowInput, applyNowEligible } from './apply-now.ts';
import {
  type ApprovalAction,
  type PendingApproval,
  requestApproval,
} from './approvals.ts';
import {
  type CheckClock,
  type CheckScheduler,
  createCheckScheduler,
} from './check-scheduler.ts';
import {
  type DraftPublishResult,
  discardNow,
  previewDraft,
  publishApproved,
  startDraftWith,
} from './drafts.ts';
import { publish } from './events.ts';
import { getDraftSlot, getHost, getShellDb } from './host.ts';
import { assertOwner, type Principal, requireOwner, runAs } from './owner.ts';
import { publicChangeResult } from './results.ts';

const WORKING_COPY_NAME = CHANGES_WAITING_NAME;
const DEPENDS_ON_REMOVED =
  'This change needs one you removed. Put that one back, or remove this one too.';
const engine = createSqliteChangeEngine();
const principalOf = (owner: Principal): ChangePrincipal => ({ id: owner.id });

// ---------- shapes ----------

export interface CardCheck {
  code: BatchBlocker['code'];
  message: string;
  /** `depends_on_removed`: the card whose removal caused it ("Put it back" restores that one). */
  cause?: string;
}

export interface CardComment {
  kind: 'comment';
  role: 'owner' | 'assistant';
  text: string;
  at: string;
  state?: 'revising' | 'done';
}

/** A choice the owner can click; a choice with a command makes a NEW card. */
export interface ReviewChoice {
  label: string;
  command?: Command;
}

export interface ReviewQuestion {
  kind: 'question';
  id: string;
  text: string;
  choices: ReviewChoice[];
  state: 'open' | 'answered';
  answered?: number;
}

export interface QuestionView {
  id: string;
  text: string;
  choices: { label: string; adds: boolean }[];
  state: 'open' | 'answered';
  answered?: number;
}

export interface ChangeCardView {
  id: string;
  position: number;
  group: string;
  source: ChangeCardSource;
  summary: string;
  status: 'active' | 'removed';
  revision: number;
  /** An adopted draft's change: it has no commands and cannot be removed or edited. */
  opaque: boolean;
  /** The engine commands (empty for an opaque card). */
  commands: Command[];
  checks: CardCheck[];
  /** The assistant's review questions (never blocking). Commands stay on the server. */
  questions: QuestionView[];
  /** The owner's comments on this card and the assistant's answers, oldest first. */
  comments: CardComment[];
  /** The assistant is changing this card for a comment right now. */
  revising: boolean;
  threadId: string;
  messageId: string;
  /** Whether Remove / quick edit are offered. */
  editable: boolean;
}

export interface ChangesState {
  batchId: string | null;
  status: 'none' | 'open' | 'held';
  /** Active cards: the one number the owner sees. */
  count: number;
  generation: number;
  /** `batchDigest` of the last check; Apply's `expect`. Empty when there is nothing to apply. */
  digest: string;
  /** `stale`: a change is waiting for its check; `checking`: the check is running. */
  checkState: 'none' | 'ok' | 'blocked' | 'stale' | 'checking';
  canApply: boolean;
  /** `applyNowEligible` for these changes: the chat reply may offer "Apply now". */
  applyNow: boolean;
  blockers: (BatchBlocker | (CardCheck & { cardId: string }))[];
  /** Records the changes would overwrite: shown and pinned, never blocking. */
  overwrites: {
    recordsUpdated: number;
    recordsMerged: number;
    archivedValues: number;
    archivedTables: number;
  } | null;
  /** Why the copy cannot change now (a workbook import owns it), or null. */
  held: string | null;
  liveVersion: number;
  baseVersion: number;
  cards: ChangeCardView[];
  /** A discarded set that "Put them back" restores, or null. */
  discarded: { batchId: string; count: number } | null;
  /** The last applied batch, for History's Undo. */
  lastApplied: {
    batchId: string;
    appliedAt: string;
    versions: number[];
    undone: boolean;
    undoDigest: string;
    count: number;
  } | null;
}

export interface CardInput {
  commands: Command[];
  source: ChangeCardSource;
  group?: string;
  /** One line for the card when its commands' own summaries would be noise. */
  summary?: string;
  threadId?: string;
  messageId?: string;
}

/** The answer a structural command gives instead of applying to live. */
export interface WaitingResult {
  waiting: true;
  cardId: string;
  count: number;
  /** The engine's own result of running the command on the working copy. */
  result: Omit<ChangeResult, 'snapshot'>;
  summary: string;
}

/**
 * Structural commands that are NOT changes waiting: History's own undo and
 * clean up. They act on live, only when nothing waits, and only the owner's
 * History routes may run them (`builder.ts`); a risky one is still an
 * Approval.
 */
const MAINTENANCE: ReadonlySet<string> = new Set(['undo', 'undoTo', 'cleanUp']);
export const isMaintenanceCommand = (command: { type?: unknown }): boolean =>
  typeof command.type === 'string' && MAINTENANCE.has(command.type);

// ---------- plumbing ----------

let tail: Promise<unknown> = Promise.resolve();

/** Run changes work one at a time (the batch, its cards and the working copy move together). */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.catch(() => {});
  return run;
}

const iso = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : String(value ?? '');

function readArray<T>(text: string): T[] {
  if (!text) return [];
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? (value as T[]) : [];
  } catch {
    return [];
  }
}

function readObject(text: string): Record<string, unknown> {
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function batches() {
  return ChangeBatchCollection.create({ db: await getShellDb() });
}
async function cardsColl() {
  return ChangeCardCollection.create({ db: await getShellDb() });
}
async function drafts() {
  return AppDraftCollection.create({ db: await getShellDb() });
}

async function cardsOf(batchId: string): Promise<ChangeCard[]> {
  const rows = await (await cardsColl()).list({
    where: { batchId },
    limit: 5000,
  });
  return rows.sort((a, b) => Number(a.position) - Number(b.position));
}

const isActive = (c: ChangeCard) => c.status === 'active';

function emit(batch: ChangeBatch | null, status: string, count: number): void {
  publish({
    type: 'changes',
    status: status as 'changed' | 'applied' | 'discarded' | 'undone',
    batchId: (batch?.id as string) ?? '',
    count,
    generation: Number(batch?.generation ?? 0),
  });
}

// ---------- batch lookup and adoption ----------

async function findBatch(
  tenantId: string,
  status: 'open' | 'held',
): Promise<ChangeBatch | null> {
  const rows = await (await batches()).list({
    where: { tenantId, status },
    limit: 10,
  });
  return (
    rows.sort((a, b) => (iso(a.createdAt) < iso(b.createdAt) ? 1 : -1))[0] ??
    null
  );
}

/**
 * End a batch whose copy is gone for good. An import's cards drop their
 * commands (the loaded rows are large and never come back: "Put them back" is
 * not offered for an import).
 */
async function retireBatch(batch: ChangeBatch): Promise<void> {
  scheduler.cancel(batch.id as string);
  importIndex.delete(batch.id as string);
  for (const card of await cardsOf(batch.id as string)) {
    if (card.source !== 'import' || card.commands === '[]') continue;
    card.commands = '[]';
    await card.save();
  }
  batch.status = 'discarded';
  batch.draftId = '';
  await batch.save();
  emit(batch, 'discarded', 0);
}

/** One card per version of an adopted draft, appended for versions not yet carded. */
async function syncOpaqueCards(
  batch: ChangeBatch,
  host: AppHost,
  owner: Principal,
): Promise<void> {
  const chain = await host.draftChain().catch(() => null);
  if (!chain) return;
  const coll = await cardsColl();
  const cards = await cardsOf(batch.id as string);
  const opaque = cards.filter((c) => c.opaque);
  const records = new Map(
    [chain.base, ...chain.versions].map((v) => [v.version, v]),
  );
  for (let i = opaque.length; i < chain.versions.length; i++) {
    const rec = chain.versions[i];
    const card = await coll.create({
      batchId: batch.id as string,
      position: cards.length + (i - opaque.length),
      source: batch.status === 'held' ? 'import' : 'api',
      commands: '[]',
      draftVersions: JSON.stringify([rec.version]),
      summary: versionSummary(
        rec.summary,
        records.get(rec.parent ?? -1)?.definition,
        rec.definition,
      ),
      status: 'active',
      revision: 1,
      opaque: true,
      createdBy: owner.id,
      createdAt: new Date().toISOString(),
    });
    await card.save();
    batch.checkState = 'stale';
    batch.generation = Number(batch.generation) + 1;
    await batch.save();
  }
}

/**
 * The owner's current batch, reconciled with what the draft tables say:
 * a publish that finished but whose batch mark was lost is marked applied; a
 * draft opened before changes waiting existed (or by an import) is adopted as
 * opaque cards. Null when nothing waits. Call inside `serial`.
 */
async function syncBatch(owner: Principal): Promise<ChangeBatch | null> {
  const coll = await batches();
  let batch =
    (await findBatch(owner.tenantId, 'open')) ??
    (await findBatch(owner.tenantId, 'held'));
  const slot = await getDraftSlot();
  // A held batch is a workbook import's own copy: when that copy is gone (the
  // import failed, was cancelled, repeated or discarded) its cards go with it.
  if (batch?.status === 'held' && (!slot || slot.id !== batch.draftId)) {
    await retireBatch(batch);
    batch = null;
  }
  if (batch?.draftId) {
    const row = await (await drafts()).get(batch.draftId);
    if (row?.status === 'published' && !slot) {
      importIndex.delete(batch.id as string);
      batch.status = 'applied';
      batch.appliedAt = iso(row.endedAt) || new Date().toISOString();
      batch.appliedVersions = row.publishedVersions || '[]';
      await batch.save();
      emit(batch, 'applied', 0);
      batch = null;
    } else if (row?.status === 'discarded' && !slot) {
      // `discarded` is a copy someone closed on purpose (an import's Discard);
      // `rebuilt` is only ours. A restart leaves the row open, not discarded.
      const opaque = (await cardsOf(batch.id as string)).some((c) => c.opaque);
      if (opaque || row.note === 'discarded') {
        await retireBatch(batch);
        batch = null;
      }
    }
  }
  if (batch) {
    if (slot && slot.id === batch.draftId) {
      const want = slot.hold ? 'held' : 'open';
      const importing = importIndex.has(batch.id as string);
      // An import's draft grows while it is held: keep carding it until the
      // hold ends (including the last growth). An adopted draft that is not
      // held stays as it was adopted; later changes are ordinary cards.
      if (
        (slot.hold || batch.status === 'held') &&
        slot.host &&
        !importing &&
        !(await cardsOf(batch.id as string)).some((c) => !c.opaque)
      )
        await syncOpaqueCards(batch, slot.host, owner);
      if (batch.status !== want) {
        batch.status = want;
        await batch.save();
      }
    }
    return batch;
  }
  if (!slot) return null;
  // A draft nobody made through changes waiting: adopt it as opaque cards.
  const row = await (await drafts()).get(slot.id);
  batch = await coll.create({
    tenantId: owner.tenantId,
    appId: 'app',
    status: slot.hold ? 'held' : 'open',
    baseVersion: Number(
      row?.baseVersion ?? slot.host?.draft?.baseVersion ?? -1,
    ),
    draftId: slot.id,
    checkState: 'stale',
    createdBy: owner.id,
    createdAt: new Date().toISOString(),
  });
  await batch.save();
  if (slot.host) await syncOpaqueCards(batch, slot.host, owner);
  return batch;
}

// ---------- the working copy ----------

/** Keep live's freeze in step with whether anything waits. */
async function syncFreeze(waiting: boolean): Promise<void> {
  const live = await getHost();
  if (live.frozen !== waiting) live.setFrozen(waiting);
}

async function setBatchDraft(batch: ChangeBatch, id: string): Promise<void> {
  batch.draftId = id;
  await batch.save();
}

type ReplacedHook = (from: string, to: string) => Promise<void>;
let replacedHook: ReplacedHook | null = null;
/** Register (or clear) the follower of a rebuilt working copy's new id. */
export function setWorkingCopyReplaced(hook: ReplacedHook | null): void {
  replacedHook = hook;
}

/**
 * Rebuild the working copy from the active cards: a fresh fork of live with
 * their commands replayed in order. A card whose command no longer applies
 * gets a `depends_on_removed` check; the rest still apply. With no active
 * cards the copy is thrown away and live thaws.
 */
async function rebuild(
  batch: ChangeBatch,
  owner: Principal,
  cause = '',
): Promise<BatchBlocker[]> {
  const slot = await getDraftSlot();
  if (slot && slot.id !== batch.draftId)
    throw new EngineError(
      `another draft ("${slot.name}") is open; finish or discard it first`,
      'refused',
    );
  const cards = await cardsOf(batch.id as string);
  const active = cards.filter(isActive);
  if (active.some((c) => c.opaque))
    throw new EngineError(
      'these changes were started before changes waiting existed and cannot be edited one by one; apply or discard them',
      'refused',
    );
  if (slot) await discardNow(slot.id, { rebuilding: true });
  const live = await getHost();
  if (!active.length) {
    scheduler.cancel(batch.id as string);
    batch.draftId = '';
    batch.checkState = 'none';
    batch.digest = '';
    batch.checkResult = '';
    await batch.save();
    await syncFreeze(false);
    return [];
  }
  // An import's provenance hides replay after the LAST load: its tables look
  // each other up by a field the hide makes invisible (the order it ran in).
  const commands: { key: string; command: Command }[] = [];
  const hides: { key: string; command: Command }[] = [];
  for (const card of active)
    for (const command of readArray<Command>(card.commands))
      (card.source === 'import' && command.type === 'hideField'
        ? hides
        : commands
      ).push({ key: card.id as string, command });
  commands.push(...hides);
  const outcome: { blockers: BatchBlocker[]; applied: Map<string, number[]> } =
    {
      blockers: [],
      applied: new Map(),
    };
  try {
    await startDraftWith(
      async ({ dir, store, live: base }) => {
        const result = await engine.rebuild(principalOf(owner), base, {
          draftDir: dir,
          store,
          commands,
          author: owner.id,
        });
        outcome.blockers = result.blockers;
        for (const a of result.applied)
          outcome.applied.set(a.key, [
            ...(outcome.applied.get(a.key) ?? []),
            a.version,
          ]);
        return result.draft;
      },
      WORKING_COPY_NAME,
      owner.id,
    );
  } catch (e) {
    // startDraft thaws live on failure; changes still wait, so freeze again.
    await syncFreeze(true);
    batch.draftId = '';
    await batch.save();
    throw e;
  }
  const fresh = await getDraftSlot();
  batch.draftId = fresh?.id ?? '';
  batch.baseVersion = live.version;
  await batch.save();
  // The copy has a new identity: whoever remembered the old one (a workbook
  // import's review) follows it here, inside the changes queue.
  if (slot && fresh && slot.id !== fresh.id)
    await replacedHook?.(slot.id, fresh.id).catch(() => {});
  // Summaries come from what the copy recorded; blockers from what failed.
  const host = fresh?.host;
  const chain = host ? await host.draftChain() : null;
  const records = new Map(
    chain ? [chain.base, ...chain.versions].map((v) => [v.version, v]) : [],
  );
  const failed = new Map(
    outcome.blockers.map((b) => [b.key as string, b] as const),
  );
  for (const card of active) {
    const versions = outcome.applied.get(card.id as string) ?? [];
    const summaries = versions
      .map((v) => records.get(v))
      .filter((r): r is NonNullable<typeof r> => !!r)
      .map((r) =>
        versionSummary(
          r.summary,
          records.get(r.parent ?? -1)?.definition,
          r.definition,
        ),
      );
    if (summaries.length && !fixedSummary(card))
      card.summary = summaries.join('; ');
    card.draftVersions = JSON.stringify(versions);
    const blocker = failed.get(card.id as string);
    // A card flagged before stays tied to the card whose removal flagged it.
    const before = blockingChecks(card).find(
      (k) => k.code === 'depends_on_removed',
    );
    const kept = before?.cause ?? cause;
    card.checks = JSON.stringify(
      blocker
        ? [
            {
              code: blocker.code,
              message: DEPENDS_ON_REMOVED,
              ...(kept ? { cause: kept } : {}),
            },
          ]
        : [],
    );
    await card.save();
  }
  return outcome.blockers;
}

/** An import's table card, or a card that loads records, keeps the summary it was made with. */
const fixedSummary = (card: ChangeCard): boolean =>
  card.source === 'import' ||
  readArray<Command>(card.commands).some((c) => c.type === 'loadRecords');

/** The working copy of `batch`, rebuilding it when it is missing (a restart, a failed rebuild). */
async function workingCopy(
  batch: ChangeBatch,
  owner: Principal,
): Promise<AppHost> {
  const slot = await getDraftSlot();
  if (slot && slot.id === batch.draftId) {
    if (slot.hold) throw new EngineError(slot.hold, 'refused');
    if (!slot.host)
      throw new EngineError(
        `the changes waiting cannot be used: ${slot.problem ?? 'the copy is not open'}. Discard them to carry on.`,
        'refused',
      );
    return slot.host;
  }
  await rebuild(batch, owner);
  const fresh = await getDraftSlot();
  if (!fresh?.host)
    throw new EngineError('there are no changes waiting', 'not_found');
  return fresh.host;
}

// ---------- checks ----------

const blockingChecks = (c: ChangeCard): CardCheck[] =>
  readArray<CardCheck>(c.checks);

/** What a rebuild (not the exact check) flagged: only this survives a re-check. */
const rebuildChecks = (c: ChangeCard): CardCheck[] =>
  blockingChecks(c).filter((k) => k.code === 'depends_on_removed');

export type OwnedBlocker = BatchBlocker & { cardId?: string };

/**
 * Hand each exact-check blocker to the card(s) whose working-copy versions it
 * names (`versions`); the rest (base_moved, an unattributable replay failure)
 * stay with the whole batch.
 */
function ownBlockers(
  blockers: BatchBlocker[],
  active: ChangeCard[],
): { byCard: Map<string, CardCheck[]>; general: BatchBlocker[] } {
  const byCard = new Map<string, CardCheck[]>();
  const general: BatchBlocker[] = [];
  for (const b of blockers) {
    const owners = active.filter((c) =>
      readArray<number>(c.draftVersions).some((v) => b.versions?.includes(v)),
    );
    if (!owners.length) {
      general.push(b);
      continue;
    }
    for (const c of owners)
      byCard.set(c.id as string, [
        ...(byCard.get(c.id as string) ?? []),
        { code: b.code, message: b.message },
      ]);
  }
  return { byCard, general };
}

// The pipeline: every batch mutation (re)starts a debounce; when it fires the
// exact checks run on the working copy, serialised with every other changes
// job, and the result is stored only if the batch's `generation` is still the
// one it was scheduled for. It only READS the batch and writes check results:
// it cannot apply, approve or edit a card (`invariants.test.ts` pins that).
const owners = new Map<string, Principal>();

/** Where slice 5's assistant review chains after the exact checks. Data only. */
export interface AfterChecksInfo {
  batchId: string;
  generation: number;
  owner: Principal;
  /** True when the exact checks passed (no blockers). */
  ok: boolean;
  /** False once a later change made this generation stale; discard what you computed. */
  isCurrent: () => Promise<boolean>;
}
export type AfterChecksHook = (info: AfterChecksInfo) => Promise<void> | void;
let afterChecks: AfterChecksHook | null = null;
/** Register (or clear) the hook run after each stored check, outside the changes queue. */
export function setAfterChecks(hook: AfterChecksHook | null): void {
  afterChecks = hook;
}

async function runChecksJob(
  batchId: string,
  generation: number,
): Promise<void> {
  const owner = owners.get(batchId);
  if (!owner) return;
  let info: AfterChecksInfo | null = null;
  await serial(async () => {
    const coll = await batches();
    const batch = await coll.get(batchId);
    // A newer change (a higher generation) owns the next job: this one is stale.
    if (
      !batch ||
      batch.status !== 'open' ||
      Number(batch.generation) !== generation
    )
      return;
    const active = (await cardsOf(batchId)).filter(isActive);
    const slot = await getDraftSlot();
    if (!active.length || !slot || slot.id !== batch.draftId || !slot.host)
      return;
    if (slot.hold) return;
    batch.checkState = 'checking';
    await batch.save();
    let check: BatchCheck;
    try {
      check = await engine.checkBatch(
        principalOf(owner),
        await getHost(),
        slot.host,
      );
    } catch {
      batch.checkState = 'stale';
      await batch.save();
      return;
    }
    const now = await coll.get(batchId);
    if (!now || Number(now.generation) !== generation) return;
    const { byCard, general } = ownBlockers(check.blockers, active);
    let cardBlocked = false;
    for (const card of active) {
      const next = [
        ...rebuildChecks(card),
        ...(byCard.get(card.id as string) ?? []),
      ];
      if (next.length) cardBlocked = true;
      const text = JSON.stringify(next);
      if (text !== card.checks) {
        card.checks = text;
        await card.save();
      }
    }
    batch.digest = check.reviewDigest
      ? batchDigest(
          check.reviewDigest,
          active.map((c) => ({
            id: c.id as string,
            revision: Number(c.revision),
          })),
        )
      : '';
    batch.checkState = check.ok && !cardBlocked ? 'ok' : 'blocked';
    batch.checkResult = JSON.stringify({
      blockers: general,
      overwrites: {
        recordsUpdated: check.overwrites.recordsUpdated,
        recordsMerged: check.overwrites.recordsMerged,
        archivedValues: check.overwrites.archivedValues,
        archivedTables: check.overwrites.archivedTables,
      },
    });
    await batch.save();
    emit(batch, 'changed', active.length);
    info = {
      batchId,
      generation,
      owner,
      ok: check.ok,
      isCurrent: async () => {
        const row = await (await batches()).get(batchId);
        return (
          !!row &&
          row.status === 'open' &&
          Number(row.generation) === generation
        );
      },
    };
  });
  const hook = afterChecks;
  if (info && hook)
    void Promise.resolve()
      .then(() => hook(info as AfterChecksInfo))
      .catch(() => {});
}

let scheduler: CheckScheduler = createCheckScheduler({ run: runChecksJob });

/** (Re)start the debounced exact checks for this batch's current generation. */
function scheduleChecks(batch: ChangeBatch, owner: Principal): void {
  owners.set(batch.id as string, owner);
  scheduler.schedule(batch.id as string, Number(batch.generation));
}

/** Test seam: change the debounce delay or clock (a fake scheduler). Cancels what is pending. */
export function configureChecks(opts: {
  delayMs?: number;
  clock?: CheckClock;
}): void {
  scheduler.cancelAll();
  scheduler = createCheckScheduler({ run: runChecksJob, ...opts });
}
/** Fire any pending debounce now and wait for the jobs (tests, shutdown). */
export const flushChecks = (): Promise<void> => scheduler.flush();
/** Drop pending debounces (test harness close). */
export const cancelChecks = (): void => scheduler.cancelAll();
/** Test seam: run the job for `generation` as if its timer had fired. */
export const runChecksFor = (batchId: string, generation: number) =>
  runChecksJob(batchId, generation);

// ---------- state ----------

type Entry = ReviewQuestion | CardComment;
const MAX_REVISING_MS = 10 * 60_000;

/** The `questions` column holds two kinds of entry: review questions and the comment thread. */
function entriesOf(card: ChangeCard): Entry[] {
  return readArray<Entry>(card.questions).filter(
    (e): e is Entry =>
      !!e &&
      typeof e === 'object' &&
      ((e as Entry).kind === 'question' || (e as Entry).kind === 'comment'),
  );
}
const questionsOf = (card: ChangeCard): ReviewQuestion[] =>
  entriesOf(card).filter((e): e is ReviewQuestion => e.kind === 'question');
const commentsOf = (card: ChangeCard): CardComment[] =>
  entriesOf(card).filter((e): e is CardComment => e.kind === 'comment');
const isRevising = (comments: CardComment[]): boolean => {
  const last = [...comments].reverse().find((c) => c.role === 'owner');
  return (
    last?.state === 'revising' &&
    Date.now() - Date.parse(last.at) < MAX_REVISING_MS
  );
};

/** A load's rows are data, not something the browser reads: the summary carries their count. */
function withoutRows(command: Command): Command {
  return command.type === 'loadRecords' ? { ...command, rows: [] } : command;
}

function viewOf(card: ChangeCard): ChangeCardView {
  const opaque = !!card.opaque;
  const comments = commentsOf(card);
  return {
    id: card.id as string,
    position: Number(card.position),
    group: card.cardGroup,
    source: card.source,
    summary: card.summary,
    status: card.status,
    revision: Number(card.revision),
    opaque,
    commands: readArray<Command>(card.commands).map(withoutRows),
    checks: readArray<CardCheck>(card.checks),
    questions: questionsOf(card).map((q) => ({
      id: q.id,
      text: q.text,
      choices: q.choices.map((c) => ({ label: c.label, adds: !!c.command })),
      state: q.state,
      ...(q.answered !== undefined ? { answered: q.answered } : {}),
    })),
    comments,
    revising: isRevising(comments),
    threadId: card.threadId,
    messageId: card.messageId,
    editable: !opaque,
  };
}

function undoDigestOf(batch: ChangeBatch, liveVersion: number): string {
  return createHash('sha256')
    .update(`${batch.id}|${batch.appliedVersions}|${liveVersion}`)
    .digest('hex');
}

async function stateOf(owner: Principal): Promise<ChangesState> {
  const live = await getHost();
  const batch = await syncBatch(owner);
  if (
    batch &&
    batch.status === 'open' &&
    (batch.checkState === 'stale' || batch.checkState === 'checking') &&
    !scheduler.busy(batch.id as string)
  ) {
    // An adopted draft, or a restart: nothing is scheduled yet. Queue the
    // checks (the owner sees "Checking…" and an event follows); never block here.
    const slot = await getDraftSlot();
    if (slot?.host && !slot.hold && slot.id === batch.draftId)
      scheduleChecks(batch, owner);
  }
  const coll = await batches();
  let discarded: ChangesState['discarded'] = null;
  let lastApplied: ChangesState['lastApplied'] = null;
  const finished = await coll.list({
    where: { tenantId: owner.tenantId },
    limit: 200,
  });
  const sorted = finished.sort((a, b) =>
    iso(a.createdAt) < iso(b.createdAt) ? 1 : -1,
  );
  if (!batch) {
    const gone = sorted.find((b) => b.status === 'discarded');
    if (gone) {
      const gone_ = await cardsOf(gone.id as string);
      // An import is started again from its workbook, never put back.
      const n = gone_.some((c) => c.source === 'import')
        ? 0
        : gone_.filter((c) => isActive(c) && !c.opaque).length;
      if (n) discarded = { batchId: gone.id as string, count: n };
    }
  }
  const applied = sorted.find((b) => b.status === 'applied');
  if (applied) {
    const versions = readArray<number>(applied.appliedVersions);
    lastApplied = {
      batchId: applied.id as string,
      appliedAt: iso(applied.appliedAt),
      versions,
      undone: !!applied.undoneAt,
      undoDigest: undoDigestOf(applied, live.version),
      count: (await cardsOf(applied.id as string)).filter(isActive).length,
    };
  }
  if (!batch)
    return {
      batchId: null,
      status: 'none',
      count: 0,
      generation: 0,
      digest: '',
      checkState: 'none',
      canApply: false,
      applyNow: false,
      blockers: [],
      overwrites: null,
      held: null,
      liveVersion: live.version,
      baseVersion: live.version,
      cards: [],
      discarded,
      lastApplied,
    };
  const cards = await cardsOf(batch.id as string);
  const active = cards.filter(isActive);
  const result = readObject(batch.checkResult);
  const slot = await getDraftSlot();
  const held = batch.status === 'held' ? (slot?.hold ?? 'held') : null;
  const blockers: ChangesState['blockers'] = [
    ...(Array.isArray(result.blockers)
      ? (result.blockers as BatchBlocker[])
      : []),
    ...active.flatMap((c) =>
      blockingChecks(c).map((k) => ({ ...k, cardId: c.id as string })),
    ),
  ];
  const checkState = (batch.checkState || 'none') as ChangesState['checkState'];
  const canApply =
    active.length > 0 &&
    checkState === 'ok' &&
    !!batch.digest &&
    !held &&
    !blockers.length;
  const overwrites =
    (result.overwrites as ChangesState['overwrites'] | undefined) ?? null;
  return {
    batchId: batch.id as string,
    status: batch.status === 'held' ? 'held' : 'open',
    count: active.length,
    generation: Number(batch.generation),
    digest: batch.digest,
    checkState,
    canApply,
    applyNow:
      canApply &&
      applyNowEligible({
        cards: active.map((c) => ({
          status: c.status,
          source: c.source,
          opaque: !!c.opaque,
          commands: readArray<Command>(c.commands),
        })),
        overwrites,
      }),
    blockers,
    overwrites,
    held,
    liveVersion: live.version,
    baseVersion: Number(batch.baseVersion),
    cards: cards.map(viewOf),
    discarded,
    lastApplied,
  };
}

/** The changes waiting, for the owner. */
export async function changesState(): Promise<ChangesState> {
  const owner = await assertOwner();
  return serial(() => stateOf(owner));
}

/** How many changes wait now (0 for none). */
export async function waitingCount(): Promise<number> {
  const owner = await assertOwner();
  return serial(async () => {
    const batch = await syncBatch(owner);
    if (!batch) return 0;
    return (await cardsOf(batch.id as string)).filter(isActive).length;
  });
}

/**
 * The refusal for a History change (Undo, Undo to here, Clean up) while
 * changes wait: live structure is frozen until they are applied or discarded.
 */
export async function refuseWhileChangesWait(): Promise<void> {
  const n = await waitingCount();
  if (n > 0)
    throw new EngineError(
      `Apply or discard your ${n} waiting change${n === 1 ? '' : 's'} first.`,
      'refused',
    );
}

/**
 * The copy structure is planned and described against: the working copy while
 * changes wait, else live. For tool planning and the assistant's describe,
 * never for a write.
 */
export async function structureHost(): Promise<AppHost> {
  const owner = await assertOwner();
  return serial(async () => {
    const batch = await syncBatch(owner);
    if (!batch) return getHost();
    const cards = await cardsOf(batch.id as string);
    if (!cards.some(isActive)) return getHost();
    return workingCopy(batch, owner);
  });
}

// ---------- mutations ----------

function checkGeneration(batch: ChangeBatch, expected: unknown): void {
  if (expected === undefined || expected === null) return;
  if (!Number.isInteger(expected))
    throw new EngineError('generation must be a whole number', 'invalid');
  if (expected !== Number(batch.generation))
    throw new EngineError(
      'the changes waiting changed in another window; reload to see them',
      'refused',
    );
}

async function bump(batch: ChangeBatch): Promise<void> {
  batch.generation = Number(batch.generation) + 1;
  batch.checkState = 'stale';
  await batch.save();
}

async function ensureOpenBatch(owner: Principal): Promise<ChangeBatch> {
  const existing = await syncBatch(owner);
  if (existing) {
    if (existing.status === 'held') {
      const slot = await getDraftSlot();
      throw new EngineError(
        slot?.hold ?? 'a workbook import owns these changes for now',
        'refused',
      );
    }
    return existing;
  }
  const row = await (await batches()).create({
    tenantId: owner.tenantId,
    appId: 'app',
    status: 'open',
    createdBy: owner.id,
    createdAt: new Date().toISOString(),
  });
  await row.save();
  return row;
}

async function nextPosition(batch: ChangeBatch): Promise<number> {
  const cards = await cardsOf(batch.id as string);
  return cards.reduce((n, c) => Math.max(n, Number(c.position) + 1), 0);
}

// ---------- a workbook import's part (#5207) ----------
//
// The import loads into the working copy it holds (`slot.hold`); each command
// it runs is recorded here as part of ONE card per table (its definition,
// fields, loads and provenance hides), so the owner sees, removes and applies
// the import like any other change. This only RECORDS: nothing here applies,
// approves or reaches live, and it refuses unless the import holds the copy.

/** Per held batch: the next card position and each table's card, so a load never rescans the cards. */
const importIndex = new Map<
  string,
  { next: number; tables: Map<string, string> }
>();

const IMPORT_HIDDEN = new Set(['workbookRow', 'workbookLookup']);
const rowWord = (n: number) => `${n} ${n === 1 ? 'record' : 'records'}`;

/** "Orders: new table with 5 fields and 42 records", counted from the card's commands. */
function importSummary(commands: Command[]): string {
  const first = commands[0];
  if (first?.type !== 'defineModel') return 'A workbook change';
  const label = (first.label ?? first.name).trim() || first.name;
  const fields = new Set(
    Object.keys(first.fields ?? {}).filter((k) => !IMPORT_HIDDEN.has(k)),
  );
  let rows = 0;
  for (const c of commands) {
    if (c.type === 'addField' && !IMPORT_HIDDEN.has(c.field))
      fields.add(c.field);
    if (c.type === 'loadRecords') rows += c.rows.length;
  }
  const f = `${fields.size} ${fields.size === 1 ? 'field' : 'fields'}`;
  return `${label}: new table with ${f}${rows ? ` and ${rowWord(rows)}` : ''}`;
}

export interface ImportCommandInput {
  /** The import's own working copy (its hold names the import). */
  host: AppHost;
  /** The import's group on /changes: one collapsible group per import. */
  group: string;
  command: Command;
  /** Runs `command` on `host`; recorded only if it succeeds. */
  run: () => Promise<unknown>;
}

/**
 * Run one command of a workbook import on its held working copy and record it
 * on its table's card (creating the card at the table's first command). Cards
 * keep the import's order; a report is a card of its own.
 */
export function recordImportCommand(
  owner: Principal,
  input: ImportCommandInput,
): Promise<unknown> {
  return runAs(owner, () =>
    serial(async () => {
      await requireOwner(owner);
      const slot = await getDraftSlot();
      if (!slot?.hold || !slot.host || slot.host !== input.host)
        throw new EngineError(
          'only a workbook import that holds the copy can add its changes',
          'refused',
        );
      const batch = await syncBatch(owner);
      if (!batch || batch.status !== 'held' || batch.draftId !== slot.id)
        throw new EngineError(
          'the workbook import does not own these changes',
          'refused',
        );
      const id = batch.id as string;
      let index = importIndex.get(id);
      if (!index) {
        const cards = await cardsOf(id);
        index = {
          next: cards.reduce((n, c) => Math.max(n, Number(c.position) + 1), 0),
          tables: new Map(),
        };
        importIndex.set(id, index);
      }
      const { command } = input;
      const prior = structuredClone(input.host.def);
      const result = (await input.run()) as ChangeResult;
      const model =
        command.type === 'defineModel'
          ? command.name
          : command.type !== 'defineReport' && 'model' in command
            ? String(command.model)
            : '';
      const coll = await cardsColl();
      const known = model ? index.tables.get(model) : undefined;
      let card = known ? await coll.get(known) : null;
      let created = false;
      if (!card) {
        card = await coll.create({
          batchId: id,
          position: index.next++,
          cardGroup: input.group,
          source: 'import',
          commands: '[]',
          draftVersions: '[]',
          summary: '',
          status: 'active',
          revision: 1,
          createdBy: owner.id,
          createdAt: new Date().toISOString(),
        });
        created = true;
      }
      const commands = [...readArray<Command>(card.commands), command];
      card.commands = JSON.stringify(commands);
      card.draftVersions = JSON.stringify([
        ...readArray<number>(card.draftVersions),
        result.version,
      ]);
      card.summary = model
        ? importSummary(commands)
        : commandSummary(command, prior, input.host.def);
      await card.save();
      if (created && model) index.tables.set(model, card.id as string);
      batch.generation = Number(batch.generation) + 1;
      batch.checkState = 'stale';
      await batch.save();
      // One announcement per new card (and at the end), not one per 500-row load.
      if (created || command.type === 'hideField')
        emit(batch, 'changed', index.next);
      return result;
    }),
  );
}

/** Resolves once every change to the batch queued so far is finished (a rebuild included). */
export const settled = (): Promise<void> => serial(async () => {});

/**
 * Run `commands` as ONE card on the working copy. A tail append executes
 * incrementally (no rebuild). A command that does not apply is refused and no
 * card is made.
 */
export function addChangeCard(
  input: CardInput,
  author?: string,
): Promise<WaitingResult> {
  return (async () => {
    const owner = await assertOwner();
    if (!input.commands.length)
      throw new EngineError('a change needs a command', 'invalid');
    return serial(async () => {
      const batch = await ensureOpenBatch(owner);
      const cards = await cardsOf(batch.id as string);
      const hadActive = cards.some(isActive);
      const host = hadActive
        ? await workingCopy(batch, owner)
        : await (async () => {
            // First change: an empty working copy of live (or the adopted one).
            const slot = await getDraftSlot();
            if (slot && slot.id !== batch.draftId)
              throw new EngineError(
                `another draft ("${slot.name}") is open; finish or discard it first`,
                'refused',
              );
            if (slot) return workingCopy(batch, owner);
            const info = await startDraftWith(
              ({ dir, store, live: base }) =>
                engine.forkDraft(principalOf(owner), base, dir, { store }),
              WORKING_COPY_NAME,
              owner.id,
            );
            await setBatchDraft(batch, info.id);
            const fresh = await getDraftSlot();
            if (!fresh?.host)
              throw new EngineError('the working copy did not open', 'refused');
            return fresh.host;
          })();
      const live = await getHost();
      await syncFreeze(true);
      const before = structuredClone(host.def);
      let last: ChangeResult | null = null;
      const summaries: string[] = [];
      const madeVersions: number[] = [];
      try {
        for (const command of input.commands) {
          const prior = structuredClone(host.def);
          last = (await host.execute(command, {
            author: author ?? owner.id,
          })) as ChangeResult;
          madeVersions.push(last.version);
          summaries.push(commandSummary(command, prior, host.def));
        }
      } catch (e) {
        // A card of several commands may have half applied: restore the copy.
        if (input.commands.length > 1 && hadActive)
          await rebuild(batch, owner).catch(() => {});
        else if (input.commands.length > 1)
          await rebuild(batch, owner).catch(() => {});
        else if (!hadActive) await rebuild(batch, owner).catch(() => {});
        throw e;
      }
      void before;
      const card = await (await cardsColl()).create({
        batchId: batch.id as string,
        position: await nextPosition(batch),
        cardGroup: input.group ?? '',
        source: input.source,
        commands: JSON.stringify(input.commands),
        draftVersions: JSON.stringify(madeVersions),
        summary: input.summary ?? summaries.join('; '),
        status: 'active',
        revision: 1,
        threadId: input.threadId ?? '',
        messageId: input.messageId ?? '',
        createdBy: owner.id,
        createdAt: new Date().toISOString(),
      });
      await card.save();
      if (!batch.baseVersion || Number(batch.baseVersion) < 0) {
        batch.baseVersion = live.version;
      }
      await bump(batch);
      scheduleChecks(batch, owner);
      const count = (await cardsOf(batch.id as string)).filter(isActive).length;
      emit(batch, 'changed', count);
      return {
        waiting: true as const,
        cardId: card.id as string,
        count,
        result: publicChangeResult(last as ChangeResult),
        summary: card.summary,
      };
    });
  })();
}

async function withCard(
  cardId: string,
  owner: Principal,
): Promise<{ batch: ChangeBatch; card: ChangeCard }> {
  const batch = await syncBatch(owner);
  if (!batch)
    throw new EngineError('there are no changes waiting', 'not_found');
  const card = (await cardsOf(batch.id as string)).find((c) => c.id === cardId);
  if (!card) throw new EngineError('that change is not waiting', 'not_found');
  if (batch.status === 'held')
    throw new EngineError(
      'a workbook import owns these changes for now',
      'refused',
    );
  return { batch, card };
}

async function afterRebuild(
  batch: ChangeBatch,
  owner: Principal,
  what: string,
  cause = '',
): Promise<BatchBlocker[]> {
  await bump(batch);
  const blockers = await rebuild(batch, owner, cause);
  if ((await cardsOf(batch.id as string)).some(isActive))
    scheduleChecks(batch, owner);
  const count = (await cardsOf(batch.id as string)).filter(isActive).length;
  emit(batch, what, count);
  return blockers;
}

export function removeChangeCard(
  cardId: string,
  opts: { generation?: unknown } = {},
): Promise<ChangesState> {
  return (async () => {
    const owner = await assertOwner();
    return serial(async () => {
      const { batch, card } = await withCard(cardId, owner);
      checkGeneration(batch, opts.generation);
      if (card.opaque)
        throw new EngineError(
          'this change cannot be removed on its own',
          'refused',
        );
      if (!isActive(card)) return stateOf(owner);
      const cards = await cardsOf(batch.id as string);
      if (cards.some((c) => c.opaque && isActive(c)))
        throw new EngineError(
          'these changes were started before changes waiting existed and cannot be edited one by one; apply or discard them',
          'refused',
        );
      card.status = 'removed';
      await card.save();
      await afterRebuild(batch, owner, 'changed', card.id as string);
      return stateOf(owner);
    });
  })();
}

export function restoreChangeCard(
  cardId: string,
  opts: { generation?: unknown } = {},
): Promise<ChangesState> {
  return (async () => {
    const owner = await assertOwner();
    return serial(async () => {
      const { batch, card } = await withCard(cardId, owner);
      checkGeneration(batch, opts.generation);
      if (isActive(card)) return stateOf(owner);
      card.status = 'active';
      await card.save();
      await afterRebuild(batch, owner, 'changed');
      return stateOf(owner);
    });
  })();
}

/**
 * "Remove those too": remove every waiting change that needs the one the
 * owner removed (all flagged `depends_on_removed` for the same cause), then
 * again for any the rebuild newly flags. `cardId` is any one flagged card.
 */
export function removeDependentCards(
  cardId: string,
  opts: { generation?: unknown } = {},
): Promise<ChangesState> {
  return (async () => {
    const owner = await assertOwner();
    return serial(async () => {
      const { batch, card } = await withCard(cardId, owner);
      checkGeneration(batch, opts.generation);
      const flag = rebuildChecks(card)[0];
      if (!isActive(card) || !flag)
        throw new EngineError(
          'that change is not waiting on one you removed',
          'refused',
        );
      const cause = flag.cause ?? '';
      const matches = (c: ChangeCard) =>
        isActive(c) && rebuildChecks(c).some((k) => (k.cause ?? '') === cause);
      let cards = await cardsOf(batch.id as string);
      for (let round = 0; round <= cards.length; round++) {
        const targets = cards.filter(matches);
        if (!targets.length) break;
        for (const t of targets) {
          t.status = 'removed';
          await t.save();
        }
        await bump(batch);
        await rebuild(batch, owner, cause);
        cards = await cardsOf(batch.id as string);
      }
      if (cards.some(isActive)) scheduleChecks(batch, owner);
      emit(batch, 'changed', cards.filter(isActive).length);
      return stateOf(owner);
    });
  })();
}

/** What a quick edit may change. */
export interface QuickEdit {
  label?: unknown;
  choices?: unknown;
  /** Which field of a defineModel card (its own field when omitted). */
  field?: unknown;
  default?: unknown;
}

function cleanLabel(value: unknown): string {
  if (typeof value !== 'string')
    throw new EngineError('label must be text', 'invalid');
  const text = Array.from(value)
    .filter((ch) => ch.charCodeAt(0) >= 0x20 && ch !== '\u007f')
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || text.length > 80)
    throw new EngineError('label must be 1 to 80 characters', 'invalid');
  return text;
}

function cleanChoices(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 100)
    throw new EngineError(
      'choices must be a list of 1 to 100 options',
      'invalid',
    );
  const out = value.map((v) => cleanLabel(v));
  if (new Set(out).size !== out.length)
    throw new EngineError('choices must not repeat', 'invalid');
  return out;
}

/** Apply a whitelisted patch to a card's single command, in place. */
function patchCommand(command: Command, edit: QuickEdit): Command {
  if (edit.default !== undefined)
    throw new EngineError('a default cannot be set here', 'invalid');
  if (edit.label === undefined && edit.choices === undefined)
    throw new EngineError('nothing to change', 'invalid');
  const next = structuredClone(command);
  const apply = (def: {
    label?: string;
    choices?: string[];
    type?: string;
  }) => {
    if (edit.label !== undefined) def.label = cleanLabel(edit.label);
    if (edit.choices !== undefined) {
      if (def.type !== 'choice')
        throw new EngineError('only a choice field has options', 'invalid');
      def.choices = cleanChoices(edit.choices);
    }
  };
  if (next.type === 'addField') apply(next.definition);
  else if (next.type === 'changeFieldType') apply(next.to);
  else if (next.type === 'defineModel') {
    if (edit.field === undefined) {
      if (edit.choices !== undefined)
        throw new EngineError('name the field whose options change', 'invalid');
      next.label = cleanLabel(edit.label);
    } else {
      const name = String(edit.field);
      const def = Object.hasOwn(next.fields ?? {}, name)
        ? next.fields?.[name]
        : undefined;
      if (!def)
        throw new EngineError('that field is not in this change', 'not_found');
      apply(def);
    }
  } else
    throw new EngineError(
      'this kind of change cannot be edited here',
      'refused',
    );
  return next;
}

export function editChangeCard(
  cardId: string,
  edit: QuickEdit,
  opts: { generation?: unknown } = {},
): Promise<ChangesState> {
  return (async () => {
    const owner = await assertOwner();
    return serial(async () => {
      const { batch, card } = await withCard(cardId, owner);
      checkGeneration(batch, opts.generation);
      if (card.opaque || !isActive(card))
        throw new EngineError('this change cannot be edited', 'refused');
      const cards = await cardsOf(batch.id as string);
      if (cards.some((c) => c.opaque && isActive(c)))
        throw new EngineError(
          'these changes were started before changes waiting existed and cannot be edited',
          'refused',
        );
      const commands = readArray<Command>(card.commands);
      // An imported table is its definition plus its loads: only the
      // definition (its first command) is edited, the loads stay as they are.
      const importedTable =
        card.source === 'import' && commands[0]?.type === 'defineModel';
      if (commands.length !== 1 && !importedTable)
        throw new EngineError(
          'this change has several steps and cannot be edited here',
          'refused',
        );
      const before = card.commands;
      const patched = patchCommand(commands[0], edit);
      card.commands = JSON.stringify([patched, ...commands.slice(1)]);
      card.revision = Number(card.revision) + 1;
      await card.save();
      try {
        await afterRebuild(batch, owner, 'changed');
      } catch (e) {
        card.commands = before;
        card.revision = Number(card.revision) - 1;
        await card.save();
        await rebuild(batch, owner).catch(() => {});
        throw e;
      }
      return stateOf(owner);
    });
  })();
}

/** Throw the waiting changes away (kept so "Put them back" can restore them). Live thaws. */
export function discardChanges(
  opts: { generation?: unknown } = {},
): Promise<ChangesState> {
  return (async () => {
    const owner = await assertOwner();
    return serial(async () => {
      const batch = await syncBatch(owner);
      if (!batch)
        throw new EngineError('there are no changes waiting', 'not_found');
      checkGeneration(batch, opts.generation);
      const slot = await getDraftSlot();
      scheduler.cancel(batch.id as string);
      if (slot && slot.id === batch.draftId) await discardNow(slot.id);
      await syncFreeze(false);
      batch.generation = Number(batch.generation) + 1;
      await retireBatch(batch);
      return stateOf(owner);
    });
  })();
}

/** "Put them back": reopen the last discarded set (when nothing else waits). */
export function restoreDiscardedChanges(
  opts: { generation?: unknown } = {},
): Promise<ChangesState> {
  return (async () => {
    const owner = await assertOwner();
    return serial(async () => {
      if (await syncBatch(owner))
        throw new EngineError(
          'other changes are waiting; apply or discard them first',
          'refused',
        );
      const gone = (
        await (
          await batches()
        ).list({
          where: { tenantId: owner.tenantId, status: 'discarded' },
          limit: 200,
        })
      ).sort((a, b) => (iso(a.createdAt) < iso(b.createdAt) ? 1 : -1))[0];
      if (!gone) throw new EngineError('nothing was discarded', 'not_found');
      checkGeneration(gone, opts.generation);
      const cards = await cardsOf(gone.id as string);
      if (cards.some((c) => c.opaque || c.source === 'import'))
        throw new EngineError('these changes cannot be put back', 'refused');
      if (!cards.some(isActive))
        throw new EngineError('nothing was discarded', 'not_found');
      gone.status = 'open';
      await gone.save();
      await syncFreeze(true);
      await afterRebuild(gone, owner, 'changed');
      return stateOf(owner);
    });
  })();
}

// ---------- the assistant's part (#5206) ----------
//
// Everything below changes cards, never applies: a revision replaces ONE card's
// commands in an open batch, a question answer adds a NEW card, a review stores
// questions. None calls `requestApply`/`applyApproved`/`undoOwnBatch`;
// `invariants.test.ts` pins that.

const MAX_COMMAND_CHARS = 50_000;
const MAX_COMMENT_CHARS = 2000;
const MAX_COMMENTS = 40;

/**
 * A command the assistant (a revision) or a review choice may put in a card:
 * a known STRUCTURAL command that is not a History command. An unknown type is
 * refused here (`isStructuralCommand` would call it structural). Returns a
 * clean JSON copy with no `approved` key; the engine validates the rest when
 * the card is replayed.
 */
export function cleanCardCommand(value: unknown): Command {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new EngineError('a change must be an object', 'invalid');
  const type = (value as { type?: unknown }).type;
  if (
    typeof type !== 'string' ||
    !Object.hasOwn(STRUCTURAL_COMMANDS, type) ||
    STRUCTURAL_COMMANDS[type as keyof typeof STRUCTURAL_COMMANDS] !== true ||
    MAINTENANCE.has(type)
  )
    throw new EngineError('that kind of change cannot be made here', 'refused');
  const text = JSON.stringify(value);
  if (text.length > MAX_COMMAND_CHARS)
    throw new EngineError('that change is too large', 'invalid');
  const copy = JSON.parse(text) as Record<string, unknown>;
  delete copy.approved;
  return copy as unknown as Command;
}

/** A revisable card: active, one the owner can edit, in an open (not held) batch. */
async function openCard(
  cardId: string,
  owner: Principal,
): Promise<{ batch: ChangeBatch; card: ChangeCard }> {
  const found = await withCard(cardId, owner);
  if (found.batch.status !== 'open')
    throw new EngineError('these changes cannot be edited now', 'refused');
  if (found.card.opaque || !isActive(found.card))
    throw new EngineError('this change cannot be edited', 'refused');
  if (found.card.source === 'import')
    throw new EngineError(
      'an imported table cannot be changed by comment; remove it or use Quick edit',
      'refused',
    );
  const cards = await cardsOf(found.batch.id as string);
  if (cards.some((c) => c.opaque && isActive(c)))
    throw new EngineError(
      'these changes were started before changes waiting existed and cannot be edited',
      'refused',
    );
  return found;
}

/**
 * Replace the commands of ONE card in place (comment-to-revise): the revision
 * goes up, the working copy is rebuilt and the changes are re-checked. If the
 * new command does not apply, the card is put back exactly as it was and the
 * engine's reason is returned as an error. NEVER applies.
 */
export function reviseChangeCard(
  cardId: string,
  command: unknown,
): Promise<{ cardId: string; revision: number; summary: string }> {
  return (async () => {
    const owner = await assertOwner();
    const next = cleanCardCommand(command);
    return serial(async () => {
      const { batch, card } = await openCard(cardId, owner);
      const beforeCommands = card.commands;
      const beforeRevision = Number(card.revision);
      card.commands = JSON.stringify([next]);
      card.revision = beforeRevision + 1;
      await card.save();
      const undo = async () => {
        // The rebuild re-read and saved the cards: restore the row as stored now.
        const stored = (await cardsOf(batch.id as string)).find(
          (c) => c.id === cardId,
        );
        if (stored) {
          stored.commands = beforeCommands;
          stored.revision = beforeRevision;
          await stored.save();
        }
        await afterRebuild(batch, owner, 'changed').catch(() => {});
      };
      let blockers: BatchBlocker[];
      try {
        blockers = await afterRebuild(batch, owner, 'changed');
      } catch (e) {
        await undo();
        throw e;
      }
      const mine = blockers.find((b) => b.key === cardId);
      if (mine) {
        await undo();
        throw new EngineError(
          `That change does not fit your app as it is, so nothing was changed. ${mine.message ?? ''}`.trim(),
          'refused',
        );
      }
      const fresh = (await cardsOf(batch.id as string)).find(
        (c) => c.id === cardId,
      );
      return {
        cardId,
        revision: Number(fresh?.revision ?? card.revision),
        summary: fresh?.summary ?? card.summary,
      };
    });
  })();
}

async function saveEntries(card: ChangeCard, entries: Entry[]): Promise<void> {
  card.questions = JSON.stringify(entries);
  await card.save();
}

const cleanText = (value: unknown, max: number): string =>
  typeof value === 'string'
    ? Array.from(value)
        .filter((ch) => ch === '\n' || ch.charCodeAt(0) >= 0x20)
        .join('')
        .trim()
        .slice(0, max)
    : '';

/** What a comment turn is told about the card it is scoped to. */
export interface CommentStart {
  threadId: string;
  summary: string;
  commands: Command[];
  revision: number;
}

/**
 * Record the owner's comment on one card (shown at once as "revising…") and
 * return what the assistant turn needs. The text is the owner's own, kept as
 * plain text. No generation bump: comments are not part of the digest.
 */
export function beginCardComment(
  cardId: string,
  text: unknown,
): Promise<CommentStart> {
  return (async () => {
    const owner = await assertOwner();
    const clean = cleanText(text, MAX_COMMENT_CHARS);
    if (!clean) throw new EngineError('write what to change', 'invalid');
    return serial(async () => {
      const { batch, card } = await openCard(cardId, owner);
      const entries = entriesOf(card);
      if (isRevising(commentsOf(card)))
        throw new EngineError(
          'the assistant is already working on this change',
          'refused',
        );
      entries.push({
        kind: 'comment',
        role: 'owner',
        text: clean,
        at: new Date().toISOString(),
        state: 'revising',
      });
      await saveEntries(card, entries.slice(-MAX_COMMENTS));
      emit(
        batch,
        'changed',
        (await cardsOf(batch.id as string)).filter(isActive).length,
      );
      return {
        threadId: card.threadId,
        summary: card.summary,
        commands: readArray<Command>(card.commands),
        revision: Number(card.revision),
      };
    });
  })();
}

/** Close the comment: store the assistant's answer and the thread it ran in. */
export function endCardComment(
  cardId: string,
  done: { reply: string; threadId: string; revisionBefore: number },
): Promise<void> {
  return (async () => {
    const owner = await assertOwner();
    return serial(async () => {
      const batch = await syncBatch(owner);
      const card = batch
        ? (await cardsOf(batch.id as string)).find((c) => c.id === cardId)
        : undefined;
      if (!batch || !card) return;
      const entries = entriesOf(card).map((e) =>
        e.kind === 'comment' && e.state === 'revising'
          ? { ...e, state: 'done' as const }
          : e,
      );
      const changed = Number(card.revision) !== done.revisionBefore;
      entries.push({
        kind: 'comment',
        role: 'assistant',
        text:
          cleanText(done.reply, 1000) ||
          (changed
            ? 'Done. I changed this card.'
            : 'I did not change anything.'),
        at: new Date().toISOString(),
        state: 'done',
      });
      if (done.threadId) card.threadId = done.threadId;
      await saveEntries(card, entries.slice(-MAX_COMMENTS));
      emit(
        batch,
        'changed',
        (await cardsOf(batch.id as string)).filter(isActive).length,
      );
    });
  })();
}

// ---------- review questions ----------

export const REVIEW_LIMITS = {
  questionsPerCard: 2,
  questionsPerBatch: 6,
  choices: 4,
  textChars: 300,
  labelChars: 60,
} as const;

export interface ReviewItem {
  cardId: string;
  text: string;
  choices: { label: string; command?: unknown }[];
}

/**
 * Store the review's questions on their cards, only if `generation` is still
 * the batch's (a later change makes the result stale: discarded, false). Open
 * questions are replaced, answered ones stay (so a question is not asked
 * twice), comments stay. A choice's command is validated like any structural
 * command (allow-list, then the working copy's own `plan`); a choice that does
 * not validate is dropped. Writes only `questions`: no generation bump, no
 * digest change, and nothing here can apply.
 */
export function setReviewQuestions(
  batchId: string,
  generation: number,
  items: ReviewItem[],
): Promise<boolean> {
  return (async () => {
    const owner = await assertOwner();
    return serial(async () => {
      const batch = await (await batches()).get(batchId);
      if (
        !batch ||
        batch.tenantId !== owner.tenantId ||
        batch.status !== 'open' ||
        Number(batch.generation) !== generation
      )
        return false;
      const active = (await cardsOf(batchId)).filter(isActive);
      if (!active.length || active.some((c) => c.opaque)) return false;
      const slot = await getDraftSlot();
      const host =
        slot && slot.id === batch.draftId && !slot.hold ? slot.host : null;
      const byCard = new Map<string, ReviewQuestion[]>();
      let total = 0;
      for (const item of items) {
        if (total >= REVIEW_LIMITS.questionsPerBatch) break;
        const card = active.find((c) => c.id === item.cardId);
        const text = cleanText(item?.text, REVIEW_LIMITS.textChars);
        if (!card || !text || !Array.isArray(item.choices)) continue;
        const list = byCard.get(card.id as string) ?? [];
        if (list.length >= REVIEW_LIMITS.questionsPerCard) continue;
        const choices: ReviewChoice[] = [];
        for (const raw of item.choices.slice(0, REVIEW_LIMITS.choices)) {
          const label = cleanText(raw?.label, REVIEW_LIMITS.labelChars);
          if (!label || choices.some((c) => c.label === label)) continue;
          if (raw.command === undefined || raw.command === null) {
            choices.push({ label });
            continue;
          }
          try {
            const command = cleanCardCommand(raw.command);
            if (!host) continue;
            await host.plan(command);
            choices.push({ label, command });
          } catch {
            // not a change this app can take: the choice is not offered
          }
        }
        if (!choices.length) continue;
        list.push({
          kind: 'question',
          id: `q_${randomUUID()}`,
          text,
          choices,
          state: 'open',
        });
        byCard.set(card.id as string, list);
        total++;
      }
      let changed = false;
      for (const card of active) {
        const before = entriesOf(card);
        const keep = before.filter(
          (e) => e.kind === 'comment' || e.state === 'answered',
        );
        const next = [...keep, ...(byCard.get(card.id as string) ?? [])];
        // Open questions carry fresh ids, so any change shows in the text.
        if (JSON.stringify(next) === JSON.stringify(before)) continue;
        await saveEntries(card, next);
        changed = true;
      }
      if (changed) emit(batch, 'changed', active.length);
      return true;
    });
  })();
}

/**
 * The owner clicked a choice of a review question. `choice` is an index into
 * the stored choices: nothing the client sends is ever a command. A choice with
 * a command becomes a NEW card (source `api`, so it is never "Apply now"
 * material; the digest changes and the owner reviews it like any change); one
 * without just closes the question. Never applies. 409 on a stale `generation`.
 */
export function answerReviewQuestion(
  questionId: string,
  choice: unknown,
  opts: { generation?: unknown } = {},
): Promise<ChangesState> {
  return (async () => {
    const owner = await assertOwner();
    if (!Number.isInteger(choice) || (choice as number) < 0)
      throw new EngineError('choice must be a number from the list', 'invalid');
    const index = choice as number;
    const picked = await serial(async () => {
      const batch = await syncBatch(owner);
      if (!batch || batch.status !== 'open')
        throw new EngineError('there are no changes waiting', 'not_found');
      checkGeneration(batch, opts.generation);
      for (const card of (await cardsOf(batch.id as string)).filter(isActive)) {
        const entries = entriesOf(card);
        const q = entries.find(
          (e): e is ReviewQuestion =>
            e.kind === 'question' && e.id === questionId,
        );
        if (!q) continue;
        if (q.state !== 'open')
          throw new EngineError(
            'that question was already answered',
            'refused',
          );
        const chosen = q.choices[index];
        if (!chosen)
          throw new EngineError('that choice is not on the list', 'invalid');
        // Claim it before the card is made, so a double click makes one card.
        q.state = 'answered';
        q.answered = index;
        await saveEntries(card, entries);
        return { cardId: card.id as string, command: chosen.command };
      }
      throw new EngineError('that question is not waiting', 'not_found');
    });
    if (picked.command) {
      try {
        await addChangeCard({ commands: [picked.command], source: 'api' });
      } catch (e) {
        await serial(async () => {
          const batch = await syncBatch(owner);
          const card = batch
            ? (await cardsOf(batch.id as string)).find(
                (c) => c.id === picked.cardId,
              )
            : undefined;
          if (!card) return;
          const entries = entriesOf(card);
          const q = entries.find(
            (x): x is ReviewQuestion =>
              x.kind === 'question' && x.id === questionId,
          );
          if (q) {
            q.state = 'open';
            delete q.answered;
            await saveEntries(card, entries);
          }
        });
        throw e;
      }
    } else
      await serial(async () => {
        const batch = await syncBatch(owner);
        if (batch)
          emit(
            batch,
            'changed',
            (await cardsOf(batch.id as string)).filter(isActive).length,
          );
      });
    return changesState();
  })();
}

// ---------- preview ----------

/** What Apply would do: the engine's rehearsal on a copy of current live data. Read only. */
export function previewChanges() {
  return (async () => {
    const owner = await assertOwner();
    return serial(async () => {
      const batch = await syncBatch(owner);
      if (!batch || !(await cardsOf(batch.id as string)).some(isActive))
        throw new EngineError('there are no changes waiting', 'not_found');
      await workingCopy(batch, owner);
      const { preview } = await previewDraft();
      return { changes: await stateOf(owner), preview };
    });
  })();
}

// ---------- apply ----------

/** What an `apply-batch` Approval pins. */
export interface ApplyAction {
  kind: 'apply-batch';
  batchId: string;
  draftId: string;
  generation: number;
  /** `batchDigest` the owner reviewed. */
  digest: string;
  /** The engine's `replayDigest`, passed to `publishDraft` as its `expect`. */
  engineDigest: string;
}

/**
 * The exact checks, run NOW on the working copy: Apply never trusts the
 * pipeline's cached result. Refuses (409, `reason: 'blocked'`, with the
 * blockers and the cards they belong to) while anything blocks; the only
 * check state kept from before is what a rebuild flagged (`depends_on_removed`).
 */
async function freshCheck(
  batch: ChangeBatch,
  owner: Principal,
  host: AppHost,
): Promise<{ check: BatchCheck; digest: string; active: ChangeCard[] }> {
  const cards = await cardsOf(batch.id as string);
  const active = cards.filter(isActive);
  const live = await getHost();
  const check = await engine.checkBatch(principalOf(owner), live, host);
  const { byCard, general } = ownBlockers(check.blockers, active);
  const blockers: OwnedBlocker[] = [
    ...general,
    ...active.flatMap((c) =>
      [...rebuildChecks(c), ...(byCard.get(c.id as string) ?? [])].map((k) => ({
        ...k,
        cardId: c.id as string,
      })),
    ),
  ];
  if (blockers.length)
    throw new EngineError(
      `Can't apply yet: ${blockers[0].message}`,
      'refused',
      {
        reason: 'blocked',
        blockers,
      },
    );
  const digest = check.reviewDigest
    ? batchDigest(
        check.reviewDigest,
        active.map((c) => ({
          id: c.id as string,
          revision: Number(c.revision),
        })),
      )
    : '';
  if (!digest) throw new EngineError('there is nothing to apply', 'refused');
  return { check, digest, active };
}

const REVIEW_AGAIN = (): EngineError =>
  new EngineError(
    'the changes waiting changed since they were reviewed; review them again',
    'refused',
    { reason: 'changed' },
  );

/**
 * Record the `apply-batch` Approval for the digest the owner reviewed (`expect`
 * is required). A fresh exact check must still produce that digest, else 409
 * (review again). Called only by `applyOwnBatch` (approvals.ts).
 */
export function requestApply(
  expect: unknown,
  requestedBy: string,
  opts: { generation?: unknown; source?: unknown } = {},
): Promise<PendingApproval> {
  return (async () => {
    const owner = await assertOwner();
    if (typeof expect !== 'string' || !expect)
      throw new EngineError(
        'expect must be the digest of the changes you reviewed',
        'invalid',
      );
    return serial(async () => {
      const batch = await syncBatch(owner);
      if (!batch || !(await cardsOf(batch.id as string)).some(isActive))
        throw new EngineError('there are no changes waiting', 'not_found');
      if (batch.status === 'held')
        throw new EngineError(
          (await getDraftSlot())?.hold ??
            'a workbook import owns these changes',
          'refused',
        );
      checkGeneration(batch, opts.generation);
      const host = await workingCopy(batch, owner);
      const { check, digest, active } = await freshCheck(batch, owner, host);
      if (digest !== expect) throw REVIEW_AGAIN();
      // "Apply now" from chat: the server decides, from the batch and the fresh
      // exact check it just ran, never from what the client says it is.
      if (opts.source === 'chat') {
        const input: ApplyNowInput = {
          cards: active.map((c) => ({
            status: c.status,
            source: c.source,
            opaque: !!c.opaque,
            commands: readArray<Command>(c.commands),
          })),
          overwrites: check.overwrites,
        };
        if (!applyNowEligible(input))
          throw new EngineError(
            'This one needs a closer look. Review it, then Apply.',
            'refused',
            { reason: 'review_first' },
          );
      }
      const action: ApplyAction = {
        kind: 'apply-batch',
        batchId: batch.id as string,
        draftId: batch.draftId,
        generation: Number(batch.generation),
        digest,
        engineDigest: check.engineDigest as string,
      };
      const n = active.length;
      return requestApproval(
        action as ApprovalAction,
        {
          summary: applySummary(n),
          risky: true,
          preview: {
            changes: active.map((c) => c.summary),
            overwrites: check.overwrites,
          } as Record<string, unknown>,
        },
        requestedBy,
      );
    });
  })();
}

/**
 * Apply an APPROVED apply-batch. Called only from approvals.ts, which passes
 * the engine call (it owns the `approved` flag). Refuses unless the batch is
 * exactly what the approval was pinned to: same generation, same working copy,
 * a fresh exact check that blocks nothing and yields the same digest.
 */
export function applyApproved(
  action: ApplyAction,
  publishWith: (
    live: AppHost,
    draft: AppHost,
    options: { expect: string; draftName: string },
  ) => Promise<PublishResult>,
): Promise<DraftPublishResult & { batchId: string }> {
  return (async () => {
    const owner = await assertOwner();
    return serial(async () => {
      const batch = await syncBatch(owner);
      if (
        !batch ||
        batch.id !== action.batchId ||
        batch.draftId !== action.draftId
      )
        throw new EngineError(
          'this approval was for changes that are no longer waiting',
          'refused',
        );
      if (Number(batch.generation) !== action.generation) throw REVIEW_AGAIN();
      const host = await workingCopy(batch, owner);
      const { check, digest } = await freshCheck(batch, owner, host);
      if (digest !== action.digest) throw REVIEW_AGAIN();
      scheduler.cancel(batch.id as string);
      const result = await publishApproved(
        { draftId: action.draftId, digest: check.engineDigest as string },
        publishWith,
      );
      batch.status = 'applied';
      batch.appliedAt = new Date().toISOString();
      batch.appliedVersions = JSON.stringify(result.versions);
      batch.generation = Number(batch.generation) + 1;
      await batch.save();
      await syncFreeze(false);
      emit(batch, 'applied', 0);
      return { ...result, batchId: batch.id as string };
    });
  })();
}

// ---------- undo ----------

/**
 * The owner's Undo of an applied batch (`POST /api/shell/changes/undo`, owner
 * session route only). `expect` is the `undoDigest` the owner saw; the
 * engine's `undoBatch` takes the applied versions off and keeps records added
 * since. The owner's click is the approval. Never reachable from a tool.
 */
export function undoOwnBatch(
  batchId: unknown,
  expect: unknown,
): Promise<{ batchId: string; version: number; summary: string }> {
  return (async () => {
    const owner = await assertOwner();
    if (typeof batchId !== 'string' || !batchId)
      throw new EngineError('batchId is required', 'invalid');
    if (typeof expect !== 'string' || !expect)
      throw new EngineError('expect is required', 'invalid');
    return serial(async () => {
      const waiting = await syncBatch(owner);
      if (waiting && (await cardsOf(waiting.id as string)).some(isActive)) {
        const n = (await cardsOf(waiting.id as string)).filter(isActive).length;
        throw new EngineError(
          `Apply or discard your ${n} waiting change${n === 1 ? '' : 's'} first.`,
          'refused',
        );
      }
      const batch = await (await batches()).get(batchId);
      if (
        !batch ||
        batch.tenantId !== owner.tenantId ||
        batch.status !== 'applied'
      )
        throw new EngineError('that applied set was not found', 'not_found');
      if (batch.undoneAt)
        throw new EngineError('that was already undone', 'refused');
      const live = await getHost();
      if (expect !== undoDigestOf(batch, live.version))
        throw new EngineError(
          'the app changed since this was shown; reload and try again',
          'refused',
        );
      const result = await engine.undoBatch(principalOf(owner), live, {
        versions: readArray<number>(batch.appliedVersions),
        author: owner.id,
      });
      batch.undoneAt = new Date().toISOString();
      await batch.save();
      emit(batch, 'undone', 0);
      return {
        batchId: batch.id as string,
        version: result.version,
        summary: result.summary,
      };
    });
  })();
}
