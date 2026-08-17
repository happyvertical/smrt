/**
 * Migration Tracker
 *
 * Manages migration state, tracking which migrations have been applied,
 * and providing idempotent migration application.
 */

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { createLogger } from '@happyvertical/logger';
import { parsePostgresTimeoutMs } from '../postgres-timeouts.js';
import { detectEngine } from '../schema/ddl/index.js';
// DatabaseEngine comes from the DDL layer (the json-inclusive type that
// `detectEngine` actually returns), matching `SchemaComparer` in differ.ts.
// The migration stack supports the JSON adapter post-R11, so the tracker's
// engine type must include 'json' too — the narrower `migrations/types`
// alias would reject it.
import type { DatabaseEngine } from '../schema/ddl/types.js';
import type {
  DriftReport,
  MigrationDefinition,
  MigrationResult,
  MigrationStatus,
  SchemaMigrationRecord,
} from '../schema/types.js';
import { assertPostgresSystemTimestampsCurrent } from '../system/compatibility.js';
import {
  CREATE_SMRT_SCHEMA_MIGRATIONS_TABLE,
  getSystemTableDDLForEngine,
} from '../system/schema.js';
import { computeChecksum, verifyChecksum } from './checksum.js';
import type {
  ApplyMigrationsOptions,
  DatabaseInterface,
  MigrationTrackerOptions,
  RollbackOptions,
} from './types.js';

const logger = createLogger({ level: 'info' });

/**
 * Row type for _smrt_schema_migrations table
 */
interface MigrationRow {
  id: string;
  name: string;
  version: string;
  checksum: string;
  applied_checksum?: string | null;
  applied_at: string;
  execution_time_ms?: number | null;
  package_name?: string | null;
  source_file?: string | null;
  status: string;
  error_message?: string | null;
  attempts: number;
  is_reversible: number | boolean;
  rolled_back_at?: string | null;
  applied_by?: string | null;
  batch: number;
}

/**
 * Default options for MigrationTracker
 */
const DEFAULT_OPTIONS = {
  lockTimeout: 30000,
  statementTimeout: 60000,
  useConcurrentIndexes: true,
};

class AtomicMigrationRollback extends Error {
  constructor(
    public readonly results: MigrationResult[],
    public readonly failed: MigrationResult,
  ) {
    super(`Atomic migration batch failed at ${failed.name}`);
  }
}

const CONCURRENT_INDEX_STATEMENT_RE =
  /(?:(?:CREATE\s+(?:UNIQUE\s+)?INDEX|DROP\s+INDEX)\s+CONCURRENTLY|REINDEX(?:\s*\([^)]*\))?\s+(?:INDEX|TABLE|SCHEMA|DATABASE|SYSTEM)\s+CONCURRENTLY)/i;

/**
 * Matches the leading clause of a `CREATE [UNIQUE] INDEX` statement and
 * captures the index name, whether it is written bare or double-quoted, and
 * regardless of the optional `CONCURRENTLY` / `IF NOT EXISTS` clauses.
 *
 * Used by the PostgreSQL concurrent-index mode to correlate a pending create
 * with an INVALID index left behind by an earlier failed
 * `CREATE INDEX CONCURRENTLY` (issue #2362).
 */
const CREATE_INDEX_NAME_RE =
  /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:"((?:[^"]|"")+)"|([A-Za-z_][\w$]*))/i;

function findConcurrentIndexStatement(
  definitions: MigrationDefinition[],
): { migrationName: string; statement: string } | null {
  for (const definition of definitions) {
    const statement = definition.up.find((sql) =>
      CONCURRENT_INDEX_STATEMENT_RE.test(sql),
    );

    if (statement) {
      return {
        migrationName: definition.id,
        statement,
      };
    }
  }

  return null;
}

/**
 * Extract the index name from a `CREATE [UNIQUE] INDEX …` statement.
 *
 * Returns the unquoted identifier, or `null` when the statement is not a
 * CREATE INDEX (a drop, a reindex, or unrelated DDL).
 *
 * Exported for unit testing and because the CLI's index rollout needs the
 * same correlation to explain what it repaired.
 */
export function extractCreatedIndexName(sql: string): string | null {
  const match = CREATE_INDEX_NAME_RE.exec(sql);
  if (!match) {
    return null;
  }

  // Group 1 is the quoted form (with `""` escapes), group 2 the bare form.
  return match[1] !== undefined ? match[1].replace(/""/g, '"') : match[2];
}

/**
 * Coerce a caller-supplied timeout to a usable millisecond count.
 *
 * Applied once, in the constructor, so every later read of
 * `this.options.lockTimeout` / `.statementTimeout` is already finite and
 * non-negative. Each timeout falls back to *its own* default — a bad
 * `lockTimeout` must not silently inherit the (much larger) statement-timeout
 * default and weaken the lock bound it was meant to impose.
 */
function resolveTimeoutOption(
  value: number | undefined,
  fallback: number,
): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : fallback;
}

/**
 * Render a millisecond timeout as a PostgreSQL interval literal.
 *
 * PostgreSQL reads `lock_timeout`/`statement_timeout` as milliseconds when
 * given a bare number, but the explicit `ms` unit keeps the emitted SQL
 * self-documenting in migration logs. `0` disables the timeout, which is
 * PostgreSQL's own semantic and therefore preserved verbatim.
 *
 * Input is already normalized by {@link resolveTimeoutOption}.
 */
function formatPostgresTimeout(milliseconds: number): string {
  return `${Math.max(0, Math.trunc(milliseconds))}ms`;
}

/**
 * Parse a PostgreSQL timeout string into milliseconds.
 *
 * The implementation lives in `src/postgres-timeouts.ts`, the leaf module the
 * runtime pool bounds are built from (#2377), so `migrations.postgres.*` and a
 * runtime `timeouts` config are parsed by literally the same function rather
 * than by two copies that can drift. It is re-exported here — and from
 * `./index.ts` — because `@happyvertical/smrt-core/migrations` is the public
 * subpath `db:migrate` reads it through.
 */
export { parsePostgresTimeoutMs };

/**
 * Prefix stamped on the `error_message` of every concurrent-index migration
 * whose transactional half has already committed.
 *
 * This is the resume marker: it is the only durable record that phase 1's
 * statements ran, so a retry can skip straight to the index build. It must
 * therefore be carried by *both* the interim write at the end of phase 1 and
 * every failure recorded during phase 2 — a lock timeout on the index build
 * leaves the non-index DDL committed just as surely as a crash does.
 */
const CONCURRENT_INDEX_PHASE1_MARKER =
  '[smrt: concurrent-index phase 1 committed]';

/**
 * Interim `error_message` for a migration whose transactional half has
 * committed but whose `CONCURRENTLY` index build has not run yet.
 */
const CONCURRENT_INDEX_PENDING_MESSAGE = `${CONCURRENT_INDEX_PHASE1_MARKER} Concurrent index build pending: the non-index half of this migration committed but the CONCURRENTLY index DDL had not completed. Re-run db:migrate to finish it.`;

/**
 * Statements split out of the atomic batch for PostgreSQL concurrent-index
 * mode, keyed by migration definition id.
 */
type ConcurrentIndexPlan = Map<
  string,
  { regular: string[]; concurrent: string[] }
>;

/**
 * Minimal pinned-session shape used by the concurrent-index phase.
 *
 * `CREATE INDEX CONCURRENTLY` must run outside a transaction, and the
 * `SET lock_timeout` / `SET statement_timeout` that bound it are *session*
 * state — on a pooled adapter a top-level `db.query` may land on a different
 * connection, so the SET would silently not apply to the DDL (issue #2362).
 */
interface MigrationSession {
  query: (
    sql: string,
    ...vars: unknown[]
  ) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number }>;
  release: () => Promise<void>;
}

/**
 * MigrationTracker class
 *
 * Provides migration tracking and state management:
 * - Initializes the _smrt_schema_migrations tracking table
 * - Tracks applied migrations with checksums
 * - Provides idempotent migration application
 * - Supports rollback via DOWN scripts
 * - Handles PostgreSQL-specific concerns (CONCURRENTLY, lock timeout)
 */
export class MigrationTracker {
  private db: DatabaseInterface;
  private options: Required<Omit<MigrationTrackerOptions, 'db' | 'engineHint'>>;
  private engineHint?: string;
  private dbEngine: DatabaseEngine;
  /**
   * Memoized initialization promise. Storing the in-flight promise (rather
   * than a `boolean` flag set after the DDL completes) makes `initialize()`
   * safe under concurrency: multiple parallel callers all `await` the same
   * promise instead of independently re-running the DDL. On error the slot
   * is cleared so the next caller retries — a transient failure doesn't
   * permanently poison the instance.
   */
  private initializePromise: Promise<void> | null = null;
  private currentBatch: number | null = null;
  /**
   * Statements deferred out of the current atomic batch by PostgreSQL
   * concurrent-index mode. The parent tracker sets this on the
   * transaction-scoped tracker before phase 1 so `apply()` executes only the
   * transaction-safe statements and leaves the migration record in `running`;
   * the parent finalizes those records after the transaction commits and the
   * `CONCURRENTLY` DDL has run. `null` on every ordinary path.
   */
  private concurrentIndexPlan: ConcurrentIndexPlan | null = null;

  constructor(options: MigrationTrackerOptions) {
    this.db = options.db;
    this.options = {
      lockTimeout: resolveTimeoutOption(
        options.lockTimeout,
        DEFAULT_OPTIONS.lockTimeout,
      ),
      statementTimeout: resolveTimeoutOption(
        options.statementTimeout,
        DEFAULT_OPTIONS.statementTimeout,
      ),
      useConcurrentIndexes:
        options.useConcurrentIndexes ?? DEFAULT_OPTIONS.useConcurrentIndexes,
    };
    this.engineHint = options.engineHint;
    this.dbEngine = this.detectDbEngine();
  }

  /**
   * Detect the database engine. Honors an explicit `engineHint` (passed via
   * `MigrationTrackerOptions`) before falling back to URL parsing — this is
   * the same `detectEngine` contract used by `SchemaComparer` and the rest
   * of the migration stack, so the tracker stays consistent with the DDL
   * the orchestrator generated.
   */
  private detectDbEngine(): DatabaseEngine {
    const dbWithConfig = this.db as DatabaseInterface & {
      config?: { url?: string };
    };
    const url = this.db.url || dbWithConfig.config?.url || '';
    return detectEngine(url, this.engineHint);
  }

  /**
   * Get the current database engine
   */
  getEngine(): DatabaseEngine {
    return this.dbEngine;
  }

  /**
   * Initialize the migrations tracking table
   */
  async initialize(): Promise<void> {
    if (!this.initializePromise) {
      this.initializePromise = this.runInitializeDdl().catch((error) => {
        this.initializePromise = null;
        throw error;
      });
    }
    return this.initializePromise;
  }

  private async runInitializeDdl(): Promise<void> {
    // Parse and execute each statement in the DDL
    const statements = getSystemTableDDLForEngine(
      CREATE_SMRT_SCHEMA_MIGRATIONS_TABLE,
      this.dbEngine,
    )
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    for (const statement of statements) {
      await this.db.query(statement);
    }

    await assertPostgresSystemTimestampsCurrent(this.db, this.engineHint);
  }

  /**
   * Get all applied migrations ordered by applied_at
   */
  async getAppliedMigrations(): Promise<SchemaMigrationRecord[]> {
    await this.initialize();

    const result = await this.db.query(
      `SELECT * FROM _smrt_schema_migrations WHERE status = 'completed' ORDER BY applied_at ASC`,
    );

    return (result.rows as MigrationRow[]).map((row) => ({
      ...row,
      applied_at: new Date(row.applied_at),
      rolled_back_at: row.rolled_back_at ? new Date(row.rolled_back_at) : null,
      is_reversible: Boolean(row.is_reversible),
    })) as SchemaMigrationRecord[];
  }

  /**
   * Get pending migrations (defined but not applied)
   */
  async getPendingMigrations(
    definitions: MigrationDefinition[],
  ): Promise<MigrationDefinition[]> {
    const applied = await this.getAppliedMigrations();
    const appliedNames = new Set(applied.map((m) => m.name));
    return definitions.filter((d) => !appliedNames.has(d.id));
  }

  /**
   * Check if a migration has been applied
   */
  async isApplied(migrationId: string): Promise<boolean> {
    await this.initialize();

    const result = await this.db.query(
      `SELECT 1 FROM _smrt_schema_migrations WHERE name = ? AND status = 'completed' LIMIT 1`,
      migrationId,
    );

    return result.rows.length > 0;
  }

  /**
   * Get a single migration record by name
   */
  async getMigration(name: string): Promise<SchemaMigrationRecord | null> {
    await this.initialize();

    const result = await this.db.query(
      `SELECT * FROM _smrt_schema_migrations WHERE name = ? LIMIT 1`,
      name,
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0] as MigrationRow;
    return {
      ...row,
      applied_at: new Date(row.applied_at),
      rolled_back_at: row.rolled_back_at ? new Date(row.rolled_back_at) : null,
      is_reversible: Boolean(row.is_reversible),
    } as SchemaMigrationRecord;
  }

  /**
   * Get the next batch number
   */
  async getNextBatch(): Promise<number> {
    await this.initialize();

    const result = await this.db.query(
      `SELECT MAX(batch) as max_batch FROM _smrt_schema_migrations`,
    );

    const row = result.rows[0] as { max_batch: number | null } | undefined;
    return (row?.max_batch ?? 0) + 1;
  }

  /**
   * Detect drift between migration definitions and applied migrations
   */
  async detectDrift(
    definitions: MigrationDefinition[],
  ): Promise<DriftReport[]> {
    const applied = await this.getAppliedMigrations();
    const reports: DriftReport[] = [];

    const appliedMap = new Map(applied.map((m) => [m.name, m]));
    const definitionMap = new Map(definitions.map((d) => [d.id, d]));

    // Check each applied migration against definitions
    for (const record of applied) {
      const definition = definitionMap.get(record.name);

      if (!definition) {
        // Migration applied but definition is missing
        reports.push({
          migration_name: record.name,
          expected_checksum: 'N/A',
          actual_checksum: record.checksum,
          drift_type: 'unknown_in_db',
          recommendation:
            'Migration exists in database but definition is missing. Manual cleanup may be required.',
        });
        continue;
      }

      // Check checksum
      const currentChecksum = computeChecksum(definition.up);
      const verification = verifyChecksum(
        currentChecksum,
        record.checksum,
        record.applied_checksum,
      );

      if (!verification.valid) {
        const driftType = verification.drift ?? 'db_modified';
        reports.push({
          migration_name: record.name,
          expected_checksum: record.checksum,
          actual_checksum: currentChecksum,
          drift_type: driftType,
          recommendation:
            driftType === 'file_modified'
              ? 'Migration file was modified after application. Create a new migration instead.'
              : 'Database schema was modified outside of migrations. Review and reconcile manually.',
        });
      }
    }

    return reports;
  }

  /**
   * Apply a single migration
   */
  async apply(
    definition: MigrationDefinition,
    options: ApplyMigrationsOptions = {},
  ): Promise<MigrationResult> {
    await this.initialize();
    const startTime = Date.now();
    const checksum = computeChecksum(definition.up);
    const force = Boolean(
      options.force || options.forceMigrations?.includes(definition.id),
    );
    const hasScopedForce = Boolean(options.forceMigrations?.length);

    // Check if migration record already exists
    const existing = await this.getMigration(definition.id);

    if (existing) {
      // Handle based on existing status
      switch (existing.status) {
        case 'completed':
          if (!force && existing.checksum !== checksum) {
            return {
              success: false,
              applied: false,
              skipped: false,
              name: definition.id,
              checksum,
              execution_time_ms: 0,
              error: `Migration ${definition.id} checksum mismatch. Was already applied with different checksum. Use --force-migration ${definition.id} to override only this migration, or --force to override the whole batch.`,
            };
          }

          if (!force && !options.reconcile) {
            // Already applied, skip
            return {
              success: true,
              applied: false,
              skipped: true,
              name: definition.id,
              checksum,
              execution_time_ms: 0,
            };
          }
          break;

        case 'failed':
          if (!force && (!options.reconcile || hasScopedForce)) {
            return {
              success: false,
              applied: false,
              skipped: false,
              name: definition.id,
              checksum,
              execution_time_ms: 0,
              error: `Migration ${definition.id} previously failed: ${existing.error_message || 'Unknown error'}. Use --force-migration ${definition.id} to retry only this migration, or --force to retry the whole batch.`,
            };
          }
          // Will retry below
          break;

        case 'running':
          if (!force) {
            return {
              success: false,
              applied: false,
              skipped: false,
              name: definition.id,
              checksum,
              execution_time_ms: 0,
              error: `Migration ${definition.id} is currently running or was interrupted. If the previous run crashed, use --force-migration ${definition.id} to retry only this migration, or --force to retry the whole batch.`,
            };
          }
          // Will retry below
          break;

        case 'rolled_back':
          // Rolled back migrations can be re-applied without --force
          break;
      }
    }

    if (options.dryRun) {
      return {
        success: true,
        applied: false,
        skipped: false,
        name: definition.id,
        checksum,
        execution_time_ms: Date.now() - startTime,
      };
    }

    // Get batch number
    if (this.currentBatch === null) {
      this.currentBatch = await this.getNextBatch();
    }

    // Determine if we're updating an existing record or inserting new
    const id = existing?.id || randomUUID();
    const attempts = (existing?.attempts || 0) + 1;

    if (existing) {
      // Update existing record to 'running'
      await this.db.query(
        `UPDATE _smrt_schema_migrations
         SET status = 'running', checksum = ?, attempts = ?, error_message = NULL, batch = ?, applied_by = ?, applied_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        checksum,
        attempts,
        this.currentBatch,
        hostname(),
        id,
      );
    } else {
      // Insert new record
      await this.db.query(
        `INSERT INTO _smrt_schema_migrations
         (id, name, version, checksum, status, attempts, is_reversible, package_name, source_file, applied_by, batch)
         VALUES (?, ?, ?, ?, 'running', 1, ?, ?, ?, ?, ?)`,
        id,
        definition.id,
        definition.version,
        checksum,
        (definition.is_reversible ?? definition.down.length > 0) ? 1 : 0,
        definition.package_name ?? null,
        definition.source_file ?? null,
        hostname(),
        this.currentBatch,
      );
    }

    // PostgreSQL concurrent-index mode splits this definition: the
    // transaction-safe statements run here, the CONCURRENTLY index DDL runs
    // after the batch commits.
    const split = this.concurrentIndexPlan?.get(definition.id);
    const deferredConcurrent = (split?.concurrent.length ?? 0) > 0;

    // A retry of an interrupted concurrent-index migration must not re-run the
    // half that already committed. The marker on the previous attempt's
    // `error_message` says it did, and the checksum says it was this same
    // definition. Without this, a definition that mixes non-idempotent DDL
    // (`ALTER TABLE … ADD COLUMN`, which the differ emits without
    // `IF NOT EXISTS`) with index DDL would fail on "column already exists"
    // forever, never reaching the index build it was retrying for.
    const phase1AlreadyCommitted =
      deferredConcurrent &&
      existing?.status === 'failed' &&
      existing.checksum === checksum &&
      typeof existing.error_message === 'string' &&
      existing.error_message.startsWith(CONCURRENT_INDEX_PHASE1_MARKER);

    try {
      // Execute the migration
      await this.executeStatements(
        phase1AlreadyCommitted ? [] : split ? split.regular : definition.up,
        options,
      );

      const executionTime = Date.now() - startTime;

      if (deferredConcurrent) {
        // Commit this record as `failed`, not `completed` and not `running`.
        // The index does not exist yet, so `completed` would be a lie; and
        // unlike the single-transaction path — where a crash rolls the record
        // insert back with the DDL — this row is about to be committed, so a
        // crash before the concurrent phase finishes would strand a `running`
        // record that the next `db:migrate` can only clear with
        // `--force-migration`. `failed` is retryable under the CLI's
        // reconciling re-run, which is what an interrupted index rollout
        // needs. The concurrent phase overwrites this a moment later.
        await this.db.query(
          `UPDATE _smrt_schema_migrations
           SET status = 'failed', execution_time_ms = ?, error_message = ?
           WHERE id = ?`,
          executionTime,
          CONCURRENT_INDEX_PENDING_MESSAGE,
          id,
        );

        return {
          success: true,
          applied: true,
          skipped: false,
          name: definition.id,
          checksum,
          execution_time_ms: executionTime,
        };
      }

      // Mark as completed
      await this.db.query(
        `UPDATE _smrt_schema_migrations
         SET status = 'completed', execution_time_ms = ?, applied_checksum = ?, applied_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        executionTime,
        checksum,
        id,
      );

      return {
        success: true,
        applied: true,
        skipped: false,
        name: definition.id,
        checksum,
        execution_time_ms: executionTime,
      };
    } catch (error) {
      const migrationError =
        error instanceof Error ? error : new Error(String(error));

      // Mark as failed. In an outer atomic Postgres transaction, a DDL error
      // aborts the transaction and this status write must be skipped so the
      // caller can roll back the whole batch while preserving the root error.
      try {
        await this.db.query(
          `UPDATE _smrt_schema_migrations
           SET status = 'failed', error_message = ?
           WHERE id = ?`,
          migrationError.message,
          id,
        );
      } catch (persistError) {
        // Preserve the migration failure; status persistence is secondary and
        // may be impossible until the surrounding transaction rolls back.
        const persistMessage =
          persistError instanceof Error
            ? persistError.message
            : String(persistError);
        logger.error(
          `Failed to persist failed status for migration ${definition.id}: ${persistMessage}`,
        );
      }

      return {
        success: false,
        applied: false,
        skipped: false,
        name: definition.id,
        checksum,
        execution_time_ms: Date.now() - startTime,
        error: migrationError,
      };
    }
  }

  /**
   * Apply multiple migrations in order.
   *
   * On PostgreSQL the atomic path always bounds itself with
   * `SET LOCAL lock_timeout` / `SET LOCAL statement_timeout` so a migration
   * that queues behind a long-running writer fails fast and rolls back
   * instead of stalling every writer behind its already-held locks
   * (issue #2362).
   *
   * `options.postgresSafe` additionally enables **concurrent-index mode**:
   * non-index DDL still runs in the one atomic transaction, then every index
   * statement runs `CONCURRENTLY` on a pinned session after that transaction
   * commits. That mode trades atomicity for availability — a failure part way
   * through the index phase leaves the committed non-index DDL in place, and
   * the unfinished index migrations are recorded `failed` so the next run
   * retries them, resuming at the index phase rather than re-running the
   * non-index statements that already committed.
   */
  async applyAll(
    definitions: MigrationDefinition[],
    options: ApplyMigrationsOptions = {},
  ): Promise<MigrationResult[]> {
    if (options.atomic && !options.dryRun) {
      if (!this.db.transaction) {
        throw new Error(
          'Atomic migration batches require a database adapter with transaction support.',
        );
      }

      const isPostgres = this.dbEngine === 'postgres';
      const concurrentIndexMode = isPostgres && Boolean(options.postgresSafe);
      const plan = concurrentIndexMode
        ? buildConcurrentIndexPlan(
            definitions,
            this.options.useConcurrentIndexes,
          )
        : null;

      // Outside concurrent-index mode a CONCURRENTLY statement can only fail:
      // PostgreSQL rejects it inside a transaction block. Fail before opening
      // the transaction so the error names the offending migration.
      if (isPostgres && !concurrentIndexMode) {
        const concurrentStatement = findConcurrentIndexStatement(definitions);
        if (concurrentStatement) {
          throw new Error(
            `Atomic migration batch cannot include CONCURRENTLY index DDL in ${concurrentStatement.migrationName}; PostgreSQL forbids CONCURRENTLY inside a transaction. Re-run with PostgreSQL concurrent-index mode (smrt db:migrate --postgres-safe) to build those indexes outside the batch.`,
          );
        }
      }

      const deferred = plan && plan.size > 0 ? plan : null;

      try {
        const committed = await this.db.transaction(async (tx) => {
          const txDb = {
            ...tx,
            transaction: async <T>(
              callback: (transactionDb: DatabaseInterface) => Promise<T>,
            ) => callback(tx as DatabaseInterface),
          } as DatabaseInterface;

          // Bound the whole batch. `SET LOCAL` reverts at COMMIT/ROLLBACK, so
          // this cannot leak onto a pooled connection's next checkout.
          if (isPostgres) {
            await tx.query(
              `SET LOCAL lock_timeout = '${formatPostgresTimeout(this.options.lockTimeout)}'`,
            );
            await tx.query(
              `SET LOCAL statement_timeout = '${formatPostgresTimeout(this.options.statementTimeout)}'`,
            );
          }

          const txTracker = new MigrationTracker({
            db: txDb,
            lockTimeout: this.options.lockTimeout,
            statementTimeout: this.options.statementTimeout,
            useConcurrentIndexes: false,
          });
          txTracker.concurrentIndexPlan = deferred;
          const results = await txTracker.applyAll(definitions, {
            ...options,
            atomic: false,
            continueOnError: false,
            postgresSafe: false,
            // Deferred migrations report progress from the concurrent phase
            // once they have actually finished, not when phase 1 commits.
            onProgress: options.onProgress
              ? (result) => {
                  if (!deferred?.has(result.name)) {
                    options.onProgress?.(result);
                  }
                }
              : undefined,
          });
          const failed = results.find((result) => !result.success);

          if (failed) {
            throw new AtomicMigrationRollback(results, failed);
          }

          return results;
        });

        if (!deferred) {
          return committed;
        }

        return await this.applyDeferredConcurrentIndexes(
          committed,
          deferred,
          options,
        );
      } catch (error) {
        if (error instanceof AtomicMigrationRollback) {
          return error.results.map((result) => {
            if (!result.success || !result.applied) {
              return result;
            }

            return {
              ...result,
              success: false,
              applied: false,
              skipped: false,
              rolled_back: true,
              error: new Error(
                `Rolled back because migration ${error.failed.name} failed`,
              ),
            };
          });
        }

        throw error;
      }
    }

    const results: MigrationResult[] = [];
    this.currentBatch = await this.getNextBatch();

    for (const definition of definitions) {
      const result = await this.apply(definition, options);
      results.push(result);
      options.onProgress?.(result);

      if (!result.success && !options.continueOnError) {
        break;
      }
    }

    this.currentBatch = null;
    return results;
  }

  /**
   * Phase 2 of PostgreSQL concurrent-index mode.
   *
   * Runs every deferred index statement on one pinned session, outside the
   * committed transaction, bounded by session `lock_timeout` /
   * `statement_timeout`. INVALID indexes left behind by an earlier failed
   * `CREATE INDEX CONCURRENTLY` are dropped first so the retry rebuilds them
   * rather than skipping over a stump that reads as present.
   *
   * On failure the batch stops: the failing migration and every migration it
   * did not reach are recorded `failed`, which the CLI's reconciling
   * `db:migrate` retries on the next run.
   */
  private async applyDeferredConcurrentIndexes(
    committed: MigrationResult[],
    plan: ConcurrentIndexPlan,
    options: ApplyMigrationsOptions,
  ): Promise<MigrationResult[]> {
    const results = [...committed];
    const session = await this.acquireMigrationSession();

    try {
      await session.query(
        `SET lock_timeout = '${formatPostgresTimeout(this.options.lockTimeout)}'`,
      );
      await session.query(
        `SET statement_timeout = '${formatPostgresTimeout(this.options.statementTimeout)}'`,
      );

      const invalidIndexes = await this.readInvalidIndexNames(session);
      let stoppedBy: string | null = null;

      for (let index = 0; index < results.length; index++) {
        const result = results[index];
        const split = plan.get(result.name);
        if (!split || split.concurrent.length === 0) {
          continue;
        }

        // A migration phase 1 skipped (already applied, checksum matched) is
        // already `completed` in the tracking table — its index exists and
        // must not be rebuilt or have its record rewritten.
        if (result.skipped) {
          continue;
        }

        if (stoppedBy) {
          const error = new Error(
            `Not attempted: concurrent index phase stopped after ${stoppedBy} failed`,
          );
          await this.recordConcurrentIndexFailure(result.name, error.message);
          results[index] = {
            ...result,
            success: false,
            applied: false,
            skipped: false,
            error,
          };
          options.onProgress?.(results[index]);
          continue;
        }

        const startedAt = Date.now();

        try {
          for (const sql of split.concurrent) {
            const indexName = extractCreatedIndexName(sql);
            if (indexName && invalidIndexes.has(indexName)) {
              // An INVALID index is not usable by the planner and blocks the
              // name, but `CREATE INDEX … IF NOT EXISTS` treats it as present.
              // Drop it so the create below actually rebuilds it.
              logger.warn(
                `Rebuilding INVALID PostgreSQL index ${indexName} left by a previous failed CREATE INDEX CONCURRENTLY`,
              );
              await session.query(
                `DROP INDEX CONCURRENTLY IF EXISTS ${quoteIndexName(indexName)}`,
              );
              invalidIndexes.delete(indexName);
            }

            await session.query(sql);
          }

          // Floor at 1ms: callers (the CLI progress reporter, the applied vs
          // skipped counters) read `execution_time_ms === 0` as "nothing ran".
          const executionTime = Math.max(
            1,
            (result.execution_time_ms ?? 0) + (Date.now() - startedAt),
          );
          await this.recordConcurrentIndexSuccess(
            result.name,
            result.checksum,
            executionTime,
          );
          results[index] = {
            ...result,
            success: true,
            applied: true,
            skipped: false,
            execution_time_ms: executionTime,
          };
        } catch (error) {
          const indexError =
            error instanceof Error ? error : new Error(String(error));
          if (!options.continueOnError) {
            stoppedBy = result.name;
          }
          await this.recordConcurrentIndexFailure(
            result.name,
            indexError.message,
          );
          results[index] = {
            ...result,
            success: false,
            applied: false,
            skipped: false,
            execution_time_ms: Date.now() - startedAt,
            error: indexError,
          };
        }

        options.onProgress?.(results[index]);
      }

      return results;
    } finally {
      await session.release();
    }
  }

  /**
   * Pin one connection for the concurrent-index phase.
   *
   * PostgreSQL pools hand each top-level `query` an arbitrary connection, so
   * a `SET lock_timeout` issued through the pool may not apply to the DDL
   * that follows. Adapters that expose `acquireSession` give us a pinned
   * connection; anything else (SQLite, DuckDB, test doubles) is
   * single-connection anyway and falls back to the plain interface.
   */
  private async acquireMigrationSession(): Promise<MigrationSession> {
    if (typeof this.db.acquireSession === 'function') {
      const session = await this.db.acquireSession();
      return {
        query: (sql, ...vars) => session.query(sql, ...vars),
        release: () => session.release(),
      };
    }

    return {
      query: (sql, ...vars) => this.db.query(sql, ...vars),
      release: async () => {},
    };
  }

  /**
   * Read the names of INVALID indexes that an unqualified index name in this
   * session would actually resolve to.
   *
   * `pg_indexes` (what the SQL adapter's introspection reads) lists an
   * INVALID index exactly like a healthy one, so the schema differ believes a
   * failed `CREATE INDEX CONCURRENTLY` succeeded. `pg_index.indisvalid` is the
   * authoritative flag.
   *
   * Scoped to `current_schemas(false)` — the session's search path — because
   * migration DDL names indexes unqualified, and so does the
   * `DROP INDEX CONCURRENTLY IF EXISTS "<name>"` repair. Scanning every schema
   * would let an unrelated invalid index of the same name in another schema
   * trigger a drop that then resolves to a *different* object. Where the same
   * name appears in several search-path schemas, the earliest on the path wins
   * — the same rule PostgreSQL uses to resolve the name.
   *
   * A role without catalog access degrades to "no known invalid indexes"
   * rather than aborting the migration.
   */
  private async readInvalidIndexNames(
    session: MigrationSession,
  ): Promise<Set<string>> {
    const names = new Set<string>();

    try {
      const result = await session.query(
        `SELECT DISTINCT ON (c.relname) c.relname AS index_name
           FROM pg_index i
           JOIN pg_class c ON c.oid = i.indexrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE i.indisvalid = false
            AND n.nspname = ANY (current_schemas(false))
          ORDER BY c.relname,
                   array_position(current_schemas(false), n.nspname::text)`,
      );

      for (const row of result.rows) {
        const name = (row as { index_name?: unknown }).index_name;
        if (typeof name === 'string') {
          names.add(name);
        }
      }
    } catch (error) {
      logger.warn(
        `Could not read pg_index.indisvalid; skipping INVALID index repair: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return names;
  }

  private async recordConcurrentIndexSuccess(
    name: string,
    checksum: string,
    executionTime: number,
  ): Promise<void> {
    await this.db.query(
      `UPDATE _smrt_schema_migrations
         SET status = 'completed', execution_time_ms = ?, applied_checksum = ?, error_message = NULL, applied_at = CURRENT_TIMESTAMP
       WHERE name = ?`,
      executionTime,
      checksum,
      name,
    );
  }

  private async recordConcurrentIndexFailure(
    name: string,
    message: string,
  ): Promise<void> {
    try {
      await this.db.query(
        `UPDATE _smrt_schema_migrations
           SET status = 'failed', error_message = ?
         WHERE name = ?`,
        // Keep the resume marker: this failure happened *after* phase 1
        // committed, so the retry must skip the non-index statements too.
        `${CONCURRENT_INDEX_PHASE1_MARKER} ${message}`,
        name,
      );
    } catch (persistError) {
      logger.error(
        `Failed to persist failed status for migration ${name}: ${
          persistError instanceof Error
            ? persistError.message
            : String(persistError)
        }`,
      );
    }
  }

  /**
   * Rollback a migration
   */
  async rollback(
    name: string,
    definition: MigrationDefinition,
    options: RollbackOptions = {},
  ): Promise<MigrationResult> {
    await this.initialize();
    const startTime = Date.now();
    const checksum = computeChecksum(definition.down);

    const record = await this.getMigration(name);
    if (!record) {
      return {
        success: false,
        name,
        checksum,
        execution_time_ms: 0,
        error: new Error(`Migration ${name} not found in database`),
      };
    }

    if (record.status !== 'completed') {
      return {
        success: false,
        name,
        checksum,
        execution_time_ms: 0,
        error: new Error(
          `Migration ${name} is not in completed state (current: ${record.status})`,
        ),
      };
    }

    if (!definition.down.length) {
      return {
        success: false,
        name,
        checksum,
        execution_time_ms: 0,
        error: new Error(
          `Migration ${name} is not reversible (no down statements)`,
        ),
      };
    }

    if (options.dryRun) {
      return {
        success: true,
        name,
        checksum,
        execution_time_ms: Date.now() - startTime,
        rolled_back: true,
      };
    }

    try {
      // Execute DOWN statements
      await this.executeStatements(definition.down, {});

      // Mark as rolled back
      await this.db.query(
        `UPDATE _smrt_schema_migrations
         SET status = 'rolled_back', rolled_back_at = CURRENT_TIMESTAMP
         WHERE name = ?`,
        name,
      );

      return {
        success: true,
        name,
        checksum,
        execution_time_ms: Date.now() - startTime,
        rolled_back: true,
      };
    } catch (error) {
      return {
        success: false,
        name,
        checksum,
        execution_time_ms: Date.now() - startTime,
        error: error instanceof Error ? error : new Error(String(error)),
        rolled_back: false,
      };
    }
  }

  /**
   * Get migration history with optional filtering
   */
  async getHistory(
    options: { limit?: number; since?: Date; status?: MigrationStatus } = {},
  ): Promise<SchemaMigrationRecord[]> {
    await this.initialize();

    let sql = `SELECT * FROM _smrt_schema_migrations WHERE 1=1`;
    const params: unknown[] = [];

    if (options.status) {
      sql += ` AND status = ?`;
      params.push(options.status);
    }

    if (options.since) {
      sql += ` AND applied_at >= ?`;
      params.push(options.since.toISOString());
    }

    sql += ` ORDER BY applied_at DESC`;

    if (options.limit) {
      sql += ` LIMIT ?`;
      params.push(options.limit);
    }

    const result = await this.db.query(sql, ...params);

    return (result.rows as MigrationRow[]).map((row) => ({
      ...row,
      applied_at: new Date(row.applied_at),
      rolled_back_at: row.rolled_back_at ? new Date(row.rolled_back_at) : null,
      is_reversible: Boolean(row.is_reversible),
    })) as SchemaMigrationRecord[];
  }

  /**
   * Execute SQL statements with appropriate transaction handling
   */
  private async executeStatements(
    statements: string[],
    options: ApplyMigrationsOptions,
  ): Promise<void> {
    if (this.dbEngine === 'postgres' && options.postgresSafe) {
      await this.executePostgresStatements(statements);
    } else {
      await this.executeWithTransaction(statements);
    }
  }

  /**
   * Execute statements within a transaction (SQLite/DuckDB)
   */
  private async executeWithTransaction(statements: string[]): Promise<void> {
    if (this.db.transaction) {
      await this.db.transaction(async (tx) => {
        for (const sql of statements) {
          await tx.query(sql);
        }
      });
    } else {
      // Fallback to sequential execution
      for (const sql of statements) {
        await this.db.query(sql);
      }
    }
  }

  /**
   * Execute statements with PostgreSQL-specific handling
   *
   * - CONCURRENTLY statements run outside transaction
   * - Regular statements run in transaction with lock_timeout
   *
   * Both CREATE and DROP variants of CONCURRENTLY must be detected — Postgres
   * forbids `DROP INDEX CONCURRENTLY` inside a transaction block, just like
   * the create variant. Issue #1165: the migration generator emits
   * `DROP INDEX CONCURRENTLY` for shape-drift recreates and orphan-index
   * cleanups, so the regex needs to cover both keywords.
   */
  private async executePostgresStatements(statements: string[]): Promise<void> {
    const { concurrent: finalConcurrent, regular: finalRegular } =
      planPostgresStatements(statements, !!this.options.useConcurrentIndexes);

    // CONCURRENTLY statements come from `planPostgresStatements`, which
    // also pushes any post-transform CREATE/DROP CONCURRENTLY into the
    // outside-transaction set. The original `concurrentStatements` list
    // is folded in there too so callers below see one merged stream.

    // Execute regular statements in transaction with timeouts
    if (finalRegular.length > 0 && this.db.transaction) {
      await this.db.transaction(async (tx) => {
        // Set session-level timeouts
        await tx.query(
          `SET LOCAL lock_timeout = '${formatPostgresTimeout(this.options.lockTimeout)}'`,
        );
        await tx.query(
          `SET LOCAL statement_timeout = '${formatPostgresTimeout(this.options.statementTimeout)}'`,
        );

        for (const sql of finalRegular) {
          await tx.query(sql);
        }
      });
    } else if (finalRegular.length > 0) {
      for (const sql of finalRegular) {
        await this.db.query(sql);
      }
    }

    if (finalConcurrent.length === 0) {
      return;
    }

    // Execute CONCURRENTLY statements outside the transaction, on one pinned
    // connection so `SET lock_timeout` / `SET statement_timeout` actually
    // govern the DDL that follows them (a pooled `db.query` may not reuse the
    // connection the SET landed on).
    const session = await this.acquireMigrationSession();
    try {
      await session.query(
        `SET lock_timeout = '${formatPostgresTimeout(this.options.lockTimeout)}'`,
      );
      await session.query(
        `SET statement_timeout = '${formatPostgresTimeout(this.options.statementTimeout)}'`,
      );

      const invalidIndexes = await this.readInvalidIndexNames(session);

      for (const sql of finalConcurrent) {
        const indexName = extractCreatedIndexName(sql);
        if (indexName && invalidIndexes.has(indexName)) {
          logger.warn(
            `Rebuilding INVALID PostgreSQL index ${indexName} left by a previous failed CREATE INDEX CONCURRENTLY`,
          );
          await session.query(
            `DROP INDEX CONCURRENTLY IF EXISTS ${quoteIndexName(indexName)}`,
          );
          invalidIndexes.delete(indexName);
        }

        await session.query(sql);
      }
    } finally {
      await session.release();
    }
  }
}

/**
 * Quote an index identifier for PostgreSQL, escaping embedded double quotes.
 */
function quoteIndexName(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Build the PostgreSQL concurrent-index plan for an atomic batch.
 *
 * Returns one entry per migration definition that has at least one statement
 * which must leave the transaction, mapping it to the transaction-safe
 * statements (phase 1) and the `CONCURRENTLY` statements (phase 2).
 * Definitions with nothing to defer are omitted so the caller can treat
 * `plan.has(id)` as "this migration finishes in phase 2".
 *
 * Exported for unit testing.
 */
export function buildConcurrentIndexPlan(
  definitions: MigrationDefinition[],
  useConcurrentIndexes: boolean,
): ConcurrentIndexPlan {
  const plan: ConcurrentIndexPlan = new Map();

  for (const definition of definitions) {
    const split = planPostgresStatements(definition.up, useConcurrentIndexes);
    if (split.concurrent.length > 0) {
      plan.set(definition.id, split);
    }
  }

  return plan;
}

/**
 * Split a batch of SQL statements into a transaction-safe set and a
 * concurrent set, applying `--postgres-safe` rewriting if requested.
 *
 * Exported for unit testing and to give external callers a way to
 * reason about what the tracker would execute in PostgreSQL safe mode.
 *
 * Rules:
 * - Statements already containing `CONCURRENTLY` for CREATE/DROP INDEX or
 *   REINDEX operations always go to the concurrent set — Postgres rejects
 *   them inside transactions.
 * - When `useConcurrentIndexes` is true, plain `CREATE INDEX` and plain
 *   `DROP INDEX` are rewritten to use `CONCURRENTLY`, then routed to
 *   the concurrent set. This is what the CLI `--postgres-safe` flag and
 *   the auto-migrate path rely on for issue #1165's shape-drift drops.
 * - All other statements stay in the regular (transaction) set.
 */
export function planPostgresStatements(
  statements: string[],
  useConcurrentIndexes: boolean,
): { concurrent: string[]; regular: string[] } {
  const concurrentRegex = CONCURRENT_INDEX_STATEMENT_RE;

  const concurrent: string[] = [];
  const regular: string[] = [];

  for (const sql of statements) {
    if (concurrentRegex.test(sql)) {
      concurrent.push(sql);
      continue;
    }
    if (useConcurrentIndexes) {
      if (/CREATE\s+(UNIQUE\s+)?INDEX\s+(?!CONCURRENTLY)/i.test(sql)) {
        concurrent.push(
          sql.replace(
            /CREATE\s+(UNIQUE\s+)?INDEX\s+/i,
            'CREATE $1INDEX CONCURRENTLY ',
          ),
        );
        continue;
      }
      if (/DROP\s+INDEX\s+(?!CONCURRENTLY)/i.test(sql)) {
        concurrent.push(
          sql.replace(/DROP\s+INDEX\s+/i, 'DROP INDEX CONCURRENTLY '),
        );
        continue;
      }
    }
    regular.push(sql);
  }

  return { concurrent, regular };
}
