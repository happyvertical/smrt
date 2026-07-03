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
 * a single small INSERT (issued from the write path *after* the user's row
 * was written), so the serialization window is one statement; conflicts
 * resolve with a bounded retry loop and are impossible on single-writer
 * engines (SQLite).
 *
 * ## Failure semantics
 *
 * A feed-write failure must never fail the user's write. The interceptor
 * wraps the append in a try/catch: on failure it logs a warning (deduped per
 * database) and continues. The trade-off is availability of the user's
 * write over completeness of the feed — consumers already need a
 * full-resync path for cursors older than the retention window, and the
 * same path covers a (rare) dropped feed row. When the user's write runs
 * inside a caller-managed transaction on the same handle, the append joins
 * it and shares its fate (a rollback removes the change row with the data
 * row).
 *
 * ## Known gap (documented in the PRD)
 *
 * Writes that bypass framework mutation paths (raw SQL) are invisible to
 * the feed — the same accepted gap as the #1499 collection cache.
 * {@link bumpChangeFeed} is the manual escape hatch: out-of-band writers
 * append a synthetic change row for the affected table.
 *
 * ## Retention
 *
 * The log is append-only and grows with write volume. {@link pruneChangeFeed}
 * bounds it by age (`maxAgeMs`) and/or row count (`maxRows`); call it from a
 * scheduled job sized so the retention window comfortably exceeds the
 * slowest consumer's polling interval. A consumer whose cursor predates the
 * retained window silently misses pruned entries and must full-resync.
 *
 * @see https://github.com/happyvertical/smrt/issues/1758
 * @packageDocumentation
 */

import { createLogger } from '@happyvertical/logger';
import type { DatabaseInterface } from '@happyvertical/sql';
import { resolveDbCacheKey } from './collection-cache.js';
import { resolveDispatchTenantScope } from './dispatch/tenant-resolver.js';
import {
  GlobalInterceptors,
  type InterceptorContext,
} from './interceptors.js';
import type { SmrtObject } from './object.js';
import { detectEngine } from './schema/ddl/index.js';
import { CREATE_SMRT_CHANGES_TABLE } from './system/schema.js';

const logger = createLogger({ level: 'info' });

/** Name of the append-only change-feed system table. */
export const CHANGE_FEED_TABLE = '_smrt_changes';

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
   * Cursor to read after. Pass `0` to read from the start of the retained
   * log; pass a previously returned {@link ChangeFeedPage.cursor} to poll.
   * Only rows with `seq` strictly greater than `since` are returned.
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

function getEngine(db: DatabaseInterface): ReturnType<typeof detectEngine> {
  const withConfig = db as DatabaseWithConfig;
  return detectEngine(
    db.url || withConfig.config?.url || '',
    withConfig.type || withConfig.config?.type,
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
  const message =
    error instanceof Error ? error.message : String(error ?? '');
  return (
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

export async function ensureChangeFeedTable(
  db: DatabaseInterface,
): Promise<void> {
  if (ensuredHandles.has(db)) return;
  const statements = CREATE_SMRT_CHANGES_TABLE.split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  for (const statement of statements) {
    await db.query(statement);
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
 */
export async function appendChange(
  db: DatabaseInterface,
  input: AppendChangeInput,
): Promise<void> {
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

  const p = placeholders(db);
  const sql =
    `INSERT INTO ${CHANGE_FEED_TABLE} ` +
    '(seq, table_name, row_id, operation, tenant_id, created_at) ' +
    `SELECT COALESCE(MAX(seq), 0) + 1, ${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)} ` +
    `FROM ${CHANGE_FEED_TABLE}`;
  const params = [
    table,
    input.rowId ?? null,
    operation,
    input.tenantId ?? null,
    new Date().toISOString(),
  ];

  for (let attempt = 1; attempt <= MAX_APPEND_ATTEMPTS; attempt++) {
    try {
      await db.query(sql, ...params);
      return;
    } catch (error) {
      if (!isUniqueViolation(error) || attempt === MAX_APPEND_ATTEMPTS) {
        throw error;
      }
      // Sequence head contention: another append won the value. Re-running
      // recomputes MAX(seq) against the now-committed head.
    }
  }
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
 * the same change twice. When `since` is already at (or beyond) the
 * horizon, returns an empty page with `cursor: since`.
 *
 * Retention caveat: if `since` predates the retained window (entries were
 * pruned), the pruned changes are silently skipped — consumers must treat a
 * cursor older than their deployment's retention window as requiring a full
 * resync.
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
  // though it runs as a separate statement.
  const horizonRows = getQueryRows(
    await db.query(`SELECT MAX(seq) AS horizon FROM ${CHANGE_FEED_TABLE}`),
  );
  const horizon = toSeqNumber(horizonRows[0]?.horizon);
  if (horizon <= since) {
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
    conditions.push(
      `table_name IN (${tables.map(() => next()).join(', ')})`,
    );
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

function toSeqNumber(value: unknown): number {
  // Postgres adapters may surface BIGINT aggregates as strings.
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
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
 * Pruning never renumbers surviving entries, so cursors within the retained
 * window keep working. A cursor older than the retained window silently
 * skips the pruned range — schedule pruning (e.g. via `@happyvertical/
 * smrt-jobs`) with a retention window comfortably larger than the slowest
 * consumer's polling interval, and treat older client cursors as requiring
 * a full resync.
 *
 * @returns The number of entries pruned (approximate under concurrent prunes).
 */
export async function pruneChangeFeed(
  db: DatabaseInterface,
  retention: ChangeFeedRetention,
): Promise<{ pruned: number }> {
  const { maxAgeMs, maxRows } = retention;
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
  let pruned = 0;

  if (maxRows != null) {
    const horizonRows = getQueryRows(
      await db.query(`SELECT MAX(seq) AS horizon FROM ${CHANGE_FEED_TABLE}`),
    );
    const horizon = toSeqNumber(horizonRows[0]?.horizon);
    const pruneThrough = horizon - Math.floor(maxRows);
    if (pruneThrough > 0) {
      pruned += await deleteCounted(
        db,
        `seq <= ${p(1)}`,
        [pruneThrough],
      );
    }
  }

  if (maxAgeMs != null) {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    pruned += await deleteCounted(db, `created_at < ${p(1)}`, [cutoff]);
  }

  return { pruned };
}

async function deleteCounted(
  db: DatabaseInterface,
  condition: string,
  params: unknown[],
): Promise<number> {
  const countRows = getQueryRows(
    await db.query(
      `SELECT COUNT(*) AS total FROM ${CHANGE_FEED_TABLE} WHERE ${condition}`,
      ...params,
    ),
  );
  const total = toSeqNumber(countRows[0]?.total);
  if (total > 0) {
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

const WAS_PERSISTED_KEY = '_smrtChangeFeedWasPersisted';

/** Databases we already warned about after a failed feed append. */
const warnedAppendFailures = new Set<string>();

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
 *   save/delete. `_smrt_*` system tables are skipped — the feed observes
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
          [WAS_PERSISTED_KEY]: instance.isPersisted === true,
        };
      } catch {
        // Never let feed bookkeeping block a save.
      }
    },

    async afterSave(
      instance: SmrtObject,
      context: InterceptorContext,
    ): Promise<void> {
      const wasPersisted = context.metadata?.[WAS_PERSISTED_KEY] === true;
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
    // System tables are framework bookkeeping, not client-syncable data —
    // recording them would let the feed observe (and re-observe) itself.
    if (!table || table.startsWith('_smrt_')) return;
    db = instance.db;
  } catch {
    // Not a fully initialized SmrtObject (e.g. plain-object doubles in
    // tests) — nothing to record.
    return;
  }

  try {
    const id = (instance as { id?: unknown }).id;
    const tenantId = (instance as unknown as Record<string, unknown>)
      .tenantId;
    await appendChange(db, {
      table,
      rowId: typeof id === 'string' && id ? id : null,
      operation,
      tenantId: typeof tenantId === 'string' && tenantId ? tenantId : null,
    });
  } catch (error) {
    warnAppendFailureOnce(db, table, error);
  }
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

/**
 * Reset the append-failure warning dedup (test helper).
 */
export function resetChangeFeedWarnings(): void {
  warnedAppendFailures.clear();
}
