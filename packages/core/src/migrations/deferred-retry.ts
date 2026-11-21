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
  quotePostgresIdentifier,
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

/** The phase-1 marker carrying the plan digest and the not-started bit. */
export function phaseOneMarker(digest: string, notStarted: boolean): string {
  return `${CONCURRENT_INDEX_PHASE1_MARKER} [smrt: plan sha256:${digest}]${notStarted ? NOT_STARTED_TAG : ''}`;
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
  if (tag) return { kind: 'digest', digest: tag[1] as string };
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

/** Whether a marker with a plan digest says no deferred statement has run. */
export function deferredNotStarted(message: unknown): boolean {
  if (!hasPhaseOneMarker(message)) return false;
  const rest = message.slice(CONCURRENT_INDEX_PHASE1_MARKER.length);
  const plan = PLAN_TAG_RE.exec(rest);
  return plan !== null && rest.startsWith(NOT_STARTED_TAG, plan[0].length);
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
 * VALIDATE CONSTRAINT`, one plain `SET` / `RESET`), otherwise why not.
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
  if (first === 'set' || first === 'reset') return null;
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

type ReadStatement = Array<{ kind: string; value?: string; literal?: string }>;

const isPunct = (token: ReadStatement[number] | undefined, value: string) =>
  token?.kind === 'punct' && token.value === value;
const isName = (token: ReadStatement[number] | undefined) =>
  token?.kind === 'word' || token?.kind === 'quoted';

/**
 * The settings a deferred statement may change that `pg_settings` does not
 * list (application-defined `a.b` settings), by name: the complete target of
 * a leading `SET [SESSION | LOCAL]` or `RESET` (dotted, any part quoted, or
 * one quoted name holding the dot), and the first argument of every
 * `set_config(...)` call (function name quoted or qualified or not), which
 * must be one plain string literal followed by its comma. `null` when a
 * target is not read completely (`RESET ALL`, `DISCARD ALL`, a computed,
 * concatenated or escaped `set_config` name, a target in another shape, or
 * text the lexer cannot read): the tracker could not restore what it
 * changes. Changes made inside a function body or `DO` block are not seen.
 */
export function sessionSettingTargets(sql: string): string[] | null {
  const read = readPostgresTokens(sql, { literals: true });
  if (!Array.isArray(read)) return null;
  const targets = new Set<string>();
  let start = 0;
  for (let end = 0; end <= read.length; end++) {
    if (end < read.length && !isPunct(read[end], ';')) continue;
    const found = statementSettingTargets(read.slice(start, end));
    start = end + 1;
    if (found === null) return null;
    for (const target of found) targets.add(target);
  }
  return [...targets];
}

/** {@link sessionSettingTargets} of one statement's tokens. */
function statementSettingTargets(statement: ReadStatement): string[] | null {
  const word = (index: number) =>
    statement[index]?.kind === 'word' ? statement[index]?.value : undefined;
  const targets: string[] = [];
  const lead = word(0);
  if (lead === 'discard' && word(1) === 'all') return null;
  if (lead === 'reset' && word(1) === 'all') return null;
  if (lead === 'set' || lead === 'reset') {
    // `SET SESSION x` / `SET LOCAL x`, but `SET session.x` names a setting.
    const scoped =
      lead === 'set' &&
      (word(1) === 'session' || word(1) === 'local') &&
      !isPunct(statement[2], '.');
    const target = readSettingName(statement, scoped ? 2 : 1);
    if (!target) return null;
    // A name without a dot is a built-in setting, which pg_settings lists.
    if (target.name.includes('.')) {
      const next = statement[target.end];
      const complete =
        lead === 'reset'
          ? target.end === statement.length
          : isPunct(next, '=') || word(target.end) === 'to';
      if (!complete) return null;
      targets.push(target.name);
    }
  }
  for (let i = 0; i < statement.length; i++) {
    const token = statement[i];
    if (!isName(token) || token?.value?.toLowerCase() !== 'set_config')
      continue;
    if (!isPunct(statement[i + 1], '(')) continue;
    const name = statement[i + 2];
    if (
      name?.kind !== 'string' ||
      name.literal === undefined ||
      name.literal.includes('\\') ||
      !isPunct(statement[i + 3], ',')
    )
      return null;
    targets.push(name.literal.toLowerCase());
  }
  return targets;
}

/**
 * A setting name starting at `at`: one or more names (word or quoted)
 * joined by dots, case-folded as PostgreSQL compares setting names; `null`
 * when there is none.
 */
function readSettingName(
  statement: ReadStatement,
  at: number,
): { name: string; end: number } | null {
  if (!isName(statement[at])) return null;
  const parts = [String(statement[at]?.value).toLowerCase()];
  let end = at + 1;
  while (isPunct(statement[end], '.')) {
    if (!isName(statement[end + 1])) return null;
    parts.push(String(statement[end + 1]?.value).toLowerCase());
    end += 2;
  }
  return { name: parts.join('.'), end };
}

/**
 * The named settings a migration's deferred statements change; throws,
 * before anything runs, when one changes settings that cannot be named, so
 * the session could not be put back after it.
 */
export function deferredSessionTargets(
  id: string,
  concurrent: readonly string[],
): string[] {
  const all = new Set<string>();
  concurrent.forEach((sql, index) => {
    const targets = sessionSettingTargets(sql);
    if (targets === null)
      throw new Error(
        `Migration ${id}: planned deferred statement ${index + 1} of ${concurrent.length} changes session settings that cannot be named from its text (RESET ALL, DISCARD ALL, a set_config whose name is not one plain string, a SET or RESET target in another shape, or text that cannot be read), so the session could not be put back after it. Nothing was run. Name each setting the statement changes, plainly, instead.`,
      );
    for (const target of targets) all.add(target);
  });
  return [...all];
}

/** The session state a migration session was handed, before any statement. */
export interface SessionBaseline {
  /** `pg_settings` rows set in the session, by name (identity excluded). */
  settings: Map<string, string>;
  /** Each named setting's value, `null` while it was not defined. */
  named: Map<string, string | null>;
  sessionUser: string;
  /** `current_user` as handed over (the role in effect). */
  currentUser: string;
  role: string;
}

async function sessionSettings(
  session: SessionLike,
): Promise<Map<string, string>> {
  return new Map(
    (
      await session.query(
        `SELECT name, setting FROM pg_settings
          WHERE source = 'session' AND name NOT IN ('role', 'session_authorization')
          ORDER BY name`,
      )
    ).rows.map((row) => [String(row.name), String(row.setting)]),
  );
}

async function namedSetting(
  session: SessionLike,
  name: string,
): Promise<string | null> {
  const value = (
    await session.query('SELECT current_setting(?, true) AS value', name)
  ).rows[0]?.value;
  return value === null || value === undefined ? null : String(value);
}

/**
 * Read the session's own settings and identity, and the current value of
 * each setting in `named` (the {@link sessionSettingTargets} of the
 * statements that will run on it).
 */
export async function captureSessionBaseline(
  session: SessionLike,
  named: readonly string[] = [],
): Promise<SessionBaseline> {
  const settings = await sessionSettings(session);
  const values = new Map<string, string | null>();
  for (const name of named) values.set(name, await namedSetting(session, name));
  const identity = await readIdentity(session);
  return { settings, named: values, ...identity };
}

async function readIdentity(
  session: SessionLike,
): Promise<{ sessionUser: string; currentUser: string; role: string }> {
  const identity = (
    await session.query(
      `SELECT session_user AS session_name, current_user AS current_name, current_setting('role') AS role_name`,
    )
  ).rows[0];
  return {
    sessionUser: String(identity?.session_name),
    currentUser: String(identity?.current_name),
    role: String(identity?.role_name),
  };
}

/**
 * Put the session back as it was handed over: every setting and identity a
 * deferred statement changed is undone, the caller's own are kept. Nothing
 * is reset wholesale (a blanket reset would also clear caller settings that
 * cannot be read back). The session user's privileges come back first, so a
 * restricted setting can be restored, and the caller's role last.
 */
export async function restoreSessionBaseline(
  session: SessionLike,
  baseline: SessionBaseline,
): Promise<void> {
  await session.query('RESET ROLE');
  const user = async () =>
    String(
      (await session.query('SELECT session_user AS session_name')).rows[0]
        ?.session_name,
    );
  if ((await user()) !== baseline.sessionUser) {
    await session.query('RESET SESSION AUTHORIZATION');
    if ((await user()) !== baseline.sessionUser)
      await session.query(
        `SET SESSION AUTHORIZATION ${quotePostgresIdentifier(baseline.sessionUser)}`,
      );
  }
  const now = await sessionSettings(session);
  for (const name of now.keys())
    if (!baseline.settings.has(name))
      await session.query(`RESET ${quotePostgresIdentifier(name)}`);
  for (const [name, setting] of baseline.settings)
    if (now.get(name) !== setting)
      await session.query('SELECT set_config(?, ?, false)', name, setting);
  for (const [name, value] of baseline.named) {
    if ((await namedSetting(session, name)) === value) continue;
    // A setting first defined by a deferred statement cannot be undefined
    // again; it is reset to empty.
    if (value === null)
      await session.query(
        `RESET ${name.split('.').map(quotePostgresIdentifier).join('.')}`,
      );
    else await session.query('SELECT set_config(?, ?, false)', name, value);
  }
  // `RESET ROLE` returns to a role configured at login, so `none` is set
  // explicitly.
  await session.query(
    baseline.role === 'none'
      ? 'SET ROLE NONE'
      : `SET ROLE ${quotePostgresIdentifier(baseline.role)}`,
  );
  // Fail closed: a session that is not back as handed over is never used
  // again by the tracker or handed back as if it were.
  const identity = await readIdentity(session);
  let restored =
    identity.sessionUser === baseline.sessionUser &&
    identity.currentUser === baseline.currentUser &&
    identity.role === baseline.role;
  for (const [name, value] of baseline.named) {
    const now = await namedSetting(session, name);
    if (now !== value && !(value === null && now === '')) restored = false;
  }
  if (!restored)
    throw new Error(
      'The migration session could not be put back as it was handed over (its identity or a setting a deferred statement named differs).',
    );
}

/** The advisory-lock key of one migration row's deferred phase. */
export function deferredLockKey(rowId: string): string {
  return `smrt:migration-deferred:${rowId}`;
}
