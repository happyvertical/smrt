/**
 * Retrying the deferred phase of a `--postgres-safe` migration (#5325).
 *
 * Phase 1 commits a migration's transaction-safe statements; phase 2 runs the
 * rest one by one, each committing as it runs. Nothing records how far phase 2
 * got, so a retry may run again only statements whose second run is harmless,
 * and only under the plan the earlier attempt followed. Internal.
 */
import { createHash } from 'node:crypto';
import {
  classifyIndexStatement,
  readPostgresTokens,
} from './postgres-create-index.js';

/**
 * Prefix stamped on the `error_message` of every concurrent-index migration
 * whose transactional half has already committed: the only durable record
 * that phase 1 ran. Carried by the interim write at the end of phase 1 and by
 * every failure recorded during phase 2.
 */
export const CONCURRENT_INDEX_PHASE1_MARKER =
  '[smrt: concurrent-index phase 1 committed]';

const PLAN_TAG_RE = /^ \[smrt: plan sha256:([0-9a-f]{64})\]/;

/**
 * Written with the marker when phase 1 runs, kept until this row's first
 * deferred statement is about to run: while present, no deferred statement
 * of the row has run, so a retry may run them all.
 */
const NOT_STARTED_TAG = ' [smrt: deferred not started]';

/**
 * Ends the tracker's own tags: diagnostic text (a failure message, which an
 * authored statement can choose) is written only after it, so it never
 * stands where a tag is read.
 */
const TEXT_SEPARATOR = ' | ';

/** The row phase 1 wrote for a migration that finishes in phase 2. */
export interface DeferredRow {
  id: string;
  /** The attempt number phase 1 recorded: the row's fence. */
  attempts: number;
  digest: string;
  /** Whether the record still says no deferred statement has run. */
  notStarted: boolean;
}

/**
 * The plan a migration runs under: its id, checksum, phase-1 statements and
 * phase-2 statements as planned (after the CONCURRENTLY and swap rewrites).
 */
export function planDigest(
  id: string,
  checksum: string,
  regular: readonly string[],
  concurrent: readonly string[],
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([id, checksum, regular, '\0phase-boundary\0', concurrent]),
    )
    .digest('hex');
}

/**
 * A phase-1 record: the marker, the plan digest, the not-started bit, then
 * the tracker-owned separator and the diagnostic text.
 */
export function phaseOneMessage(
  digest: string,
  notStarted: boolean,
  text: string,
): string {
  return `${CONCURRENT_INDEX_PHASE1_MARKER} [smrt: plan sha256:${digest}]${notStarted ? NOT_STARTED_TAG : ''}${TEXT_SEPARATOR}${text}`;
}

/**
 * A failure message as the tracker records it outside a phase-1 record: one
 * that begins with a tracker tag is prefixed, so it never reads as one.
 */
export function diagnosticText(message: string): string {
  return message.startsWith('[smrt:') ? `error: ${message}` : message;
}

/** Whether a recorded `error_message` says phase 1 committed. */
export function hasPhaseOneMarker(message: unknown): message is string {
  return (
    typeof message === 'string' &&
    message.startsWith(CONCURRENT_INDEX_PHASE1_MARKER)
  );
}

/**
 * The plan a phase-1 marker records: its digest; `absent` for a marker
 * written before plans were recorded; `malformed` for a plan tag that is not
 * a whole sha256 digest, which never counts as either.
 */
export type RecordedPlan =
  | { kind: 'digest'; digest: string }
  | { kind: 'absent' }
  | { kind: 'malformed' };

/**
 * Anything that looks like a damaged reserved tag: a bracket, the `smrt`
 * introducer or a digest label, in any spacing or case.
 */
const DAMAGED_TAG_RE = /\[|\bsmrt\b|plan\s*sha|sha256/i;

export function recordedPlan(message: string): RecordedPlan {
  const rest = message.slice(CONCURRENT_INDEX_PHASE1_MARKER.length);
  const tag = PLAN_TAG_RE.exec(rest);
  if (tag)
    // The tags end at the separator (or the end): anything else is damaged.
    return tagsEnd(rest, tag[0].length) !== null
      ? { kind: 'digest', digest: tag[1] as string }
      : { kind: 'malformed' };
  // An older smrt wrote the marker, one space, then its message (never a
  // tag). Anything else after the marker is a damaged tag, not an old record.
  const legacy = /^ (\S.*)$/s.exec(rest);
  return legacy && !DAMAGED_TAG_RE.test(legacy[1]?.slice(0, 40) ?? '')
    ? { kind: 'absent' }
    : { kind: 'malformed' };
}

/** The plan digest a phase-1 marker carries, or `null`. */
export function recordedPlanDigest(message: string): string | null {
  const plan = recordedPlan(message);
  return plan.kind === 'digest' ? plan.digest : null;
}

/** Whether every deferred statement may run a second time. */
function everyRetrySafe(concurrent: readonly string[]): boolean {
  return concurrent.every((sql) => retryUnsafeKind(sql) === null);
}

/**
 * Where the tags after the plan tag (at `at`) end: the not-started bit, if
 * present, then the separator or the end of the record. `notStarted` says
 * whether the bit is there; `null` when the tags do not end that way.
 */
function tagsEnd(rest: string, at: number): { notStarted: boolean } | null {
  const ends = (from: number) =>
    from === rest.length || rest.startsWith(TEXT_SEPARATOR, from);
  if (rest.startsWith(NOT_STARTED_TAG, at))
    return ends(at + NOT_STARTED_TAG.length) ? { notStarted: true } : null;
  return ends(at) ? { notStarted: false } : null;
}

/**
 * Whether a marker with a plan digest says no deferred statement has run.
 * Read from the tracker's own tags only, never from the text after them.
 */
export function deferredNotStarted(message: unknown): boolean {
  if (!hasPhaseOneMarker(message)) return false;
  const rest = message.slice(CONCURRENT_INDEX_PHASE1_MARKER.length);
  const plan = PLAN_TAG_RE.exec(rest);
  return plan !== null && tagsEnd(rest, plan[0].length)?.notStarted === true;
}

/**
 * Whether the recorded marker's plan is this run's plan, so skipping phase 1
 * skips exactly what committed. A malformed plan tag never counts.
 *
 * A marker from before plans were recorded counts only under concurrent
 * routing, only for a deferred list that may run again in full, and only
 * when skipping phase 1 skips nothing or the migration is forced by name.
 * The earlier attempt's phase boundary is not known: a statement now
 * deferred may have committed in its phase 1 (hence the harmless list), and
 * the planner of the time read `VALIDATE CONSTRAINT` in comments, which the
 * checksum leaves out, so a statement now in phase 1 may have been deferred
 * and never run. Forcing it by name is the operator's word that the first
 * half took effect.
 */
export function retryPlanMatches(input: {
  recordedMessage: string;
  digest: string;
  regular: readonly string[];
  concurrent: readonly string[];
  concurrentRouting: boolean;
  forced: boolean;
}): boolean {
  if (input.concurrent.length === 0) return false;
  const recorded = recordedPlan(input.recordedMessage);
  if (recorded.kind === 'digest') return recorded.digest === input.digest;
  return (
    recorded.kind === 'absent' &&
    input.concurrentRouting &&
    everyRetrySafe(input.concurrent) &&
    (input.regular.length === 0 || input.forced)
  );
}

/**
 * Whether only the first half stands between a pre-plan record and a retry:
 * routed concurrently, every deferred statement harmless, but a first half
 * to skip whose boundary the record cannot establish.
 */
function legacyFirstHalfUnknown(input: {
  recordedMessage: string;
  regular: readonly string[];
  concurrent: readonly string[];
  concurrentRouting: boolean;
}): boolean {
  return (
    recordedPlan(input.recordedMessage).kind === 'absent' &&
    input.concurrentRouting &&
    input.concurrent.length > 0 &&
    everyRetrySafe(input.concurrent) &&
    input.regular.length > 0
  );
}

/** Why a deferred statement cannot run a second time; a closed set. */
export type RetryUnsafeKind = 'data change' | 'table change' | 'other';

const DATA_CHANGE_WORDS = new Set([
  'insert',
  'update',
  'delete',
  'merge',
  'copy',
  'truncate',
]);

/**
 * Whether a deferred statement may run again on a retry: `null` when its
 * second run is harmless (index DDL the lexer reads, one `ALTER TABLE …
 * VALIDATE CONSTRAINT`), otherwise why not.
 * Read by the PostgreSQL lexer; a string holding more than one statement, or
 * text it cannot read, is never harmless.
 */
export function retryUnsafeKind(sql: string): RetryUnsafeKind | null {
  const read = readPostgresTokens(sql);
  if (!Array.isArray(read)) return 'other';
  const tokens =
    read.at(-1)?.kind === 'punct' && read.at(-1)?.value === ';'
      ? read.slice(0, -1)
      : read;
  if (tokens.some((token) => token.kind === 'punct' && token.value === ';'))
    return 'other';
  const word = (index: number) =>
    tokens[index]?.kind === 'word' ? tokens[index]?.value : undefined;
  const first = word(0);
  if (first === undefined) return 'other';
  const index = classifyIndexStatement(sql).kind;
  if (
    index === 'create-index' ||
    index === 'drop-index' ||
    index === 'reindex' ||
    index === 'alter-index-rename'
  )
    return null;
  if (DATA_CHANGE_WORDS.has(first)) return 'data change';
  if (first === 'alter' && word(1) === 'table')
    return isValidateConstraint(tokens) ? null : 'table change';
  return 'other';
}

type ReadToken = { kind: string; value?: string };

/** `ALTER TABLE [IF EXISTS] [ONLY] [schema.]table VALIDATE CONSTRAINT name`. */
function isValidateConstraint(tokens: ReadToken[]): boolean {
  let i = 2;
  const isWord = (value: string) =>
    tokens[i]?.kind === 'word' && tokens[i]?.value === value;
  const isName = () =>
    tokens[i]?.kind === 'word' || tokens[i]?.kind === 'quoted';
  if (isWord('if')) {
    i += 1;
    if (!isWord('exists')) return false;
    i += 1;
  }
  if (isWord('only')) i += 1;
  if (!isName()) return false;
  i += 1;
  if (tokens[i]?.kind === 'punct' && tokens[i]?.value === '.') {
    i += 1;
    if (!isName()) return false;
    i += 1;
  }
  if (!isWord('validate')) return false;
  i += 1;
  if (!isWord('constraint')) return false;
  i += 1;
  if (!isName()) return false;
  return i + 1 === tokens.length;
}

/**
 * Why a retry of a migration whose phase 1 committed must not run, or `null`.
 * Checked before any statement of the retry runs. A migration forced by name
 * is never refused: under the recorded plan it replays the deferred list
 * from its start; otherwise the caller runs it from its first statement.
 */
export function deferredRetryRefusal(input: {
  id: string;
  recordedMessage: string;
  /** Whether this run's checksum is the one the earlier attempt recorded. */
  sameChecksum: boolean;
  /** {@link retryPlanMatches} for this run. */
  samePlan: boolean;
  /** The first-half statements this run would skip after phase 1. */
  regular: readonly string[];
  /** The deferred statements this run would run. */
  concurrent: readonly string[];
  /** Whether this run routes index DDL concurrently. */
  concurrentRouting: boolean;
  forced: boolean;
}): string | null {
  const { id } = input;
  if (input.forced) return null;
  const numbering =
    'Deferred statements are numbered as planned: the first half is not counted, and one unique-index recreate counts as three.';
  const fullRemedy = `revert by hand what that attempt applied, in both halves, and --force-migration ${id} then runs the migration again from its first statement.`;
  if (!input.sameChecksum)
    return `Migration ${id} was not retried: it changed since an earlier attempt committed part of it. Nothing was run. Restore the definition the earlier attempt ran; otherwise, ${fullRemedy}`;
  const recorded = recordedPlan(input.recordedMessage);
  if (recorded.kind === 'malformed')
    return `Migration ${id} was not retried: the record of an earlier attempt that committed part of it is unreadable, so the part that committed is not known. Nothing was run. To retry it, ${fullRemedy}`;
  const unsafe = firstRetryUnsafe(input.concurrent);
  if (!input.samePlan && recorded.kind === 'absent' && unsafe)
    return `Migration ${id} was not retried: an earlier attempt committed part of it before statement plans were recorded, so which of its statements committed is not known, and ${unsafe} may already have taken effect. Nothing was run. To retry it, ${fullRemedy} ${numbering}`;
  if (!input.samePlan && legacyFirstHalfUnknown(input))
    return `Migration ${id} was not retried: an earlier attempt committed part of it before statement plans were recorded, so where its first half ended is not known, and a first-half statement may never have run. Nothing was run. Check that each first-half statement took effect, and run by hand any that did not; --force-migration ${id} then runs its deferred statements again (they are all safe to run twice), not its first half.`;
  if (!input.samePlan)
    return `Migration ${id} was not retried: an earlier attempt committed part of it under another statement plan (a different --postgres-safe mode, concurrent-index setting, or set of migrations run with it), or its record does not match this migration. Nothing was run. Re-run with the options and migrations of the earlier attempt; or ${fullRemedy}`;
  // The record says none of its deferred statements has run yet.
  if (deferredNotStarted(input.recordedMessage)) return null;
  if (unsafe)
    return `Migration ${id} was not retried: an earlier attempt committed part of it, and ${unsafe} may already have taken effect. The tracker does not run such a statement a second time. Nothing was run. Revert by hand the deferred statements that took effect; --force-migration ${id} then runs every deferred statement again (its committed first half is not run again). ${numbering}`;
  return null;
}

/**
 * The first deferred statement that may not run a second time, described by
 * its place in the planned deferred list. That numbering is not the authored
 * one: the list leaves out the statements that run in the first half, and one
 * unique-index recreate becomes three statements. `null` when there is none.
 */
function firstRetryUnsafe(concurrent: readonly string[]): string | null {
  for (let index = 0; index < concurrent.length; index++) {
    const kind = retryUnsafeKind(concurrent[index] ?? '');
    if (kind)
      return `planned deferred statement ${index + 1} of ${concurrent.length} (${kind})`;
  }
  return null;
}

/** A pinned session, as the tracker's concurrent phase uses it. */
interface SessionLike {
  query: (
    sql: string,
    ...vars: unknown[]
  ) => Promise<{ rows: Record<string, unknown>[] }>;
}

type ReadStatement = Array<{ kind: string; value?: string }>;

const isPunct = (token: ReadStatement[number] | undefined, value: string) =>
  token?.kind === 'punct' && token.value === value;
const isName = (token: ReadStatement[number] | undefined) =>
  token?.kind === 'word' || token?.kind === 'quoted';

/**
 * Words after which `set_config (` names a relation (an index, table or
 * foreign-key target), not a call.
 */
const RELATION_INTRODUCERS = new Set([
  'on',
  'only',
  'into',
  'table',
  'references',
  'exists',
]);

/**
 * Whether a deferred statement may change session state, or cannot be read
 * whole: a `SET` (`SET LOCAL`, `SET ROLE`, `SET SESSION AUTHORIZATION`
 * included), `RESET`, `DISCARD`, or a `set_config(...)` call anywhere in it.
 * `set_config` followed by a column list after `ON`, `INTO`, `TABLE`,
 * `REFERENCES` or the like names a relation and is not a call. Changes made
 * inside a function body or `DO` block are not seen.
 */
export function changesSessionState(sql: string): boolean {
  const read = readPostgresTokens(sql);
  if (!Array.isArray(read)) return true;
  let start = 0;
  for (let end = 0; end <= read.length; end++) {
    if (end < read.length && !isPunct(read[end], ';')) continue;
    if (statementChangesSession(read.slice(start, end))) return true;
    start = end + 1;
  }
  return false;
}

/** {@link changesSessionState} of one statement's tokens. */
function statementChangesSession(statement: ReadStatement): boolean {
  const lead = statement[0]?.kind === 'word' ? statement[0].value : undefined;
  if (lead === 'set' || lead === 'reset' || lead === 'discard') return true;
  for (let i = 0; i < statement.length; i++) {
    const token = statement[i];
    if (!isName(token) || token?.value?.toLowerCase() !== 'set_config')
      continue;
    if (!isPunct(statement[i + 1], '(')) continue;
    // Skip a qualifier (`schema.set_config`) to the word before the name.
    let before = i - 1;
    if (isPunct(statement[before], '.') && isName(statement[before - 1]))
      before -= 2;
    const introducer = statement[before];
    if (
      introducer?.kind === 'word' &&
      RELATION_INTRODUCERS.has(String(introducer.value)) &&
      (introducer.value !== 'on' || isIndexStatement(statement))
    )
      continue;
    return true;
  }
  return false;
}

/**
 * `CREATE [UNIQUE] INDEX`: its expressions and predicate take only immutable
 * functions, so `ON set_config (` names its table.
 */
function isIndexStatement(statement: ReadStatement): boolean {
  const word = (index: number) =>
    statement[index]?.kind === 'word' ? statement[index]?.value : undefined;
  return (
    word(0) === 'create' &&
    (word(1) === 'index' || (word(1) === 'unique' && word(2) === 'index'))
  );
}

/**
 * Refuses, before anything runs, a migration whose deferred statements may
 * change session state: they run outside the migration's transaction, on a
 * session the tracker hands back, so they may not change it.
 */
export function assertNoDeferredSessionChange(
  id: string,
  concurrent: readonly string[],
): void {
  concurrent.forEach((sql, index) => {
    if (changesSessionState(sql))
      throw new Error(
        `Migration ${id}: planned deferred statement ${index + 1} of ${concurrent.length} changes session state (SET, SET LOCAL, SET ROLE, SET SESSION AUTHORIZATION, RESET, DISCARD or set_config), or its text cannot be read whole. Deferred statements run outside the migration's transaction, on a session the tracker hands back, so they may not change it. Nothing was run. Move the statement ahead of the migration's first VALIDATE CONSTRAINT (as SET LOCAL, scoped to its transaction), or into a migration of its own.`,
      );
  });
}

/** The settings the tracker itself sets on a migration session. */
const TRACKER_SETTINGS = ['lock_timeout', 'statement_timeout'];

/** The session state a migration session was handed, before any statement. */
export interface SessionBaseline {
  /** Each tracker setting's value, and whether the session had set it. */
  trackerSettings: Array<{ name: string; setting: string; session: boolean }>;
  sessionUser: string;
  currentUser: string;
  searchPath: string;
}

async function readIdentity(
  session: SessionLike,
): Promise<Omit<SessionBaseline, 'trackerSettings'>> {
  const identity = (
    await session.query(
      `SELECT session_user AS session_name, current_user AS current_name, pg_catalog.current_setting('search_path') AS search_path`,
    )
  ).rows[0];
  return {
    sessionUser: String(identity?.session_name),
    currentUser: String(identity?.current_name),
    searchPath: String(identity?.search_path),
  };
}

/**
 * Read, before the tracker sets anything, the tracker settings' values and
 * the session's identity and `search_path`.
 */
export async function captureSessionBaseline(
  session: SessionLike,
): Promise<SessionBaseline> {
  const settings = (
    await session.query(
      `SELECT name, setting, source FROM pg_catalog.pg_settings
        WHERE name IN (${TRACKER_SETTINGS.map((name) => `'${name}'`).join(', ')})
        ORDER BY name`,
    )
  ).rows.map((row) => ({
    name: String(row.name),
    setting: String(row.setting),
    session: row.source === 'session',
  }));
  return { trackerSettings: settings, ...(await readIdentity(session)) };
}

/**
 * Fail closed when the session's identity or `search_path` is no longer what
 * it was handed over with: no deferred statement may change them, so a
 * difference means something the tracker cannot undo.
 */
export async function assertSessionUnchanged(
  session: SessionLike,
  baseline: SessionBaseline,
): Promise<void> {
  const now = await readIdentity(session);
  if (
    now.sessionUser !== baseline.sessionUser ||
    now.currentUser !== baseline.currentUser ||
    now.searchPath !== baseline.searchPath
  )
    throw new Error(
      'The migration session is not as it was handed over (its user, role or search_path differs), and the tracker does not change them back.',
    );
}

/**
 * Put back what the tracker itself set (its timeouts), then check the
 * session's identity and `search_path`. Nothing else is reset: deferred
 * statements may not change session state.
 */
export async function restoreSessionBaseline(
  session: SessionLike,
  baseline: SessionBaseline,
): Promise<void> {
  for (const { name, setting, session: set } of baseline.trackerSettings)
    await session.query(
      set ? 'SELECT pg_catalog.set_config(?, ?, false)' : `RESET ${name}`,
      ...(set ? [name, setting] : []),
    );
  await assertSessionUnchanged(session, baseline);
}

/** The advisory-lock key of one migration row's deferred phase. */
export function deferredLockKey(rowId: string): string {
  return `smrt:migration-deferred:${rowId}`;
}
