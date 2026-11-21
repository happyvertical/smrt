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

/** The row phase 1 wrote for a migration that finishes in phase 2. */
export interface DeferredRow {
  id: string;
  /** The attempt number phase 1 recorded: the row's fence. */
  attempts: number;
  digest: string;
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

/** The phase-1 marker carrying the plan digest. */
export function phaseOneMarker(digest: string): string {
  return `${CONCURRENT_INDEX_PHASE1_MARKER} [smrt: plan sha256:${digest}]`;
}

/** Whether a recorded `error_message` says phase 1 committed. */
export function hasPhaseOneMarker(message: unknown): message is string {
  return (
    typeof message === 'string' &&
    message.startsWith(CONCURRENT_INDEX_PHASE1_MARKER)
  );
}

/** The plan digest a phase-1 marker carries, or `null` (older marker). */
export function recordedPlanDigest(message: string): string | null {
  return (
    PLAN_TAG_RE.exec(
      message.slice(CONCURRENT_INDEX_PHASE1_MARKER.length),
    )?.[1] ?? null
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
 * Checked before any statement of the retry runs.
 */
export function deferredRetryRefusal(input: {
  id: string;
  recordedMessage: string;
  digest: string;
  /** The deferred statements this run would run, or `null` when none. */
  concurrent: readonly string[] | null;
  /** Whether this run routes index DDL concurrently (`useConcurrentIndexes`). */
  concurrentRouting: boolean;
}): string | null {
  const { id } = input;
  const recorded = recordedPlanDigest(input.recordedMessage);
  const samePlan =
    recorded !== null
      ? recorded === input.digest
      : // A marker from before plans were recorded: this run's phase-1 half
        // is a subset of any earlier one only under concurrent routing.
        input.concurrent !== null && input.concurrentRouting;
  if (!samePlan || input.concurrent === null)
    return `Migration ${id} was not retried: an earlier attempt committed part of it under another statement plan (a different --postgres-safe mode, concurrent-index setting or batch), or its record does not match this migration. Nothing was run. Re-run with the options of the earlier attempt. Otherwise check by hand which of its statements took effect and revert them; --force-migration ${id} then runs it again without this check.`;
  const statements = input.concurrent;
  for (let index = 0; index < statements.length; index++) {
    const kind = retryUnsafeKind(statements[index] ?? '');
    if (kind)
      return `Migration ${id} was not retried: an earlier attempt committed part of it, and deferred statement ${index + 1} of ${statements.length} (${kind}) may already have taken effect. The tracker does not run such a statement a second time. Nothing was run. Check by hand which deferred statements took effect and revert them; --force-migration ${id} then runs every deferred statement again without this check.`;
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

/**
 * The settings a deferred statement may change that `pg_settings` does not
 * list (application-defined `a.b` settings), by name: `SET`, `RESET` and
 * `set_config` with a literal name. `null` when its changes cannot be named
 * from its text (`RESET ALL`, `DISCARD ALL`, `set_config` with a computed
 * name, or text the lexer cannot read): the tracker could not restore them.
 * Changes made inside a function body or `DO` block are not seen.
 */
export function sessionSettingTargets(sql: string): string[] | null {
  const read = readPostgresTokens(sql, { literals: true });
  if (!Array.isArray(read)) return null;
  const targets = new Set<string>();
  let start = 0;
  for (let end = 0; end <= read.length; end++) {
    const token = read[end];
    if (end < read.length && !(token?.kind === 'punct' && token.value === ';'))
      continue;
    const statement = read.slice(start, end);
    start = end + 1;
    const word = (index: number) =>
      statement[index]?.kind === 'word' ? statement[index]?.value : undefined;
    // A dotted name after SET [SESSION | LOCAL] or RESET.
    let at = word(0) === 'set' ? 1 : word(0) === 'reset' ? 1 : -1;
    if (word(0) === 'set' && (word(1) === 'session' || word(1) === 'local'))
      at = 2;
    if (word(0) === 'reset' && word(1) === 'all') return null;
    if (word(0) === 'discard' && word(1) === 'all') return null;
    const name = (index: number) => {
      const part = statement[index];
      return part?.kind === 'word' || part?.kind === 'quoted'
        ? part.value?.toLowerCase()
        : undefined;
    };
    if (
      at > 0 &&
      name(at) !== undefined &&
      statement[at + 1]?.kind === 'punct' &&
      statement[at + 1]?.value === '.' &&
      name(at + 2) !== undefined
    )
      targets.add(`${name(at)}.${name(at + 2)}`);
    for (let i = 0; i < statement.length; i++) {
      if (word(i) !== 'set_config') continue;
      const open = statement[i + 1];
      const first = statement[i + 2];
      if (!(open?.kind === 'punct' && open.value === '(')) continue;
      if (first?.kind !== 'string' || first.literal === undefined) return null;
      targets.add(first.literal.toLowerCase());
    }
  }
  return [...targets];
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
        `Migration ${id}: planned deferred statement ${index + 1} of ${concurrent.length} changes session settings that cannot be named from its text (RESET ALL, DISCARD ALL, or set_config with a computed name), so the session could not be put back after it. Nothing was run. Name each setting the statement changes instead.`,
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
  const identity = (
    await session.query(
      `SELECT session_user AS session_name, current_setting('role') AS role_name`,
    )
  ).rows[0];
  return {
    settings,
    named: values,
    sessionUser: String(identity?.session_name),
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
  if (baseline.role !== 'none')
    await session.query(`SET ROLE ${quotePostgresIdentifier(baseline.role)}`);
}

/** The advisory-lock key of one migration row's deferred phase. */
export function deferredLockKey(rowId: string): string {
  return `smrt:migration-deferred:${rowId}`;
}
