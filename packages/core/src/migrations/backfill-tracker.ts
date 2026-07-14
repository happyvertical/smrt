/**
 * Tracks application-specific data backfills (not schema migrations).
 *
 * Sits next to `MigrationTracker` but is intentionally minimal — backfills
 * have no checksum, no rollback semantics, no DDL. They're "this data
 * correction has run, don't run it again" markers, keyed by a stable
 * backfill name the app chooses.
 *
 * Backed by the `_smrt_backfills` system table (see
 * `../system/schema.ts`). The table is created lazily on first use —
 * every public method (`isApplied`, `recordApplied`, `runIfPending`,
 * `listApplied`) awaits `initialize()` itself, so consumers never need
 * to call `initialize()` explicitly.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import { CREATE_SMRT_BACKFILLS_TABLE } from '../system/schema.js';

export interface BackfillTrackerOptions {
  db: DatabaseInterface;
}

export interface BackfillRecord {
  name: string;
  appliedAt: string;
  description: string | null;
  packageName: string | null;
}

/**
 * A tracker query proved that its inherited root initialization is stale.
 *
 * Transaction coordinators must roll back the current transaction, refresh
 * the root tracker outside that transaction, and retry with a fresh handle.
 */
export class BackfillTableUnavailableError extends Error {
  constructor(cause: unknown) {
    super('The shared _smrt_backfills table is unavailable.', { cause });
    this.name = 'BackfillTableUnavailableError';
  }
}

// Only root adapters can establish a durable shared initialization. A tracker
// created around a transaction handle may have its DDL rolled back later, so
// transaction-local successes must never poison this cache.
const initializationByObject = new WeakMap<object, Promise<void>>();
const inheritedInitializationByHandle = new WeakMap<object, object>();

export class BackfillTracker {
  private readonly db: DatabaseInterface;
  private initializePromise: Promise<void> | null = null;

  constructor(options: BackfillTrackerOptions) {
    this.db = options.db;
  }

  /**
   * Mark a transaction handle as inheriting a table initialized durably by its
   * root adapter. Framework transaction coordinators use this after root DDL
   * commits so transaction-local trackers can skip redundant `CREATE TABLE`.
   */
  static inheritInitialization(
    db: DatabaseInterface,
    rootDb: DatabaseInterface,
  ): void {
    inheritedInitializationByHandle.set(
      db as object,
      databaseTargetIdentity(rootDb),
    );
  }

  /**
   * Suppress lazy DDL on a caller-owned transaction.
   *
   * Marker reads may proceed when the table already exists. A missing table
   * raises `BackfillTableUnavailableError` so the caller can fail closed or
   * retry with a root adapter.
   */
  static requireExistingTable(db: DatabaseInterface): void {
    inheritedInitializationByHandle.set(
      db as object,
      databaseTargetIdentity(db),
    );
  }

  /** Forget a root initialization after a schema lifecycle reset. */
  static invalidateInitialization(db: DatabaseInterface): void {
    deleteSharedInitialization(databaseTargetIdentity(db));
  }

  /**
   * Create the `_smrt_backfills` table if it doesn't already exist.
   * Safe to call repeatedly and concurrently.
   */
  async initialize(): Promise<void> {
    if (inheritedInitializationByHandle.has(this.db as object)) {
      return;
    }

    const target = databaseTargetIdentity(this.db);
    const existing = getSharedInitialization(target);
    if (existing) {
      await existing;
      if (!isRootDatabase(this.db)) return;
      try {
        await this.db.query('SELECT 1 FROM _smrt_backfills LIMIT 1');
        return;
      } catch (error) {
        if (!isMissingBackfillTableError(error)) throw error;
        if (getSharedInitialization(target) === existing) {
          deleteSharedInitialization(target);
        }
        return this.initialize();
      }
    }

    if (isRootDatabase(this.db)) {
      const initialization = this.db
        .query(CREATE_SMRT_BACKFILLS_TABLE)
        .then(() => undefined)
        .catch((error) => {
          if (getSharedInitialization(target) === initialization) {
            deleteSharedInitialization(target);
          }
          throw error;
        });
      setSharedInitialization(target, initialization);
      return initialization;
    }

    if (!this.initializePromise) {
      this.initializePromise = this.db
        .query(CREATE_SMRT_BACKFILLS_TABLE)
        .then(() => undefined)
        .catch((error) => {
          this.initializePromise = null;
          throw error;
        });
    }
    return this.initializePromise;
  }

  /** Has the backfill named `name` already run? */
  async isApplied(name: string): Promise<boolean> {
    const result = await this.queryBackfillTable(
      'SELECT 1 FROM _smrt_backfills WHERE name = ? LIMIT 1',
      name,
    );
    return result.rows.length > 0;
  }

  /**
   * Record that the backfill named `name` ran. Uses INSERT ... ON CONFLICT
   * so callers don't need to check `isApplied` first if they don't care
   * about distinguishing "already applied" from "just applied".
   */
  async recordApplied(
    name: string,
    options: { description?: string; packageName?: string } = {},
  ): Promise<void> {
    await this.queryBackfillTable(
      `INSERT INTO _smrt_backfills (name, description, package_name)
       VALUES (?, ?, ?)
       ON CONFLICT (name) DO NOTHING`,
      name,
      options.description ?? null,
      options.packageName ?? null,
    );
  }

  /**
   * Convenience wrapper: if `name` hasn't been applied, run `fn` and
   * record the result. Returns `{ ran, result }`:
   *   - `{ ran: true,  result: T }`    — backfill was pending and `fn` ran
   *   - `{ ran: false, result: null }` — backfill was already applied
   *
   * The discriminator avoids the `T | null` ambiguity an earlier shape had
   * (a backfill that legitimately returns `null` was indistinguishable
   * from "already applied"). Callers check `ran` to decide whether `fn`
   * executed; `result` carries whatever `fn` returned.
   *
   * This is the common pattern an app's migrate orchestration follows:
   * a list of `(name, runner)` pairs, each guarded by isApplied/run/record.
   *
   * **Single-runner only.** This is a check-then-act pattern with no
   * locking: two processes that call `runIfPending` for the same `name`
   * concurrently can both observe `isApplied === false`, both execute
   * `fn`, and only then race to `recordApplied`. The `ON CONFLICT DO
   * NOTHING` in `recordApplied` keeps the table clean but does NOT prevent
   * `fn` from running twice. Acceptable when backfills are run from a
   * single deploy-time migration step (the common case); if you need to
   * fan out backfills across multiple workers, wrap the call in your own
   * mutex (e.g. a Postgres advisory lock keyed by backfill name).
   *
   * **`fn` MUST be idempotent.** The order is `fn` → `recordApplied`, with
   * no surrounding transaction. If `fn` succeeds but `recordApplied`
   * throws (DB connection drops, transient error), the work has happened
   * but is not recorded — the next call sees `isApplied === false` and
   * re-runs `fn`. For non-idempotent work (slug rewrites that consume
   * source rows, one-shot lookups), wrap the entire call in a transaction
   * yourself or structure `fn` so a second execution is a no-op.
   */
  async runIfPending<T>(
    name: string,
    fn: () => Promise<T>,
    options: { description?: string; packageName?: string } = {},
  ): Promise<{ ran: false; result: null } | { ran: true; result: T }> {
    if (await this.isApplied(name)) return { ran: false, result: null };
    const result = await fn();
    await this.recordApplied(name, options);
    return { ran: true, result };
  }

  /** List every recorded backfill, oldest first. */
  async listApplied(): Promise<BackfillRecord[]> {
    const result = await this.queryBackfillTable(
      'SELECT name, applied_at, description, package_name FROM _smrt_backfills ORDER BY applied_at ASC, name ASC',
    );
    return result.rows.map((row) => ({
      name: String(row.name ?? ''),
      appliedAt: normalizeAppliedAt(row.applied_at),
      description: row.description == null ? null : String(row.description),
      packageName: row.package_name == null ? null : String(row.package_name),
    }));
  }

  private async queryBackfillTable(sql: string, ...params: unknown[]) {
    await this.initialize();
    try {
      return await this.db.query(sql, ...params);
    } catch (error) {
      if (!isMissingBackfillTableError(error)) throw error;
      const inheritedRoot = inheritedInitializationByHandle.get(
        this.db as object,
      );
      this.resetInitialization(inheritedRoot);
      if (inheritedRoot) throw new BackfillTableUnavailableError(error);
      await this.initialize();
      return this.db.query(sql, ...params);
    }
  }

  private resetInitialization(inheritedRoot?: object): void {
    this.initializePromise = null;
    inheritedInitializationByHandle.delete(this.db as object);
    deleteSharedInitialization(databaseTargetIdentity(this.db));
    if (inheritedRoot) deleteSharedInitialization(inheritedRoot);
  }
}

function databaseTargetIdentity(db: DatabaseInterface): object {
  const client = db.client;
  return client !== null &&
    (typeof client === 'object' || typeof client === 'function')
    ? client
    : db;
}

function isRootDatabase(db: DatabaseInterface): boolean {
  return typeof db.beginTransaction === 'function';
}

function getSharedInitialization(target: object): Promise<void> | undefined {
  return initializationByObject.get(target);
}

function setSharedInitialization(
  target: object,
  initialization: Promise<void>,
): void {
  initializationByObject.set(target, initialization);
}

function deleteSharedInitialization(target: object): void {
  initializationByObject.delete(target);
}

function isMissingBackfillTableError(error: unknown): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  const missingPattern =
    /(?:no such table|does not exist|doesn't exist|unknown table|not found)/iu;
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === 'string') {
      if (current.includes('_smrt_backfills') && missingPattern.test(current)) {
        return true;
      }
      continue;
    }
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (
      current instanceof Error &&
      current.message.includes('_smrt_backfills') &&
      missingPattern.test(current.message)
    ) {
      return true;
    }
    const details = current as {
      cause?: unknown;
      context?: unknown;
      details?: unknown;
      originalError?: unknown;
    };
    pending.push(
      details.cause,
      details.context,
      details.details,
      details.originalError,
    );
    if (current instanceof AggregateError) pending.push(...current.errors);
  }
  return false;
}

/**
 * Convert a raw `applied_at` cell into an ISO 8601 string.
 *
 * Different DB drivers return this column in different shapes:
 *  - Postgres `node-pg` returns a JS `Date` directly.
 *  - SQLite drivers typically return the `CURRENT_TIMESTAMP` literal
 *    `'YYYY-MM-DD HH:MM:SS'` (no `T`, no timezone). V8's `Date`
 *    constructor parses this as local time, but that's
 *    implementation-defined and other runtimes may return Invalid Date.
 *  - A corrupted row could return any string.
 *
 * If the value parses to a valid Date we return `toISOString()`. If it
 * doesn't (or the column is null/empty), we fall back to the raw string —
 * better to surface a non-ISO timestamp than crash `listApplied()` with a
 * `RangeError` and take down the caller.
 */
function normalizeAppliedAt(value: unknown): string {
  if (value == null || value === '') return '';
  const raw = String(value);
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return raw;
  }
  return parsed.toISOString();
}
