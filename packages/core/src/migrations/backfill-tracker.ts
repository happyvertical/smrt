/**
 * Tracks application-specific data backfills (not schema migrations).
 *
 * Sits next to `MigrationTracker` but is intentionally minimal — backfills
 * have no checksum, no rollback semantics, no DDL. They're "this data
 * correction has run, don't run it again" markers, keyed by a stable
 * backfill name the app chooses.
 *
 * Backed by the `_smrt_backfills` system table (see
 * `../system/schema.ts`). Initialize the table once via `initialize()`
 * before any `isApplied`/`recordApplied` calls — apps that already call
 * the system-table bootstrap can skip the explicit initialize.
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
  private initialized = false;

  constructor(options: BackfillTrackerOptions) {
    this.db = options.db;
  }

  /**
   * Create the `_smrt_backfills` table if it doesn't already exist.
   * Safe to call repeatedly.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.db.query(CREATE_SMRT_BACKFILLS_TABLE);
    this.initialized = true;
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
   * record the result. Returns whatever `fn` returned, or `null` if the
   * backfill was already applied.
   *
   * This is the common pattern an app's migrate orchestration follows:
   * a list of `(name, runner)` pairs, each guarded by isApplied/run/record.
   */
  async runIfPending<T>(
    name: string,
    fn: () => Promise<T>,
    options: { description?: string; packageName?: string } = {},
  ): Promise<T | null> {
    if (await this.isApplied(name)) return null;
    const result = await fn();
    await this.recordApplied(name, options);
    return result;
  }

  /** List every recorded backfill, oldest first. */
  async listApplied(): Promise<BackfillRecord[]> {
    await this.initialize();
    const result = await this.db.query(
      'SELECT name, applied_at, description, package_name FROM _smrt_backfills ORDER BY applied_at ASC',
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
