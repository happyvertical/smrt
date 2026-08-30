/**
 * Adapter-agnostic change feed — the framework's change-observation spine
 * (issue #1758, parent PRD #1755).
 *
 * Every framework `save()`/`delete()` appends exactly one row to the
 * `_smrt_changes` system table (monotonic per-database sequence, table name,
 * row id, operation, tenant id, timestamp). Deletes are recorded as
 * tombstones (`operation: 'delete'`), distinguishable from updates. One read
 * interface — {@link getChangesSince} — returns changes after a cursor,
 * filterable by table and tenant, and serves three eventual consumers:
 * client delta pull, the SSE push channel, and the per-table version source
 * backing ETags.
 *
 * ## Cursor semantics (the precise guarantee)
 *
 * Sequences are allocated *inside* the append statement as
 * `COALESCE(MAX(seq), 0) + 1` over the feed table itself, with a retry on
 * primary-key conflict. `MAX(seq)` only observes committed rows, so a row
 * with sequence `N` can only be inserted while every row with sequence
 * `< N` is already committed (a conflicting in-flight allocation of the same
 * value blocks, then retries). Committed rows therefore always form a
 * contiguous run ending at `MAX(seq)` — the **committed horizon**. Sequence
 * order equals commit order; out-of-order commit visibility (the classic
 * MVCC race that makes native identity/serial columns unsafe as cursors
 * under concurrent writers) cannot occur.
 *
 * {@link getChangesSince} reads the committed horizon `H = MAX(seq)`, then
 * returns matching rows with `since < seq <= H` (bounded by `limit`), and a
 * `cursor` that is either `H` (page exhaustive) or the last returned `seq`
 * (page limited). Because no change can ever commit at or below an observed
 * horizon after it was observed, polling with returned cursors misses no
 * committed change and never returns the same change twice — under any
 * number of concurrent writers, identically on SQLite, Postgres and DuckDB.
 * This is the design reason the allocator is `MAX+1` rather than a native
 * AUTOINCREMENT/identity column: identity values are allocated before
 * commit, so a reader on Postgres could observe seq 101 while seq 100 is
 * still uncommitted and advance its cursor past it. (No shared
 * auto-increment mechanism exists in the system-table schema path either;
 * see `system/schema.ts`.)
 *
 * Contention note: appends serialize on the head of the log. Each append is
 * one small INSERT (issued from the write path *after* the user's row was
 * written), so the serialization window is one statement; conflicts resolve
 * with a bounded retry loop and are impossible on single-writer engines
 * (SQLite). PostgreSQL invokes that INSERT through the framework-owned
 * `_smrt_append_change` function so failure isolation remains one statement.
 *
 * ## Failure semantics
 *
 * A feed-write failure must never fail the user's write. The interceptor
 * wraps the append in a try/catch: on failure it logs a warning (deduped per
 * database) and continues. The trade-off is availability of the user's
 * write over completeness of the feed — consumers already need a
 * full-resync path for cursors older than the retention window, and the
 * same path covers a (rare) dropped feed row. PostgreSQL runs the INSERT in a
 * PL/pgSQL exception subtransaction and returns a caught SQLSTATE as data;
 * JavaScript only throws/logs after PostgreSQL has restored the caller's
 * transaction, so a swallowed append failure cannot surface later as 25P02.
 * The append still joins a caller-managed transaction on the same handle and
 * shares its fate (a rollback removes the change row with the data row).
 *
 * ## Known gaps (documented in the PRD)
 *
 * - Writes that bypass framework mutation paths (raw SQL) are invisible to
 *   the feed — the same accepted gap as the #1499 collection cache.
 *   {@link bumpChangeFeed} is the manual escape hatch: out-of-band writers
 *   append a synthetic change row for the affected table.
 * - **Spurious `update` entries**: `SmrtObject.save()` has no dirty-check,
 *   so a field-unchanged `.save()` still appends an `update` row. This is
 *   by design — the writer observes writes, not diffs (it has no old-row
 *   access), so the feed faithfully mirrors the write path. Diff-aware
 *   paths (`getOrUpsert()`'s diff guard, the sync-apply endpoint's no-op
 *   detection) short-circuit before `save()` and append nothing.
 *   Subscribers must tolerate spurious entries; they are convergent — a
 *   re-fetch returns identical data.
 *
 * ## Retention
 *
 * The log is append-only and grows with write volume. {@link pruneChangeFeed}
 * bounds it by age (`maxAgeMs`) and/or row count (`maxRows`); call it from a
 * scheduled job sized so the retention window comfortably exceeds the
 * slowest consumer's polling interval. Pruning deletes oldest-first and
 * always retains the newest entry, so retained sequences stay a contiguous
 * `[floor..horizon]` run — which is how {@link getChangesSince} *detects* a
 * consumer whose cursor predates the retained window and answers it with
 * `resyncRequired: true` plus a fresh resume cursor instead of silently
 * skipping the pruned changes.
 *
 * @see https://github.com/happyvertical/smrt/issues/1758
 * @packageDocumentation
 */

import { createLogger } from '@happyvertical/logger';
import type { DatabaseInterface } from '@happyvertical/sql';
import { publishChangeSignal } from './change-signals.js';
import { resolveDbCacheKey } from './collection-cache.js';
import { resolveDispatchTenantScope } from './dispatch/tenant-resolver.js';
import {
  isEmbeddedDatabase,
  withEmbeddedWriteQueue,
} from './embedded-write-queue.js';
import { GlobalInterceptors, type InterceptorContext } from './interceptors.js';
import type { SmrtObject } from './object.js';
import { detectEngine } from './schema/ddl/index.js';
import { SYSTEM_TABLE_NAMES } from './schema/system-table-shapes.js';
import {
  CREATE_SMRT_CHANGES_TABLE,
  ENSURE_POSTGRES_CHANGE_FEED_APPEND_FUNCTION,
  ENSURE_POSTGRES_CHANGE_FEED_SCHEMA,
  FRAMEWORK_OPERATIONAL_TABLES,
  POSTGRES_CHANGE_FEED_APPEND_FUNCTION_IDENTITY,
  POSTGRES_CHANGE_FEED_APPEND_FUNCTION_NAME,
  REPLACE_POSTGRES_CHANGE_FEED_APPEND_FUNCTION,
  RETIRED_SYSTEM_TABLES,
} from './system/schema.js';
import { toSafeInteger } from './utils/safe-integer.js';

const logger = createLogger({ level: 'info' });

/** Name of the append-only change-feed system table. */
export const CHANGE_FEED_TABLE = '_smrt_changes';

/**
 * Tables the change-feed writer never records (issue #2376).
 *
 * The writer used to skip every table whose name started with `_smrt_`. That
 * prefix stopped meaning "framework bookkeeping" once packages began naming
 * their *domain* tables `_smrt_feature_overrides`, `_smrt_prompt_overrides`,
 * `_smrt_subscription_plans`, `_smrt_report_schedules`, `_smrt_field_policies`
 * and ~20 more: clients syncing those through `_changes` never saw an update.
 *
 * The exclusion is now an allowlist of tables the framework actually owns —
 * the hand-written bookkeeping DDL ({@link SYSTEM_TABLE_NAMES}, which includes
 * the feed's own table so it can never observe itself), the model-backed
 * operational plumbing ({@link FRAMEWORK_OPERATIONAL_TABLES}), and the retired
 * system tables that may still exist on older databases.
 */
export const CHANGE_FEED_EXCLUDED_TABLES: ReadonlySet<string> = new Set([
  ...SYSTEM_TABLE_NAMES,
  ...FRAMEWORK_OPERATIONAL_TABLES,
  ...RETIRED_SYSTEM_TABLES,
]);

/**
 * Whether framework writes to `tableName` are recorded in the change feed.
 *
 * Exported so tooling and tests can reason about feed coverage without
 * re-deriving the rule. See {@link CHANGE_FEED_EXCLUDED_TABLES}.
 */
export function isChangeFeedObservableTable(tableName: string): boolean {
  return Boolean(tableName) && !CHANGE_FEED_EXCLUDED_TABLES.has(tableName);
}

/** Interceptor name of the framework's change-feed writer. */
export const CHANGE_FEED_INTERCEPTOR_NAME = 'smrt-change-feed';

/**
 * Change operations recorded in the feed. Deletes are tombstones —
 * consumers can distinguish "row changed" from "row is gone" without
 * consulting the source table.
 */
export type ChangeOperation = 'create' | 'update' | 'delete';

/** One entry of the change feed. */
export interface ChangeFeedEntry {
  /** Strictly monotonic per-database sequence (the cursor dimension). */
  seq: number;
  /** Physical table the change happened in (STI children report the shared base table). */
  table: string;
  /**
   * Primary key of the changed row, or `null` for table-level synthetic
   * bumps recorded via {@link bumpChangeFeed} without a row id.
   */
  rowId: string | null;
  /** What happened. `'delete'` entries double as tombstones. */
  operation: ChangeOperation;
  /** Tenant the changed row belongs to, or `null` for global/non-tenant rows. */
  tenantId: string | null;
  /** ISO-8601 timestamp recorded when the change was appended. */
  timestamp: string;
}

/** Options for {@link getChangesSince}. */
export interface GetChangesOptions {
  /**
   * Cursor to read after. Only rows with `seq` strictly greater than `since`
   * are returned; pass a previously returned {@link ChangeFeedPage.cursor} to
   * poll.
   *
   * `0` reads from the start of the log only while it has not been pruned past
   * the beginning. Once retention has raised the retained floor above the
   * start, `since: 0` (like any cursor older than the retained window) can no
   * longer be served incrementally — the read returns
   * {@link ChangeFeedPage.resyncRequired} and the caller must do a full
   * resync before resuming from {@link ChangeFeedPage.resyncCursor}.
   */
  since: number;
  /** Restrict to these physical table names. Empty/omitted → all tables. */
  tables?: string[];
  /**
   * Tenant visibility filter:
   * - omitted/`undefined` → no tenant filter (all rows).
   * - `null` → only global rows (`tenant_id IS NULL`).
   * - `'<tenantId>'` → that tenant's rows **plus** global rows, matching the
   *   DispatchBus read rule (`tenant_id = T OR tenant_id IS NULL`). A tenant
   *   never sees another tenant's changes.
   */
  tenantId?: string | null;
  /**
   * Page size (default {@link DEFAULT_CHANGES_LIMIT}, capped at
   * {@link MAX_CHANGES_LIMIT}). When a page fills up, the returned cursor
   * stops at the last returned row so the next poll continues seamlessly.
   */
  limit?: number;
}

/** Result page of {@link getChangesSince}. */
export interface ChangeFeedPage {
  /** Matching changes ordered by ascending `seq`. */
  changes: ChangeFeedEntry[];
  /**
   * The next cursor. Monotonic: never lower than the `since` it was derived
   * from. Equal to the committed horizon when the page was exhaustive, or to
   * the last returned `seq` when the page hit `limit`. Feed the value back
   * as `since` to observe every later change exactly once.
   */
  cursor: number;
  /**
   * Present (and `true`) when the supplied cursor cannot be served
   * incrementally and the consumer must fall back to a full resync:
   *
   * - the cursor predates the retained window (entries at or below it were
   *   pruned away — the changes between it and the retained floor are gone
   *   for good), or
   * - the cursor is ahead of the committed horizon / unknown to this
   *   database (a foreign or reset cursor).
   *
   * When set, `changes` is empty and `cursor` echoes `since` unchanged.
   * After its full data refetch, the consumer should resume polling from
   * {@link resyncCursor}, the committed horizon observed by this read.
   * Detection is computed on the **unfiltered** log: `tables`/`tenantId`
   * filters legitimately hide rows and never trigger (or mask) a resync
   * signal.
   */
  resyncRequired?: boolean;
  /**
   * Current committed horizon to use after handling a resync. Present with
   * {@link resyncRequired}; separated from `cursor` so old callers that rely
   * on `cursor` echoing the rejected value keep their monotonic-cursor
   * invariant.
   */
  resyncCursor?: number;
}

/** Input for {@link appendChange} / {@link bumpChangeFeed}. */
export interface AppendChangeInput {
  /** Physical table name the change refers to. */
  table: string;
  /** Changed row's primary key; `null`/omitted records a table-level change. */
  rowId?: string | null;
  /** Operation to record (default `'update'`). */
  operation?: ChangeOperation;
  /** Tenant the change belongs to (default `null` = global). */
  tenantId?: string | null;
}

/** Retention bounds for {@link pruneChangeFeed}. At least one is required. */
export interface ChangeFeedRetention {
  /** Prune entries older than this many milliseconds. */
  maxAgeMs?: number;
  /** Keep at most this many newest entries (by sequence). */
  maxRows?: number;
  /**
   * Count the entries the bounds select without deleting them (#2375).
   *
   * Lets the retention sweep and `smrt db:prune --dry-run` preview the exact
   * same predicate the real prune would execute.
   */
  dryRun?: boolean;
}

/** Default page size for {@link getChangesSince}. */
export const DEFAULT_CHANGES_LIMIT = 500;

/** Hard cap on the page size for {@link getChangesSince}. */
export const MAX_CHANGES_LIMIT = 5_000;

/**
 * Maximum append attempts under sequence contention. Conflicts only occur
 * with concurrent writers on MVCC engines and resolve as soon as the
 * blocking transaction commits, so a small bound is ample.
 */
const MAX_APPEND_ATTEMPTS = 20;

const VALID_OPERATIONS: ReadonlySet<string> = new Set([
  'create',
  'update',
  'delete',
]);

// ============================================================================
// Engine / SQL helpers (mirrors system/compatibility.ts conventions)
// ============================================================================

type DatabaseWithConfig = DatabaseInterface & {
  config?: { type?: string; url?: string };
  type?: string;
};

function getEngine(
  db: DatabaseInterface,
  typeHint?: string,
): ReturnType<typeof detectEngine> {
  const withConfig = db as DatabaseWithConfig;
  return detectEngine(
    db.url || withConfig.config?.url || '',
    typeHint || withConfig.type || withConfig.config?.type,
  );
}

/**
 * Positional placeholder factory: Postgres uses `$n`, SQLite/DuckDB use `?`.
 */
function placeholders(db: DatabaseInterface): (index: number) => string {
  const engine = getEngine(db);
  return engine === 'postgres' ? (index) => `$${index}` : () => '?';
}

function getQueryRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) {
    return result as Record<string, unknown>[];
  }
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) {
      return rows as Record<string, unknown>[];
    }
  }
  return [];
}

function isUniqueViolation(error: unknown): boolean {
  const signals: string[] = [];
  const pending: unknown[] = [error];
  const seen = new Set<object>();

  while (pending.length > 0 && seen.size < 5) {
    const candidate = pending.shift();
    if (typeof candidate === 'string') {
      signals.push(candidate);
      continue;
    }
    if (!candidate || typeof candidate !== 'object' || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);

    const shaped = candidate as {
      cause?: unknown;
      code?: unknown;
      context?: unknown;
      message?: unknown;
    };
    if (typeof shaped.message === 'string') signals.push(shaped.message);
    if (typeof shaped.code === 'string') signals.push(shaped.code);
    if (shaped.cause !== undefined) pending.push(shaped.cause);

    if (shaped.context && typeof shaped.context === 'object') {
      const originalError = (shaped.context as { originalError?: unknown })
        .originalError;
      if (originalError !== undefined) pending.push(originalError);
    }
  }

  const message = signals.join(', ');
  return (
    /\b23505\b/.test(message) ||
    /unique constraint/i.test(message) ||
    /duplicate key/i.test(message) ||
    /primary key constraint/i.test(message) ||
    /constraint error/i.test(message)
  );
}

/**
 * Ensure the `_smrt_changes` system table exists on a database handle that
 * may not have passed through framework initialization (e.g. a raw handle
 * given to the REST generator). Idempotent (`CREATE ... IF NOT EXISTS`) and
 * guarded to run once per handle. Databases initialized through the
 * framework already have the table via the system-table bootstrap.
 */
const ensuredHandles = new WeakSet<object>();

async function postgresChangeFeedAppendFunctionExists(
  db: DatabaseInterface,
): Promise<boolean> {
  const rows = getQueryRows(
    await db.query(
      `SELECT to_regprocedure('${POSTGRES_CHANGE_FEED_APPEND_FUNCTION_IDENTITY}') AS function_name`,
    ),
  );
  return Boolean(rows[0]?.function_name);
}

async function getPostgresChangeFeedSchemaState(
  db: DatabaseInterface,
): Promise<{
  tableExists: boolean;
  functionExists: boolean;
  createdAtType: string | null;
}> {
  const rows = getQueryRows(
    await db.query(
      `SELECT
         to_regclass('${CHANGE_FEED_TABLE}') AS table_name,
         to_regprocedure('${POSTGRES_CHANGE_FEED_APPEND_FUNCTION_IDENTITY}') AS function_name,
         (
           SELECT data_type
           FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = '${CHANGE_FEED_TABLE}'
             AND column_name = 'created_at'
         ) AS created_at_type`,
    ),
  );
  return {
    tableExists: Boolean(rows[0]?.table_name),
    functionExists: Boolean(rows[0]?.function_name),
    createdAtType: rows[0]?.created_at_type
      ? String(rows[0].created_at_type)
      : null,
  };
}

function assertPostgresChangeFeedTimestampCurrent(
  state: Awaited<ReturnType<typeof getPostgresChangeFeedSchemaState>>,
): void {
  if (state.createdAtType === 'timestamp without time zone') {
    throw new Error(
      'Legacy _smrt_changes.created_at requires an explicit audited migratePostgresSystemTimestamps() call before change-feed initialization',
    );
  }
}

/**
 * Install/refresh the PostgreSQL exception-subtransaction append boundary.
 *
 * Framework bootstrap calls this while applying the system-schema version that
 * introduced the helper, so upgraded databases acquire it before the migration
 * is recorded. Raw-handle initialization passes `replaceExisting: false` so a
 * read route does not require function ownership when the installed helper is
 * already current. A missing helper is installed by one server-side statement
 * that locks and rechecks before DDL. Non-PostgreSQL adapters are a no-op.
 *
 * @internal
 */
export async function ensurePostgresChangeFeedAppendFunction(
  db: DatabaseInterface,
  options: {
    replaceExisting?: boolean;
    typeHint?: string;
  } = {},
): Promise<void> {
  if (getEngine(db, options.typeHint) !== 'postgres') return;

  assertPostgresChangeFeedTimestampCurrent(
    await getPostgresChangeFeedSchemaState(db),
  );

  if (options.replaceExisting === false) {
    if (await postgresChangeFeedAppendFunctionExists(db)) return;
    await db.query(ENSURE_POSTGRES_CHANGE_FEED_APPEND_FUNCTION);
    return;
  }

  await db.query(REPLACE_POSTGRES_CHANGE_FEED_APPEND_FUNCTION);
}

export async function ensureChangeFeedTable(
  db: DatabaseInterface,
): Promise<void> {
  if (ensuredHandles.has(db)) return;
  if (getEngine(db) === 'postgres') {
    const state = await getPostgresChangeFeedSchemaState(db);
    assertPostgresChangeFeedTimestampCurrent(state);
    if (
      state.tableExists &&
      state.functionExists &&
      state.createdAtType === 'timestamp with time zone'
    ) {
      ensuredHandles.add(db);
      return;
    }
    await db.query(ENSURE_POSTGRES_CHANGE_FEED_SCHEMA);
  } else {
    const statements = CREATE_SMRT_CHANGES_TABLE.split(';')
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    for (const statement of statements) {
      await db.query(statement);
    }
  }
  ensuredHandles.add(db);
}

// ============================================================================
// Append (writer primitive + manual bump escape hatch)
// ============================================================================

/**
 * Append one change entry with a database-allocated, strictly monotonic
 * sequence.
 *
 * The sequence is allocated inside the INSERT itself
 * (`COALESCE(MAX(seq), 0) + 1`) and retried on primary-key conflict, which
 * keeps committed sequences contiguous and makes commit order equal
 * sequence order — the property the cursor guarantee rests on (see the
 * module docs). Throws after {@link MAX_APPEND_ATTEMPTS} consecutive
 * conflicts or on any non-conflict database error; the framework's
 * interceptor catches and logs instead of failing the user's write.
 *
 * **PostgreSQL transaction safety (#2026).** The INSERT runs inside the
 * framework-owned `_smrt_append_change` PL/pgSQL function. Its exception
 * handler is a PostgreSQL subtransaction: a failed attempt is rolled back
 * before the function returns `{ error_code, error_message }`. This method
 * then throws in JavaScript, where the existing retry/swallow policy applies
 * without aborting a caller-managed transaction. Keeping isolation inside one
 * database statement also prevents concurrent work on the same transaction
 * handle from interleaving inside a manual SAVEPOINT scope.
 */
export async function appendChange(
  db: DatabaseInterface,
  input: AppendChangeInput,
): Promise<number> {
  const table = input.table?.trim();
  if (!table) {
    throw new Error('appendChange requires a non-empty table name');
  }
  const operation = input.operation ?? 'update';
  if (!VALID_OPERATIONS.has(operation)) {
    throw new Error(
      `appendChange operation must be one of create/update/delete, got '${String(
        input.operation,
      )}'`,
    );
  }

  const engine = getEngine(db);
  const p = placeholders(db);
  // The INSERT yields the ACTUAL sequence it allocated in the SAME statement
  // (directly via RETURNING on portable engines, through the function on
  // PostgreSQL). A separate follow-up `SELECT MAX(seq)` is racy under concurrent
  // appends (a peer can commit a higher seq in between), which would hand two
  // distinct changes the same SSE `id` and let a client's `Last-Event-ID`
  // overshoot a change it never received. The allocator stays `MAX+1` under the
  // unique-PK retry, so committed sequences remain contiguous (the cursor
  // guarantee — see module docs).
  const sql =
    engine === 'postgres'
      ? `SELECT allocated_seq, error_code, error_message FROM ` +
        `${POSTGRES_CHANGE_FEED_APPEND_FUNCTION_NAME}(` +
        `${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)})`
      : `INSERT INTO ${CHANGE_FEED_TABLE} ` +
        '(seq, table_name, row_id, operation, tenant_id, created_at) ' +
        `SELECT COALESCE(MAX(seq), 0) + 1, ${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)} ` +
        `FROM ${CHANGE_FEED_TABLE} RETURNING seq`;
  const params = [
    table,
    input.rowId ?? null,
    operation,
    input.tenantId ?? null,
    new Date().toISOString(),
  ];

  for (let attempt = 1; attempt <= MAX_APPEND_ATTEMPTS; attempt++) {
    try {
      // The append is a root-connection write; on embedded engines it goes
      // through the per-database write queue so it can never overlap a
      // null-aware upsert's second-connection transaction (#2360 — the pair
      // livelocked into SQLITE_BUSY under concurrent NULL-tenant creates).
      const rows = getQueryRows(
        await withEmbeddedWriteQueue(db, isEmbeddedDatabase(db), () =>
          db.query(sql, ...params),
        ),
      );
      const row = rows[0];
      if (!row) {
        throw new Error('Change feed append returned no result row');
      }
      if (engine === 'postgres' && row.error_code != null) {
        const error = new Error(
          String(row.error_message || 'PostgreSQL change-feed append failed'),
        ) as Error & { code: string };
        error.code = String(row.error_code);
        throw error;
      }
      return toSeqNumber(engine === 'postgres' ? row.allocated_seq : row.seq);
    } catch (error) {
      if (!isUniqueViolation(error) || attempt === MAX_APPEND_ATTEMPTS) {
        throw error;
      }
      // Sequence head contention: another append won the value. Re-running
      // recomputes MAX(seq) against the now-committed head.
    }
  }

  // Unreachable: the loop returns a seq or throws on the final attempt. Present
  // so the function satisfies its `Promise<number>` contract structurally.
  throw new Error('appendChange exhausted retries without allocating a seq');
}

/**
 * Manual bump escape hatch for out-of-band writers.
 *
 * Framework mutation paths feed the log automatically, but raw SQL issued
 * outside `save()`/`delete()` is invisible to it (documented gap, shared
 * with the #1499 collection cache). Call this after such a write so feed
 * consumers observe the change. Omitting `rowId` records a table-level
 * change (`rowId: null`), which consumers should treat as "anything in this
 * table may have changed".
 *
 * @example
 * ```typescript
 * await db.query(`UPDATE products SET price = price * 1.1`);
 * await bumpChangeFeed(db, { table: 'products' });
 * ```
 */
export async function bumpChangeFeed(
  db: DatabaseInterface,
  input: AppendChangeInput,
): Promise<void> {
  await ensureChangeFeedTable(db);
  await appendChange(db, input);
}

// ============================================================================
// Read interface
// ============================================================================

/**
 * Read committed changes after a cursor.
 *
 * Returns every committed change with `since < seq <= cursor` that matches
 * the filters, ordered by ascending `seq`. The returned cursor is safe to
 * persist and poll with: committed sequences are contiguous (see module
 * docs), so nothing can commit at or below the observed horizon afterwards —
 * reads miss no committed change under concurrent writers and never return
 * the same change twice. When `since` is already at the horizon, returns an
 * empty page with `cursor: since`.
 *
 * ## Resync detection (pruned / foreign cursors)
 *
 * A cursor that cannot be served incrementally is flagged with
 * `resyncRequired: true` (empty `changes`, `cursor` echoed unchanged,
 * `resyncCursor` set to the current horizon) so pollers never go silently,
 * permanently stale:
 *
 * - **Pruned gap**: retained sequences always form a contiguous run
 *   `[floor..horizon]` and {@link pruneChangeFeed} deletes oldest-first
 *   while always retaining the newest entry, so `since < floor - 1` proves
 *   changes between the cursor and the retained window were pruned away.
 * - **Foreign/reset cursor**: `since > horizon` (ahead of anything this
 *   database ever allocated), including any `since > 0` against a feed
 *   with no entries.
 *
 * Detection runs on the **unfiltered** log — `tables`/`tenantId` filters
 * legitimately hide rows and never trigger (or mask) the signal. A caught-up
 * consumer (`since === horizon`) is never asked to resync, even when
 * retention has pruned everything older.
 *
 * Filters (`tables`, `tenantId`) affect which rows are *returned*, never how
 * the cursor advances — an exhausted filtered page still advances to the
 * horizon so pollers do not rescan filtered-out rows.
 */
export async function getChangesSince(
  db: DatabaseInterface,
  options: GetChangesOptions,
): Promise<ChangeFeedPage> {
  const { since } = options;
  if (!Number.isFinite(since) || since < 0) {
    throw new Error(
      `getChangesSince requires a non-negative numeric cursor, got '${String(since)}'`,
    );
  }
  const limit = Math.min(
    Math.max(Math.floor(options.limit ?? DEFAULT_CHANGES_LIMIT), 1),
    MAX_CHANGES_LIMIT,
  );

  const p = placeholders(db);

  // The committed horizon: every seq <= horizon is committed and immutable
  // (append-only + contiguous allocation), so the page below is stable even
  // though it runs as a separate statement. The floor bounds the retained
  // window for pruned-cursor detection; both are computed UNFILTERED so
  // table/tenant filters can neither trigger nor mask a resync signal.
  const boundsRows = getQueryRows(
    await db.query(
      `SELECT MIN(seq) AS floor, MAX(seq) AS horizon FROM ${CHANGE_FEED_TABLE}`,
    ),
  );
  const floor = toSeqNumber(boundsRows[0]?.floor);
  const horizon = toSeqNumber(boundsRows[0]?.horizon);

  if (horizon === 0) {
    // No entries at all. A zero cursor is simply "no changes ever"; any
    // other cursor came from a different database (or a reset feed) and
    // cannot be served incrementally.
    return since === 0
      ? { changes: [], cursor: 0 }
      : { changes: [], cursor: since, resyncRequired: true, resyncCursor: 0 };
  }

  if (since > horizon) {
    // Foreign or reset cursor — ahead of anything this database allocated.
    return {
      changes: [],
      cursor: since,
      resyncRequired: true,
      resyncCursor: horizon,
    };
  }

  if (since < floor - 1) {
    // Pruned gap — the changes with seq in (since, floor) are gone for good.
    return {
      changes: [],
      cursor: since,
      resyncRequired: true,
      resyncCursor: horizon,
    };
  }

  if (horizon === since) {
    return { changes: [], cursor: since };
  }

  const conditions: string[] = [];
  const params: unknown[] = [];
  let index = 0;
  const next = () => p(++index);

  conditions.push(`seq > ${next()}`);
  params.push(since);
  conditions.push(`seq <= ${next()}`);
  params.push(horizon);

  const tables = options.tables?.filter((table) => table.trim().length > 0);
  if (tables && tables.length > 0) {
    conditions.push(`table_name IN (${tables.map(() => next()).join(', ')})`);
    params.push(...tables);
  }

  if (options.tenantId === null) {
    conditions.push('tenant_id IS NULL');
  } else if (typeof options.tenantId === 'string') {
    conditions.push(`(tenant_id = ${next()} OR tenant_id IS NULL)`);
    params.push(options.tenantId);
  }

  const sql =
    'SELECT seq, table_name, row_id, operation, tenant_id, created_at ' +
    `FROM ${CHANGE_FEED_TABLE} WHERE ${conditions.join(' AND ')} ` +
    `ORDER BY seq ASC LIMIT ${next()}`;
  params.push(limit);

  const rows = getQueryRows(await db.query(sql, ...params));
  const changes = rows.map(rowToEntry);

  // Page limited → resume after the last returned row. Page exhaustive →
  // everything up to the horizon (matching or filtered out) has been
  // observed, so advance all the way.
  const cursor =
    changes.length === limit ? changes[changes.length - 1].seq : horizon;

  return { changes, cursor };
}

/**
 * {@link getChangesSince} scoped by the active tenant context.
 *
 * Resolves the tenant through the same dependency-inversion hook the
 * DispatchBus uses ({@link resolveDispatchTenantScope}), so it works without
 * core depending on `@happyvertical/smrt-tenancy`:
 *
 * - Tenancy disabled (no resolver registered) → no tenant filter.
 * - Tenancy enabled with an active tenant `T` → `T`'s rows plus global rows.
 * - Tenancy enabled with **no** active tenant → global rows only
 *   (**fail-closed**: a missing context never widens visibility to all
 *   tenants).
 *
 * This is the read the generated `_changes` routes call after establishing
 * tenant context from the authenticated principal.
 */
export async function getTenantScopedChangesSince(
  db: DatabaseInterface,
  options: Omit<GetChangesOptions, 'tenantId'>,
): Promise<ChangeFeedPage> {
  const scope = resolveDispatchTenantScope();
  if (!scope.enforced) {
    return getChangesSince(db, options);
  }
  return getChangesSince(db, { ...options, tenantId: scope.tenantId });
}

/**
 * The per-table change version — the ETag source for zero-query conditional
 * GETs (#1765).
 *
 * Returns `MAX(seq)` over the feed rows for `table`: a monotonic number that
 * advances on every framework write to that table (create/update/delete, and
 * writes through the sync-apply endpoint, which all `save()`/`delete()`).
 * Because sequences are the change feed's globally-monotonic cursor dimension
 * (allocated `MAX+1` at commit time, never a native identity — see the module
 * docs), the value is **replica-stable**: two processes reading the same
 * committed database compute the same version, with no per-process divergence.
 * That is what lets a generated read route derive an ETag that short-circuits a
 * matching `If-None-Match` into a `304` before the collection query runs — an
 * unchanged table costs one indexed `MAX(seq)` lookup (backed by
 * `idx_smrt_changes_table_seq`) to revalidate, not a table scan.
 *
 * ## Why the fallback to the global horizon (and not 0)
 *
 * A table with no *retained* feed entry falls back to the global horizon
 * (`MAX(seq)` across all tables), returning 0 only when the whole feed is
 * empty. Retention prunes oldest-first and always keeps the newest entry, so a
 * quiet table can lose all of its own entries while busier tables advance. If
 * such a table reported 0, a client that cached it while it was empty (version
 * 0) could, after a change→prune→change→prune cycle returned the lookup to 0,
 * be wrongly answered `304` against data that has since changed — a false-304.
 *
 * The horizon fallback closes that hole: any write to the table appends a new
 * sequence strictly greater than every previously-observed value (its own or
 * the horizon), so the version — and therefore the ETag — strictly exceeds any
 * value a client already holds, forcing a fresh `200`. The only cost is that a
 * table with no retained entries of its own revalidates whenever the global
 * horizon moves; a table with a retained entry uses its own stable `MAX(seq)`
 * and is unaffected by writes to sibling tables. A persistent per-table
 * high-water mark that survives pruning would remove even that cost; it is a
 * deliberate follow-up, out of scope for this slice.
 *
 * Idempotently ensures the feed table exists first, so it is safe to call from
 * a read route on a raw handle that has never been written to.
 */
export async function getTableVersion(
  db: DatabaseInterface,
  table: string,
): Promise<number> {
  const name = table?.trim();
  if (!name) {
    throw new Error('getTableVersion requires a non-empty table name');
  }
  await ensureChangeFeedTable(db);

  const p = placeholders(db);
  const tableRows = getQueryRows(
    await db.query(
      `SELECT MAX(seq) AS version FROM ${CHANGE_FEED_TABLE} WHERE table_name = ${p(1)}`,
      name,
    ),
  );
  const tableVersion = tableRows[0]?.version;
  if (tableVersion != null) {
    return toSeqNumber(tableVersion);
  }

  // No retained entry for this table — fall back to the global horizon so an
  // all-pruned (or never-written) table never reports a resettable low value
  // that could false-304 a stale client. 0 only when the feed is empty.
  const horizonRows = getQueryRows(
    await db.query(`SELECT MAX(seq) AS horizon FROM ${CHANGE_FEED_TABLE}`),
  );
  return toSeqNumber(horizonRows[0]?.horizon);
}

function toSeqNumber(value: unknown): number {
  // PostgreSQL surfaces BIGINT aggregates as strings and DuckDB can return
  // BigInt. Change-feed cursors must never advance on a rounded value.
  return toSafeInteger(value ?? 0, 'Change-feed sequence');
}

function rowToEntry(row: Record<string, unknown>): ChangeFeedEntry {
  return {
    seq: toSeqNumber(row.seq),
    table: String(row.table_name ?? ''),
    rowId: row.row_id == null ? null : String(row.row_id),
    operation: String(row.operation ?? 'update') as ChangeOperation,
    tenantId: row.tenant_id == null ? null : String(row.tenant_id),
    timestamp: normalizeTimestamp(row.created_at),
  };
}

function normalizeTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value ?? '');
}

// ============================================================================
// Retention / compaction
// ============================================================================

/**
 * Prune the change feed to bound its growth.
 *
 * Applies whichever bounds are provided (at least one is required):
 * - `maxRows`: keep only the newest N entries by sequence.
 * - `maxAgeMs`: drop entries older than the cutoff.
 *
 * Pruning deletes oldest-first, never renumbers surviving entries, and
 * **always retains the newest entry** (a non-empty feed is never emptied,
 * whatever the bounds say). That invariant anchors pruned-cursor detection:
 * retained sequences stay a contiguous run `[floor..horizon]`, so
 * {@link getChangesSince} can prove a cursor predates the retained window
 * (`resyncRequired`) — and a fully caught-up consumer keeps polling
 * normally even after everything older was pruned.
 *
 * Cursors within the retained window keep working. Schedule pruning (e.g.
 * via `@happyvertical/smrt-jobs`) with a retention window comfortably
 * larger than the slowest consumer's polling interval; consumers whose
 * cursor falls out of it are told to full-resync via `resyncRequired`.
 *
 * @returns The number of entries pruned — or, with `dryRun`, the number the
 *   same bounds would prune (approximate under concurrent prunes).
 */
export async function pruneChangeFeed(
  db: DatabaseInterface,
  retention: ChangeFeedRetention,
): Promise<{ pruned: number }> {
  const { maxAgeMs, maxRows, dryRun = false } = retention;
  if (maxAgeMs == null && maxRows == null) {
    throw new Error('pruneChangeFeed requires maxAgeMs and/or maxRows');
  }
  if (maxAgeMs != null && (!Number.isFinite(maxAgeMs) || maxAgeMs < 0)) {
    throw new Error(`pruneChangeFeed maxAgeMs must be >= 0, got ${maxAgeMs}`);
  }
  if (maxRows != null && (!Number.isFinite(maxRows) || maxRows < 0)) {
    throw new Error(`pruneChangeFeed maxRows must be >= 0, got ${maxRows}`);
  }

  const p = placeholders(db);

  // Snapshot the horizon once: both bounds prune strictly below it so the
  // newest entry always survives (see resync-detection contract above).
  const horizonRows = getQueryRows(
    await db.query(`SELECT MAX(seq) AS horizon FROM ${CHANGE_FEED_TABLE}`),
  );
  const horizon = toSeqNumber(horizonRows[0]?.horizon);
  if (horizon === 0) {
    return { pruned: 0 };
  }

  let pruned = 0;
  let prunedThrough = 0;

  if (maxRows != null) {
    const pruneThrough = Math.min(horizon - Math.floor(maxRows), horizon - 1);
    if (pruneThrough > 0) {
      prunedThrough = pruneThrough;
      pruned += await deleteCounted(
        db,
        `seq <= ${p(1)}`,
        [pruneThrough],
        dryRun,
      );
    }
  }

  if (maxAgeMs != null) {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    // `seq > prunedThrough` excludes what the row bound already accounted for.
    // Redundant when the rows were really deleted, load-bearing under
    // `dryRun`, where nothing was — without it overlapping entries would be
    // counted by both bounds.
    pruned += await deleteCounted(
      db,
      `created_at < ${p(1)} AND seq < ${p(2)} AND seq > ${p(3)}`,
      [cutoff, horizon, prunedThrough],
      dryRun,
    );
  }

  return { pruned };
}

async function deleteCounted(
  db: DatabaseInterface,
  condition: string,
  params: unknown[],
  dryRun = false,
): Promise<number> {
  const countRows = getQueryRows(
    await db.query(
      `SELECT COUNT(*) AS total FROM ${CHANGE_FEED_TABLE} WHERE ${condition}`,
      ...params,
    ),
  );
  const total = toSeqNumber(countRows[0]?.total);
  if (total > 0 && !dryRun) {
    await db.query(
      `DELETE FROM ${CHANGE_FEED_TABLE} WHERE ${condition}`,
      ...params,
    );
  }
  return total;
}

// ============================================================================
// Framework writer (GlobalInterceptors registration)
// ============================================================================

export const CHANGE_FEED_WAS_PERSISTED_KEY = '_smrtChangeFeedWasPersisted';

/** Databases we already warned about after a failed feed append. */
const warnedAppendFailures = new Set<string>();

/** Databases we already warned about after a failed signal publish (#1763). */
const warnedSignalPublishFailures = new Set<string>();

/**
 * Register the change-feed writer with {@link GlobalInterceptors}.
 *
 * Called automatically during framework initialization (every
 * `SmrtClass.initialize()` passes through it), so applications never need
 * to call it directly; it is exported for tests and for re-registering
 * after `GlobalInterceptors.clear()`. Idempotent — a second call while the
 * writer is registered is a no-op.
 *
 * The writer observes the same hooks the reports scheduler and tenancy
 * interceptors use:
 * - `beforeSave` stashes whether the instance was already persisted (this
 *   is what distinguishes `create` from `update` in the feed).
 * - `afterSave`/`afterDelete` append exactly one change entry per framework
 *   save/delete. Framework-owned tables listed in
 *   {@link CHANGE_FEED_EXCLUDED_TABLES} are skipped — the feed observes
 *   application data, not framework bookkeeping (and never itself).
 *
 * Failure policy: appends run after the user's write succeeded and must not
 * un-succeed it — failures are logged (deduped per database) and swallowed.
 */
export function registerChangeFeedWriter(): void {
  if (
    GlobalInterceptors.getAll().some(
      (interceptor) => interceptor.name === CHANGE_FEED_INTERCEPTOR_NAME,
    )
  ) {
    return;
  }

  GlobalInterceptors.register({
    name: CHANGE_FEED_INTERCEPTOR_NAME,
    // Below tenancy (100) so tenantId auto-population precedes the stash;
    // above the reports refresh interceptor (-10) so a triggered refresh
    // can already observe the appended change entry.
    priority: 0,

    beforeSave(instance: SmrtObject, context: InterceptorContext): void {
      try {
        context.metadata = {
          ...context.metadata,
          [CHANGE_FEED_WAS_PERSISTED_KEY]: instance.isPersisted === true,
        };
      } catch {
        // Never let feed bookkeeping block a save.
      }
    },

    async afterSave(
      instance: SmrtObject,
      context: InterceptorContext,
    ): Promise<void> {
      const wasPersisted =
        context.metadata?.[CHANGE_FEED_WAS_PERSISTED_KEY] === true;
      await appendForInstance(instance, wasPersisted ? 'update' : 'create');
    },

    async afterDelete(instance: SmrtObject): Promise<void> {
      await appendForInstance(instance, 'delete');
    },
  });
}

/** Unregister the change-feed writer (test helper). */
export function unregisterChangeFeedWriter(): boolean {
  return GlobalInterceptors.unregister(CHANGE_FEED_INTERCEPTOR_NAME);
}

async function appendForInstance(
  instance: SmrtObject,
  operation: ChangeOperation,
): Promise<void> {
  let db: DatabaseInterface;
  let table: string;
  try {
    table = instance.tableName;
    // Framework-owned tables are bookkeeping, not client-syncable data —
    // recording them would let the feed observe (and re-observe) itself. The
    // test is an allowlist, not the `_smrt_` prefix: ~25 domain tables carry
    // that prefix and must be observed (issue #2376).
    if (!isChangeFeedObservableTable(table)) return;
    db = instance.db;
  } catch {
    // Not a fully initialized SmrtObject (e.g. plain-object doubles in
    // tests) — nothing to record.
    return;
  }

  try {
    const id = (instance as { id?: unknown }).id;
    const tenantId = (instance as unknown as Record<string, unknown>).tenantId;
    const rowId = typeof id === 'string' && id ? id : null;
    const rowTenantId =
      typeof tenantId === 'string' && tenantId ? tenantId : null;
    const seq = await appendChange(db, {
      table,
      rowId,
      operation,
      tenantId: rowTenantId,
    });

    // Publish a coarse live signal for the SSE `_events` route (#1763). This
    // runs only after the durable feed append SUCCEEDED (same try block, so a
    // failed append never emits a signal — "no signal without a durable feed
    // row"). Its own try/catch (distinct dedup key) keeps a signal-publish
    // problem from failing the user's write or masking the append's own
    // failure semantics above.
    try {
      publishChangeSignal(db, {
        table,
        operation,
        rowId,
        tenantId: rowTenantId,
        seq,
      });
    } catch (error) {
      warnSignalPublishFailureOnce(db, table, error);
    }
  } catch (error) {
    warnAppendFailureOnce(db, table, error);
  }
}

/** Record a framework-owned mutation that intentionally bypasses save hooks. */
export async function recordInstanceChange(
  instance: SmrtObject,
  operation: ChangeOperation = 'update',
): Promise<void> {
  await appendForInstance(instance, operation);
}

function warnAppendFailureOnce(
  db: DatabaseInterface,
  table: string,
  error: unknown,
): void {
  try {
    const dbKey = resolveDbCacheKey(db);
    if (warnedAppendFailures.has(dbKey)) return;
    warnedAppendFailures.add(dbKey);
    logger.warn(
      `Change feed: failed to append a change entry for '${table}'. The ` +
        'write itself succeeded; the feed is missing this change (further ' +
        'failures for this database are suppressed). Consumers recover on ' +
        'full resync.',
      { error: error instanceof Error ? error.message : String(error) },
    );
  } catch {
    // Logging must never propagate into the write path.
  }
}

function warnSignalPublishFailureOnce(
  db: DatabaseInterface,
  table: string,
  error: unknown,
): void {
  try {
    const dbKey = resolveDbCacheKey(db);
    if (warnedSignalPublishFailures.has(dbKey)) return;
    warnedSignalPublishFailures.add(dbKey);
    logger.warn(
      `Change feed: failed to publish a live change signal for '${table}'. ` +
        'The write and its durable feed row are unaffected; live SSE ' +
        'subscribers miss this signal but recover via cursor catch-up ' +
        '(further failures for this database are suppressed).',
      { error: error instanceof Error ? error.message : String(error) },
    );
  } catch {
    // Logging must never propagate into the write path.
  }
}

/**
 * Reset the append-failure and signal-publish warning dedups (test helper).
 */
export function resetChangeFeedWarnings(): void {
  warnedAppendFailures.clear();
  warnedSignalPublishFailures.clear();
}
