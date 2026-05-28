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

export class BackfillTracker {
  private readonly db: DatabaseInterface;
  /**
   * Memoized initialization promise. Storing the promise (rather than a
   * `boolean` flag set after the DDL completes) makes `initialize()` safe
   * under concurrency: multiple parallel callers all `await` the same
   * in-flight promise instead of independently re-running the DDL. On
   * error the slot is cleared so the next caller retries — a transient
   * failure doesn't permanently poison the instance.
   */
  private initializePromise: Promise<void> | null = null;

  constructor(options: BackfillTrackerOptions) {
    this.db = options.db;
  }

  /**
   * Create the `_smrt_backfills` table if it doesn't already exist.
   * Safe to call repeatedly and concurrently.
   */
  async initialize(): Promise<void> {
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
    await this.initialize();
    const result = await this.db.query(
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
    await this.initialize();
    await this.db.query(
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
    await this.initialize();
    const result = await this.db.query(
      'SELECT name, applied_at, description, package_name FROM _smrt_backfills ORDER BY applied_at ASC, name ASC',
    );
    return result.rows.map((row) => ({
      name: String(row.name ?? ''),
      appliedAt: row.applied_at
        ? new Date(String(row.applied_at)).toISOString()
        : '',
      description: row.description == null ? null : String(row.description),
      packageName: row.package_name == null ? null : String(row.package_name),
    }));
  }
}
