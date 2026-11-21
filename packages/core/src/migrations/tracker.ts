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
import { NULL_EQUAL_INDEX_MARKER } from '../schema/ddl/null-equal-index.js';
// DatabaseEngine comes from the DDL layer (the json-inclusive type that
// `detectEngine` actually returns), matching `SchemaComparer` in differ.ts.
// The migration stack supports the JSON adapter post-R11, so the tracker's
// engine type must include 'json' too — the narrower `migrations/types`
// alias would reject it.
import type { DatabaseEngine } from '../schema/ddl/types.js';
import { shortenIdentifier } from '../schema/index-utils.js';
import type {
  DriftReport,
  MigrationDefinition,
  MigrationResult,
  MigrationStatus,
  SchemaMigrationRecord,
} from '../schema/types.js';
import {
  assertPostgresSystemTimestampsCurrent,
  getDatabaseEngine,
} from '../system/compatibility.js';
import {
  CREATE_SMRT_SCHEMA_MIGRATIONS_TABLE,
  getSystemTableDDLForEngine,
} from '../system/schema.js';
import { toSafeBooleanInteger, toSafeInteger } from '../utils/safe-integer.js';
import { computeChecksum, verifyChecksum } from './checksum.js';
import {
  captureSessionBaseline,
  type DeferredRow,
  deferredLockKey,
  deferredNotStarted,
  deferredRetryRefusal,
  deferredSessionTargets,
  hasPhaseOneMarker,
  phaseOneMarker,
  planDigest,
  recordedPlanDigest,
  restoreSessionBaseline,
  retryPlanMatches,
  type SessionBaseline,
} from './deferred-retry.js';
import {
  type CreateIndexStatement,
  classifyIndexStatement,
  type IndexStatementKind,
  quotePostgresIdentifier,
  readCreateIndexStatement,
} from './postgres-create-index.js';
import { asTableChangedSincePlan } from './rebuild-plan-guard.js';
import { runRetireAwareStatement } from './retire-guard.js';
import { SQLITE_RELAX_REBUILD_MARKER } from './sqlite-rebuild.js';
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
  execution_time_ms?: unknown | null;
  package_name?: string | null;
  source_file?: string | null;
  status: string;
  error_message?: string | null;
  attempts: unknown;
  is_reversible: unknown;
  rolled_back_at?: string | null;
  applied_by?: string | null;
  batch: unknown | null;
}

/** Hydrate integer-backed system-table values at the database boundary. */
function hydrateMigrationRow(row: MigrationRow): SchemaMigrationRecord {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    checksum: row.checksum,
    applied_checksum: row.applied_checksum ?? null,
    applied_at: new Date(row.applied_at),
    execution_time_ms:
      row.execution_time_ms === null || row.execution_time_ms === undefined
        ? null
        : toSafeInteger(row.execution_time_ms, 'Migration execution time'),
    attempts: toSafeInteger(row.attempts ?? 0, 'Migration attempts'),
    is_reversible: toSafeBooleanInteger(
      row.is_reversible ?? 1,
      'Migration reversibility flag',
    ),
    rolled_back_at: row.rolled_back_at ? new Date(row.rolled_back_at) : null,
    package_name: row.package_name ?? null,
    source_file: row.source_file ?? null,
    status: row.status as MigrationStatus,
    error_message: row.error_message ?? null,
    applied_by: row.applied_by ?? null,
    batch:
      row.batch === null || row.batch === undefined
        ? null
        : toSafeInteger(row.batch, 'Migration batch'),
  };
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

/**
 * Whether a statement, read by the PostgreSQL lexer, is index DDL that runs
 * `CONCURRENTLY` (and so cannot run inside a transaction).
 */
function isConcurrentIndexStatement(kind: IndexStatementKind): boolean {
  if (kind.kind === 'unreadable')
    return kind.index !== null && kind.concurrently;
  return (
    (kind.kind === 'create-index' ||
      kind.kind === 'drop-index' ||
      kind.kind === 'reindex') &&
    kind.concurrently
  );
}

/**
 * Prefix of the two statements that close a unique-index swap
 * ({@link swapUniqueIndexRecreates}). Only statements the planner generated
 * carry it, so only those are closed in the schema of the swap's table;
 * authored DDL of the same shape runs as written and PostgreSQL resolves it.
 */
const UNIQUE_INDEX_SWAP_MARKER = '/* smrt:unique-index-swap */';

/**
 * A refusal of index DDL before any statement runs: of the batch (the
 * planner), or of the concurrent index phase (its preflight).
 */
function refuseIndexStatement(
  why: string,
  sql: string,
  before = 'anything ran',
): Error {
  return new Error(
    `${why}, so it was refused under --postgres-safe before ${before}; the migration stays retryable. Statement: ${sql}`,
  );
}

/**
 * Every `CREATE INDEX` bound for the concurrent phase must be one the tracker
 * can check before and after it runs: read with certainty, and named (a
 * retry finds a named index; an unnamed one would be built again). Checked
 * on the whole planned list before anything runs, so a refusal can never
 * follow a drop that already committed.
 */
function assertConcurrentCreatesCheckable(statements: string[]): void {
  for (const sql of statements) {
    if (classifyIndexStatement(sql).kind !== 'create-index') continue;
    const reading = readCreateIndexStatement(sql);
    if (reading.kind !== 'create-index')
      throw refuseIndexStatement(
        `The CREATE INDEX statement could not be read with certainty (${reading.kind === 'unreadable' ? reading.reason : 'not a CREATE INDEX'})`,
        sql,
      );
    if (reading.statement.name === null)
      throw refuseIndexStatement(
        'The CREATE INDEX statement names no index, and a retry could not find the index an interrupted run built (it would build another); name the index',
        sql,
      );
  }
}

/**
 * Whether {@link MigrationTracker.apply} skips `definition` without running
 * it: recorded `completed` with this checksum, neither forced nor reconciled.
 */
function skipsAsApplied(
  definition: MigrationDefinition,
  existing: SchemaMigrationRecord | null,
  checksum: string,
  options: ApplyMigrationsOptions,
): boolean {
  if (existing?.status !== 'completed' || existing.checksum !== checksum)
    return false;
  const force = Boolean(
    options.force || options.forceMigrations?.includes(definition.id),
  );
  return !force && !options.reconcile;
}

/**
 * A `CREATE INDEX` whose expressions or predicate could not be checked
 * before the concurrent phase ran anything. Carries the migration it
 * belongs to.
 */
class ConcurrentIndexRefusal extends Error {
  constructor(
    readonly migrationName: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** `sql` with ` CONCURRENTLY` after its `INDEX` keyword, when it has none. */
function withConcurrently(sql: string, kind: IndexStatementKind): string {
  if (
    (kind.kind !== 'create-index' && kind.kind !== 'drop-index') ||
    kind.concurrently
  )
    return sql;
  return `${sql.slice(0, kind.insertConcurrentlyAt)} CONCURRENTLY${sql.slice(kind.insertConcurrentlyAt)}`;
}

function findConcurrentIndexStatement(
  definitions: MigrationDefinition[],
): { migrationName: string; statement: string } | null {
  for (const definition of definitions) {
    const statement = definition.up.find((sql) =>
      isConcurrentIndexStatement(classifyIndexStatement(sql)),
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
 * The table a `CREATE [UNIQUE] INDEX … ON <table>` statement indexes, as a
 * reference the server resolves exactly as the statement does (each part
 * folded, truncated and quoted as PostgreSQL stores it): `"jobs"`,
 * `"app"."jobs"`. See `postgres-create-index.ts` for how it is read.
 *
 * Returns `null` when the statement is not a CREATE INDEX or cannot be read
 * with certainty: a caller must then not act on the table at all.
 */
export function extractCreatedIndexTable(sql: string): string | null {
  const reading = readCreateIndexStatement(sql);
  return reading.kind === 'create-index' ? reading.statement.relationSql : null;
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
 * Interim `error_message` for a migration whose transactional half has
 * committed but whose `CONCURRENTLY` index build has not run yet. The marker
 * carries the plan digest a retry is checked against.
 */
function concurrentIndexPendingMessage(
  digest: string,
  notStarted: boolean,
): string {
  return `${phaseOneMarker(digest, notStarted)} Concurrent index build pending: the non-index half of this migration committed but the CONCURRENTLY index DDL had not completed. Re-run db:migrate to finish it.`;
}

/**
 * Statements split out of the atomic batch for PostgreSQL concurrent-index
 * mode, keyed by migration definition id.
 */
type ConcurrentIndexPlan = Map<string, PlannedSplit>;

/** One definition's transaction-safe and deferred statements, as planned. */
type PlannedSplit = { regular: string[]; concurrent: string[] };

/**
 * Minimal pinned-session shape used by the concurrent-index phase.
 *
 * `CREATE INDEX CONCURRENTLY` must run outside a transaction, and the
 * `SET lock_timeout` / `SET statement_timeout` that bound it are *session*
 * state — on a pooled adapter a top-level `db.query` may land on a different
 * connection, so the SET would silently not apply to the DDL (issue #2362).
 */
/** The last queued session-state run per shared connection. */
const sharedHandleRuns = new WeakMap<object, Promise<void>>();

/** Whether this run may run a migration's deferred statements now. */
type DeferredClaim = 'ok' | 'held' | 'done' | 'changed';

/**
 * What one {@link MigrationTracker.apply} call checks a retry against. Held
 * per call, never on the tracker, so one call (a dry run) cannot change
 * what a concurrent call on the same tracker checks.
 */
interface ApplyContext {
  /**
   * The atomic batch's concurrent-index plan (its phase 1, or its dry run);
   * `null` when this call plans its definition on its own.
   */
  plan: ConcurrentIndexPlan | null;
  /** The `useConcurrentIndexes` that planned `plan`. */
  routing: boolean;
  /** Filled by phase 1: the row each deferred migration finishes in phase 2. */
  rows: Map<string, DeferredRow> | null;
  /** `false` in a dry run whose batch plan could not be built. */
  guard: boolean;
}

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
  private sqliteRebuildTransactionOwned = false;
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
  /** The parent's `useConcurrentIndexes`, which planned `concurrentIndexPlan`. */
  private concurrentIndexRouting = false;
  /** Filled by phase 1: the row each deferred migration finishes in phase 2. */
  private deferredRows: Map<string, DeferredRow> | null = null;

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
    // The same detection the system-table checks use (`getDatabaseEngine`):
    // with no hint, a handle that speaks PostgreSQL (PGlite at a directory
    // path) is PostgreSQL. URL parsing alone read it as SQLite, so the tracker
    // created SQLite-typed timestamps that the PostgreSQL check then refused.
    return getDatabaseEngine(this.db, this.engineHint);
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

    return (result.rows as MigrationRow[]).map(hydrateMigrationRow);
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
   * Run a check that refuses before anything runs over the batch's
   * definitions. When it refuses, only the definitions {@link apply} would
   * run (not skip as already applied) are checked again, so a definition
   * that will not run neither is refused nor refuses the batch. A batch the
   * check accepts reads nothing.
   */
  private async checkDefinitionsToRun<T>(
    definitions: MigrationDefinition[],
    options: ApplyMigrationsOptions,
    check: (definitions: MigrationDefinition[]) => T | Promise<T>,
  ): Promise<T> {
    try {
      return await check(definitions);
    } catch (refusal) {
      const toRun = await this.definitionsToRun(definitions, options);
      if (toRun.length === definitions.length) throw refusal;
      return await check(toRun);
    }
  }

  /**
   * The batch-wide check of a non-atomic `postgresSafe` batch, before any of
   * its definitions runs. Each definition commits on its own there, so a
   * create refused while a later definition runs would follow an earlier
   * definition's drop that already committed. Every definition is planned
   * (an unreadable or unnamed concurrent create throws), and every pending
   * create is checked against its table in run order (each definition's
   * transactional statements, then its concurrent ones) with the same
   * exception as the atomic concurrent phase. A refusal rejects the batch
   * with nothing run and nothing recorded.
   */
  private async preflightSequentialBatch(
    definitions: MigrationDefinition[],
  ): Promise<void> {
    const lists: Array<{
      migrationName: string;
      statements: string[];
      runsFirst?: boolean;
    }> = [];
    for (const definition of definitions) {
      const { concurrent, regular } = planPostgresStatements(
        definition.up,
        !!this.options.useConcurrentIndexes,
      );
      lists.push(
        { migrationName: definition.id, statements: regular, runsFirst: true },
        { migrationName: definition.id, statements: concurrent },
      );
    }
    if (!lists.some((list) => !list.runsFirst && list.statements.length > 0))
      return;
    const session = await this.acquireMigrationSession();
    let baseline: SessionBaseline | null = null;
    let failure: unknown = null;
    try {
      baseline = await captureSessionBaseline(session);
      await this.applySessionTimeouts(session);
      await this.preflightConcurrentCreates(
        session,
        lists,
        'any migration of the batch ran',
      );
    } catch (error) {
      failure =
        error instanceof ConcurrentIndexRefusal
          ? new Error(`Migration ${error.migrationName}: ${error.message}`, {
              cause: error,
            })
          : error;
    }
    // The tracker's timeouts do not outlive the check on the session. The
    // session is released whatever the restore does, and a failed restore
    // never takes the place of the check's own refusal.
    let restoreFailure: unknown = null;
    try {
      if (baseline) await restoreSessionBaseline(session, baseline);
    } catch (error) {
      restoreFailure = error;
    } finally {
      await session.release();
    }
    if (failure) {
      if (restoreFailure)
        logger.error(
          'Could not restore the migration session settings after the batch check failed',
        );
      throw failure;
    }
    if (restoreFailure) throw restoreFailure;
  }

  /**
   * The definitions {@link apply} would run rather than skip as applied,
   * read without creating the tracking table. History that cannot be read
   * (no tracking table yet) shows nothing applied, so every definition runs.
   */
  private async definitionsToRun(
    definitions: MigrationDefinition[],
    options: ApplyMigrationsOptions,
  ): Promise<MigrationDefinition[]> {
    let rows: MigrationRow[];
    try {
      rows = (
        await this.db.query(
          `SELECT * FROM _smrt_schema_migrations WHERE status = 'completed'`,
        )
      ).rows as MigrationRow[];
    } catch {
      return definitions;
    }
    const records = new Map(
      rows.map((row) => [row.name, hydrateMigrationRow(row)]),
    );
    return definitions.filter(
      (definition) =>
        !skipsAsApplied(
          definition,
          records.get(definition.id) ?? null,
          computeChecksum(definition.up),
          options,
        ),
    );
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
    return hydrateMigrationRow(row);
  }

  /**
   * A migration record read without initializing the tracker (no DDL, no
   * timestamp check), for dry runs. History that cannot be read (no tracking
   * table yet) shows no record.
   */
  private async readMigrationRecord(
    name: string,
  ): Promise<SchemaMigrationRecord | null> {
    let rows: MigrationRow[];
    try {
      rows = (
        await this.db.query(
          `SELECT * FROM _smrt_schema_migrations WHERE name = ? LIMIT 1`,
          name,
        )
      ).rows as MigrationRow[];
    } catch {
      return null;
    }
    const row = rows[0];
    return row ? hydrateMigrationRow(row) : null;
  }

  /**
   * Get the next batch number
   */
  async getNextBatch(): Promise<number> {
    await this.initialize();

    const result = await this.db.query(
      `SELECT MAX(batch) as max_batch FROM _smrt_schema_migrations`,
    );

    const row = result.rows[0] as { max_batch?: unknown } | undefined;
    const maxBatch = toSafeInteger(row?.max_batch ?? 0, 'Migration batch');
    return toSafeInteger(maxBatch + 1, 'Next migration batch');
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
   * Whether a `failed` record's phase 1 committed under this run's plan, so
   * skipping it skips exactly what committed (#5325).
   */
  private phaseOneMatches(
    definition: MigrationDefinition,
    existing: SchemaMigrationRecord | null,
    checksum: string,
    split: PlannedSplit | undefined,
    routing: boolean,
    forced: boolean,
  ): boolean {
    if (
      existing?.status !== 'failed' ||
      existing.checksum !== checksum ||
      !hasPhaseOneMarker(existing.error_message)
    )
      return false;
    return retryPlanMatches({
      recordedMessage: existing.error_message,
      digest: planDigest(
        definition.id,
        checksum,
        split?.regular ?? definition.up,
        split?.concurrent ?? [],
      ),
      regular: split?.regular ?? definition.up,
      concurrent: split?.concurrent ?? [],
      concurrentRouting: routing,
      forced,
    });
  }

  /**
   * Apply a single migration
   */
  async apply(
    definition: MigrationDefinition,
    options: ApplyMigrationsOptions = {},
  ): Promise<MigrationResult> {
    return this.applyOne(definition, options, {
      plan: this.concurrentIndexPlan,
      routing: this.concurrentIndexRouting,
      rows: this.deferredRows,
      guard: true,
    });
  }

  private async applyOne(
    definition: MigrationDefinition,
    options: ApplyMigrationsOptions,
    context: ApplyContext,
  ): Promise<MigrationResult> {
    // A dry run reads the history only: it creates and alters nothing.
    if (!options.dryRun) await this.initialize();
    const startTime = Date.now();
    const checksum = computeChecksum(definition.up);
    // Only an atomic batch splits a definition under the recorded-plan
    // protocol; outside one (`plan` null) a definition runs as before.
    const split = context.plan?.get(definition.id);
    const routing = context.routing;
    const force = Boolean(
      options.force || options.forceMigrations?.includes(definition.id),
    );
    const hasScopedForce = Boolean(options.forceMigrations?.length);
    const namedForce = Boolean(
      options.forceMigrations?.includes(definition.id),
    );

    // Check if migration record already exists
    const existing = options.dryRun
      ? await this.readMigrationRecord(definition.id)
      : await this.getMigration(definition.id);

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

          if (skipsAsApplied(definition, existing, checksum, options)) {
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

        case 'failed': {
          // A retry after phase 1 committed is checked before anything else
          // (dry runs included), so no message below offers a retry that
          // would be refused.
          // Only `--force-migration <id>` skips the check.
          const refusal =
            context.guard && hasPhaseOneMarker(existing.error_message)
              ? deferredRetryRefusal({
                  id: definition.id,
                  recordedMessage: existing.error_message,
                  sameChecksum: existing.checksum === checksum,
                  samePlan: this.phaseOneMatches(
                    definition,
                    existing,
                    checksum,
                    split,
                    routing,
                    namedForce,
                  ),
                  regular: split?.regular ?? definition.up,
                  concurrent: split?.concurrent ?? [],
                  concurrentRouting: routing,
                  forced: namedForce,
                })
              : null;
          if (refusal) {
            return {
              success: false,
              applied: false,
              skipped: false,
              name: definition.id,
              checksum,
              execution_time_ms: 0,
              error: refusal,
            };
          }
          // A scoped force leaves a reconciling run free to retry an unlisted
          // phase-1-committed record the check above accepted.
          const acceptedRetry =
            context.guard && hasPhaseOneMarker(existing.error_message);
          if (
            !force &&
            (!options.reconcile || (hasScopedForce && !acceptedRetry))
          ) {
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
        }

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

    // PostgreSQL concurrent-index mode splits this definition: the
    // transaction-safe statements run here, the CONCURRENTLY index DDL runs
    // after the batch commits.
    const deferredConcurrent = (split?.concurrent.length ?? 0) > 0;

    // A retry of an interrupted concurrent-index migration must not re-run the
    // half that already committed. The marker on the previous attempt's
    // `error_message` says it did, and the checksum says it was this same
    // definition. Without this, a definition that mixes non-idempotent DDL
    // (`ALTER TABLE … ADD COLUMN`, which the differ emits without
    // `IF NOT EXISTS`) with index DDL would fail on "column already exists"
    // forever, never reaching the index build it was retrying for. Whether
    // the retry may run at all was checked above (deferredRetryRefusal).
    // A forced run under another plan or definition runs from statement 1.
    const phase1AlreadyCommitted =
      deferredConcurrent &&
      this.phaseOneMatches(
        definition,
        existing,
        checksum,
        split,
        routing,
        namedForce,
      );
    const firstHalf = phase1AlreadyCommitted
      ? []
      : split
        ? split.regular
        : definition.up;

    // No deferred statement has run when phase 1 runs now, or when the
    // skipped attempt's record still said so.
    const notStarted =
      !phase1AlreadyCommitted || deferredNotStarted(existing?.error_message);
    const digest = planDigest(
      definition.id,
      checksum,
      split?.regular ?? [],
      split?.concurrent ?? [],
    );
    // Get batch number
    if (this.currentBatch === null) {
      this.currentBatch = await this.getNextBatch();
    }

    // Determine if we're updating an existing record or inserting new
    const id = existing?.id || randomUUID();
    const attempts = toSafeInteger(
      (existing?.attempts ?? 0) + 1,
      'Migration attempts',
    );

    if (existing) {
      // Update existing record to 'running'. On PostgreSQL only the record
      // read above is taken over: one another run changed since (finished
      // it, or started it again) is left alone.
      const fenced = this.dbEngine === 'postgres';
      // Not while another run holds this row's deferred phase.
      const takeOver = async (db: DatabaseInterface) => {
        const free =
          !fenced ||
          isTrue(
            (
              await db.query(
                'SELECT pg_try_advisory_xact_lock(hashtextextended(?, 0)) AS locked',
                deferredLockKey(id),
              )
            ).rows[0]?.locked,
          );
        return !free
          ? { rows: [] }
          : await db.query(
              `UPDATE _smrt_schema_migrations
         SET status = 'running', checksum = ?, attempts = ?, error_message = NULL, batch = ?, applied_by = ?, applied_at = CURRENT_TIMESTAMP
         WHERE id = ?${fenced ? ' AND status = ? AND COALESCE(attempts, 0) = ? AND error_message IS NOT DISTINCT FROM ? RETURNING id' : ''}`,
              checksum,
              attempts,
              this.currentBatch,
              hostname(),
              id,
              // The record the retry was checked against, marker included:
              // another run that started its deferred statements meanwhile
              // changed it, and this run takes nothing over.
              ...(fenced
                ? [
                    existing.status,
                    existing.attempts,
                    existing.error_message ?? null,
                  ]
                : []),
            );
      };
      // The row lock is transaction-scoped: it is held through the guarded
      // update only when both run in one transaction (inside an atomic batch
      // that is the batch's own).
      const updated =
        fenced && this.db.transaction
          ? await this.db.transaction((tx) => takeOver(tx as DatabaseInterface))
          : await takeOver(this.db);
      if (fenced && updated.rows.length === 0) {
        return {
          success: false,
          applied: false,
          skipped: false,
          name: definition.id,
          checksum,
          execution_time_ms: 0,
          error: `Migration ${definition.id} was changed by another run while this run started it; nothing was run. Re-run to retry it.`,
        };
      }
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

    try {
      // Execute the migration
      await this.executeStatements(firstHalf, options);

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
          concurrentIndexPendingMessage(digest, notStarted),
          id,
        );
        context.rows?.set(definition.id, {
          id,
          attempts,
          digest,
          notStarted,
        });

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
      // A rebuild that found its table changed since the plan stops by name.
      const migrationError =
        asTableChangedSincePlan(error) ??
        (error instanceof Error ? error : new Error(String(error)));

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
    if (this.dbEngine === 'postgres' && options.postgresSafe && options.atomic)
      assertDistinctMigrationIds(definitions);
    if (
      !options.dryRun &&
      this.needsSqliteRebuildSafety(definitions.flatMap((d) => d.up))
    ) {
      return this.withSqliteRebuildSafety(() =>
        this.applyAll(definitions, options),
      );
    }
    if (options.atomic && !options.dryRun) {
      if (!this.db.transaction) {
        throw new Error(
          'Atomic migration batches require a database adapter with transaction support.',
        );
      }

      const isPostgres = this.dbEngine === 'postgres';
      const concurrentIndexMode = isPostgres && Boolean(options.postgresSafe);
      // Only the definitions that will run are planned and checked: one
      // already recorded `completed` with this checksum is skipped, so its
      // statements must neither be refused nor refuse the batch.
      const plan = concurrentIndexMode
        ? await this.checkDefinitionsToRun(definitions, options, (toRun) =>
            buildConcurrentIndexPlan(toRun, this.options.useConcurrentIndexes),
          )
        : null;

      // Outside concurrent-index mode a CONCURRENTLY statement can only fail:
      // PostgreSQL rejects it inside a transaction block. Fail before opening
      // the transaction so the error names the offending migration.
      if (isPostgres && !concurrentIndexMode) {
        await this.checkDefinitionsToRun(definitions, options, (toRun) => {
          const concurrentStatement = findConcurrentIndexStatement(toRun);
          if (concurrentStatement) {
            throw new Error(
              `Atomic migration batch cannot include CONCURRENTLY index DDL in ${concurrentStatement.migrationName}; PostgreSQL forbids CONCURRENTLY inside a transaction. Re-run with PostgreSQL concurrent-index mode (smrt db:migrate --postgres-safe) to build those indexes outside the batch.`,
            );
          }
        });
      }

      const deferred = plan && plan.size > 0 ? plan : null;
      const deferredRows = new Map<string, DeferredRow>();

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
            engineHint: this.dbEngine,
            lockTimeout: this.options.lockTimeout,
            statementTimeout: this.options.statementTimeout,
            useConcurrentIndexes: false,
          });
          txTracker.concurrentIndexPlan = deferred;
          txTracker.concurrentIndexRouting =
            concurrentIndexMode && this.options.useConcurrentIndexes;
          txTracker.deferredRows = deferredRows;
          txTracker.sqliteRebuildTransactionOwned =
            this.sqliteRebuildTransactionOwned;
          if (this.sqliteRebuildTransactionOwned) {
            await this.assertSqliteForeignKeysSuspended(
              tx as DatabaseInterface,
            );
          }
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

          if (this.sqliteRebuildTransactionOwned)
            await this.checkSqliteForeignKeys(tx as DatabaseInterface);
          return results;
        });

        if (!deferred) {
          return committed;
        }

        return await this.applyDeferredConcurrentIndexes(
          committed,
          deferred,
          deferredRows,
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

    // Each definition commits on its own here, so the whole batch is checked
    // before any of it runs (a definition skipped as applied is not).
    if (
      this.dbEngine === 'postgres' &&
      options.postgresSafe &&
      !options.dryRun
    ) {
      await this.checkDefinitionsToRun(definitions, options, (toRun) =>
        this.onSharedHandle(() => this.preflightSequentialBatch(toRun)),
      );
    }

    const results: MigrationResult[] = [];
    // A dry run writes no record, so it takes no batch number either.
    this.currentBatch = options.dryRun ? null : await this.getNextBatch();
    // `null`: each definition goes through the public `apply()`.
    let context: ApplyContext | null = null;
    // A dry run checks retries against the plan the real run would follow,
    // held for this call only.
    if (
      options.dryRun &&
      options.atomic &&
      options.postgresSafe &&
      this.dbEngine === 'postgres'
    ) {
      try {
        context = {
          plan: await this.checkDefinitionsToRun(
            definitions,
            options,
            (toRun) =>
              buildConcurrentIndexPlan(
                toRun,
                this.options.useConcurrentIndexes,
              ),
          ),
          routing: this.options.useConcurrentIndexes,
          rows: null,
          guard: true,
        };
      } catch {
        // The real run refuses the batch before anything runs.
        context = { plan: null, routing: false, rows: null, guard: false };
      }
    }

    for (const definition of definitions) {
      const result = context
        ? await this.applyOne(definition, options, context)
        : await this.apply(definition, options);
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
   *
   * Each migration starts from the session as it was handed over (a deferred
   * `SET` neither reaches the next migration nor outlives the phase), holds
   * its row's advisory lock while it runs, and records its outcome only over
   * the row its phase 1 wrote, in the schema that holds the tracking table.
   */
  private async applyDeferredConcurrentIndexes(
    committed: MigrationResult[],
    plan: ConcurrentIndexPlan,
    rows: Map<string, DeferredRow>,
    options: ApplyMigrationsOptions,
  ): Promise<MigrationResult[]> {
    return this.onSharedHandle(() =>
      this.runDeferredPhase(committed, plan, rows, options),
    );
  }

  /**
   * Run `work`, which sets session state on the migration session and puts
   * it back, alone on its connection. With `acquireSession` each run has a
   * session of its own. Without it (PGlite: the session is the shared
   * handle) runs over the same handle wait for each other, so one run's
   * deferred `SET` or baseline restore never lands between another run's
   * statements.
   */
  private async onSharedHandle<T>(work: () => Promise<T>): Promise<T> {
    if (typeof this.db.acquireSession === 'function') return work();
    // Wrappers of one handle (a transaction view, a test double that spreads
    // it) keep its `client`, the connection itself.
    const key =
      ((this.db as { client?: unknown }).client as object | undefined) ??
      this.db;
    const previous = sharedHandleRuns.get(key) ?? Promise.resolve();
    let done = () => {};
    const mine = new Promise<void>((resolve) => {
      done = resolve;
    });
    const tail = previous.then(() => mine);
    sharedHandleRuns.set(key, tail);
    await previous;
    try {
      return await work();
    } finally {
      done();
      if (sharedHandleRuns.get(key) === tail) sharedHandleRuns.delete(key);
    }
  }

  private async runDeferredPhase(
    committed: MigrationResult[],
    plan: ConcurrentIndexPlan,
    rows: Map<string, DeferredRow>,
    options: ApplyMigrationsOptions,
  ): Promise<MigrationResult[]> {
    const results = [...committed];
    const table = await this.trackingTableName();
    // The named settings any deferred statement changes, read back after.
    const named = [
      ...new Set(
        [...plan].flatMap(([id, split]) =>
          deferredSessionTargets(id, split.concurrent),
        ),
      ),
    ];
    const session = await this.acquireMigrationSession();
    let baseline: SessionBaseline | null = null;
    let restored = true;

    try {
      baseline = await captureSessionBaseline(session, named);
      const handedOver = baseline;
      await this.applySessionTimeouts(session);

      // Check every pending create before any statement of the phase runs:
      // a refusal must never follow a drop that already committed.
      let refusal: ConcurrentIndexRefusal | null = null;
      try {
        await this.preflightConcurrentCreates(
          session,
          results.flatMap((result) => {
            const statements = plan.get(result.name)?.concurrent ?? [];
            return result.skipped || statements.length === 0
              ? []
              : [{ migrationName: result.name, statements }];
          }),
        );
      } catch (error) {
        if (!(error instanceof ConcurrentIndexRefusal)) throw error;
        refusal = error;
      }

      const invalidIndexes = await this.readInvalidIndexes(session);
      let stoppedBy: string | null = refusal?.migrationName ?? null;

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

        // Each row is claimed by one result only.
        const row = rows.get(result.name);
        rows.delete(result.name);
        if (refusal && result.name === refusal.migrationName) {
          await this.recordConcurrentIndexFailure(table, row, refusal.message);
          results[index] = {
            ...result,
            success: false,
            applied: false,
            skipped: false,
            error: refusal,
          };
          options.onProgress?.(results[index]);
          continue;
        }

        if (stoppedBy) {
          const error = new Error(
            refusal
              ? `Not attempted: the concurrent index phase ran nothing because ${stoppedBy} was refused before it ran`
              : `Not attempted: concurrent index phase stopped after ${stoppedBy} failed`,
          );
          await this.recordConcurrentIndexFailure(table, row, error.message);
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
        let claim: DeferredClaim = 'changed';
        let failure: Error | null = null;

        try {
          await restoreSessionBaseline(session, handedOver);
          await this.applySessionTimeouts(session);
          if (row) claim = await this.claimDeferredRow(session, table, row);
          if (claim === 'ok')
            await this.runConcurrentIndexStatements(
              session,
              split.concurrent,
              invalidIndexes,
            );
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error));
        }

        if (claim !== 'ok' && !failure) {
          // Another run holds, finished, or took over this migration: this run
          // ran nothing of it and writes nothing to its record.
          results[index] =
            claim === 'done'
              ? { ...result, success: true, applied: false, skipped: true }
              : {
                  ...result,
                  success: false,
                  applied: false,
                  skipped: false,
                  error: new Error(
                    claim === 'held'
                      ? `Migration ${result.name}: another run is applying its deferred statements; nothing was run. Re-run once it has finished.`
                      : `Migration ${result.name}: its record changed during this run (another run took it over); nothing was run. Re-run to retry it.`,
                  ),
                };
          if (claim !== 'done' && !options.continueOnError)
            stoppedBy = result.name;
          options.onProgress?.(results[index]);
          continue;
        }

        try {
          // The record is written as the session was handed over, not under
          // a role or path a deferred statement set.
          await restoreSessionBaseline(session, handedOver);
        } catch (error) {
          failure ??= error instanceof Error ? error : new Error(String(error));
        }

        try {
          if (!failure) {
            // Floor at 1ms: older callers read `execution_time_ms === 0` as
            // "nothing ran"; `applied: true` is the authoritative signal.
            const executionTime = Math.max(
              1,
              (result.execution_time_ms ?? 0) + (Date.now() - startedAt),
            );
            const recorded = await this.recordConcurrentIndexSuccess(
              table,
              row as DeferredRow,
              result.checksum,
              executionTime,
            );
            // A record taken over stops the batch like any other failure.
            if (!recorded && !options.continueOnError) stoppedBy = result.name;
            results[index] = recorded
              ? {
                  ...result,
                  success: true,
                  applied: true,
                  skipped: false,
                  execution_time_ms: executionTime,
                }
              : {
                  ...result,
                  success: false,
                  applied: false,
                  skipped: false,
                  execution_time_ms: executionTime,
                  error: new Error(
                    `Migration ${result.name}: another run took its record over while its deferred statements ran; the record was left to that run. Re-run to finish it.`,
                  ),
                };
          } else {
            if (!options.continueOnError) {
              stoppedBy = result.name;
            }
            await this.recordConcurrentIndexFailure(
              table,
              row,
              failure.message,
            );
            results[index] = {
              ...result,
              success: false,
              applied: false,
              skipped: false,
              execution_time_ms: Date.now() - startedAt,
              error: failure,
            };
          }
        } finally {
          if (claim === 'ok' && row)
            await this.releaseDeferredRow(session, row);
        }

        options.onProgress?.(results[index]);
      }
    } finally {
      try {
        if (baseline) await restoreSessionBaseline(session, baseline);
      } catch {
        restored = false;
      } finally {
        await session.release();
      }
    }
    if (!restored) {
      // A pooled session's connection is discarded on release; a shared
      // handle (PGlite) goes back to the caller as it is, so it fails closed.
      if (typeof this.db.acquireSession !== 'function')
        throw new Error(
          'The migration session could not be put back as it was handed over; the migration records were written. Close and reopen the database handle before using it again.',
        );
      logger.warn(
        'Could not restore the migration session before releasing it; its connection is discarded.',
      );
    }
    return results;
  }

  /**
   * Take one migration row's deferred phase: its session advisory lock on the
   * pinned session, then the row read again under the lock. `ok` only while
   * the row is still the `failed` record this run's phase 1 wrote.
   */
  private async claimDeferredRow(
    session: MigrationSession,
    table: string,
    row: DeferredRow,
  ): Promise<DeferredClaim> {
    const locked = await session.query(
      'SELECT pg_try_advisory_lock(hashtextextended(?, 0)) AS locked',
      deferredLockKey(row.id),
    );
    if (!isTrue(locked.rows[0]?.locked)) return 'held';
    let claim: DeferredClaim = 'changed';
    try {
      const current = (
        await session.query(
          `SELECT status, attempts, error_message FROM ${table} WHERE id = ?`,
          row.id,
        )
      ).rows[0];
      claim =
        current?.status === 'completed'
          ? 'done'
          : current?.status === 'failed' &&
              Number(current.attempts) === row.attempts &&
              typeof current.error_message === 'string' &&
              hasPhaseOneMarker(current.error_message) &&
              recordedPlanDigest(current.error_message) === row.digest
            ? 'ok'
            : 'changed';
      if (claim === 'ok' && row.notStarted) {
        // Written ahead of the first deferred statement: from here on a
        // retry can no longer assume none of them ran.
        const cleared = await session.query(
          `UPDATE ${table} SET error_message = ?
            WHERE id = ? AND status = 'failed' AND attempts = ? RETURNING id`,
          concurrentIndexPendingMessage(row.digest, false),
          row.id,
          row.attempts,
        );
        if (cleared.rows.length === 0) claim = 'changed';
        else row.notStarted = false;
      }
    } catch (error) {
      await this.releaseDeferredRow(session, row);
      throw error;
    }
    if (claim !== 'ok') await this.releaseDeferredRow(session, row);
    return claim;
  }

  private async releaseDeferredRow(
    session: MigrationSession,
    row: DeferredRow,
  ): Promise<void> {
    try {
      await session.query(
        'SELECT pg_advisory_unlock(hashtextextended(?, 0))',
        deferredLockKey(row.id),
      );
    } catch {
      // A lost connection released it already.
    }
  }

  /** Bound the pinned session by the tracker's lock and statement timeouts. */
  private async applySessionTimeouts(session: MigrationSession): Promise<void> {
    await session.query(
      `SET lock_timeout = '${formatPostgresTimeout(this.options.lockTimeout)}'`,
    );
    await session.query(
      `SET statement_timeout = '${formatPostgresTimeout(this.options.statementTimeout)}'`,
    );
  }

  /**
   * `_smrt_schema_migrations` qualified by the schema that holds it, resolved
   * on the tracker's own handle before any deferred statement runs. On PGlite
   * that handle is the session, and a deferred `SET search_path` must not
   * move the tracker's writes.
   */
  private async trackingTableName(): Promise<string> {
    const found = await this.db.query(
      `SELECT quote_ident(n.nspname) AS schema_name
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.oid = to_regclass('_smrt_schema_migrations')`,
    );
    const schema = found.rows[0]?.schema_name;
    return typeof schema === 'string'
      ? `${schema}._smrt_schema_migrations`
      : '_smrt_schema_migrations';
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
   * Read every INVALID index, as `index name -> schemas that hold one`.
   *
   * `pg_indexes` (what the SQL adapter's introspection reads) lists an
   * INVALID index exactly like a healthy one, so the schema differ believes a
   * failed `CREATE INDEX CONCURRENTLY` succeeded. `pg_index.indisvalid` is the
   * authoritative flag.
   *
   * The name alone never decides a repair: several schemas may each hold an
   * index of one name, healthy in one and INVALID in another.
   * {@link dropInvalidIndexBeforeCreate} matches the schema too.
   *
   * A role without catalog access degrades to "no known invalid indexes"
   * rather than aborting the migration.
   */
  private async readInvalidIndexes(
    session: MigrationSession,
  ): Promise<Map<string, Set<string>>> {
    const invalid = new Map<string, Set<string>>();

    try {
      const result = await session.query(
        `SELECT n.nspname AS schema_name, c.relname AS index_name
           FROM pg_index i
           JOIN pg_class c ON c.oid = i.indexrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE i.indisvalid = false`,
      );

      for (const row of result.rows) {
        const { index_name: name, schema_name: schema } = row as {
          index_name?: unknown;
          schema_name?: unknown;
        };
        if (typeof name !== 'string') continue;
        const schemas = invalid.get(name) ?? new Set<string>();
        // A catalog that reports no schema cannot name the index to drop.
        if (typeof schema === 'string') schemas.add(schema);
        invalid.set(name, schemas);
      }
    } catch (error) {
      logger.warn(
        `Could not read pg_index.indisvalid; skipping INVALID index repair: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return invalid;
  }

  /**
   * Run one migration's concurrent index statements on the pinned session:
   * the interrupted-build repair before each `CREATE INDEX`, the check after
   * it, and the two closing statements of a unique-index swap
   * ({@link swapUniqueIndexRecreates}) in the schema of the table the swap
   * builds on.
   */
  private async runConcurrentIndexStatements(
    session: MigrationSession,
    statements: string[],
    invalidIndexes: Map<string, Set<string>>,
  ): Promise<void> {
    for (let index = 0; index < statements.length; index++) {
      const sql = statements[index];
      const swap = readSwapClose(statements, index);
      if (swap) {
        await this.closeUniqueIndexSwap(session, swap);
        index += 1;
        continue;
      }
      const kind = classifyIndexStatement(sql);
      if (kind.kind === 'unreadable' && kind.index !== null)
        throw refuseIndexStatement(
          `The index statement could not be read with certainty (${kind.reason})`,
          sql,
        );
      if (kind.kind !== 'create-index') {
        await session.query(sql);
        continue;
      }
      await this.runCreateIndex(session, sql, invalidIndexes);
    }
  }

  /**
   * One pending `CREATE INDEX`, checked before and after it runs.
   *
   * Before: the statement must be read with certainty and its expressions and
   * predicate must be explainable against its table, or nothing runs. The
   * INVALID index an interrupted build left under the name on this table is
   * dropped. A valid index of the name already on the table is the resumed
   * case (an earlier run built it, then failed before recording): when it is
   * the index the statement describes, the create is not replayed (a plain
   * `CREATE INDEX` would fail with "already exists"); when it is another
   * index, the run stops. After: the index of the name must be on the table,
   * valid, and the index the statement describes. Any doubt fails the run,
   * which stays retryable. An unnamed index is refused (the planner refuses
   * it first): a retry could not find what an earlier attempt built.
   */
  private async runCreateIndex(
    session: MigrationSession,
    sql: string,
    invalidIndexes: Map<string, Set<string>>,
  ): Promise<void> {
    const reading = readCreateIndexStatement(sql);
    if (reading.kind !== 'create-index')
      throw new Error(
        `The CREATE INDEX statement could not be read with certainty (${reading.kind === 'unreadable' ? reading.reason : 'not a CREATE INDEX'}), so it was not run; the migration stays retryable. Statement: ${sql}`,
      );
    const statement = reading.statement;
    if (statement.name === null)
      throw refuseIndexStatement(
        'The CREATE INDEX statement names no index, and a retry could not find the index an interrupted run built (it would build another); name the index',
        sql,
      );
    const failure = (why: string) =>
      new Error(
        `PostgreSQL index ${statement.name} on ${statement.relationSql} ${why}. Repair or drop that index, then rerun the migration.`,
      );
    try {
      await this.explainStatementParts(session, statement);
    } catch (error) {
      throw new Error(
        `The CREATE INDEX statement's expressions or predicate cannot be checked against ${statement.relationSql} (${error instanceof Error ? error.message : String(error)}), so it was not run; the migration stays retryable. Statement: ${sql}`,
        { cause: error },
      );
    }
    await this.dropInvalidIndexBeforeCreate(session, statement, invalidIndexes);

    const before = await this.findNamedIndex(session, statement, failure);
    if (before?.valid) {
      if (!(await this.matchesOrFails(session, statement, before.oid, failure)))
        throw failure(
          'already exists and is not the index its statement describes (uniqueness, columns, collation, operator class or predicate differ)',
        );
      logger.info(
        `PostgreSQL index ${statement.name} on ${statement.relationSql} is already built as described; not running its CREATE INDEX again`,
      );
      return;
    }

    await session.query(sql);

    const after = await this.findNamedIndex(session, statement, failure);
    if (!after)
      throw failure(
        'does not exist after its CREATE INDEX: an index of the same name on another table holds the name',
      );
    if (!after.valid)
      throw failure(
        'is INVALID after its CREATE INDEX (an interrupted build holds the name)',
      );
    if (!(await this.matchesOrFails(session, statement, after.oid, failure)))
      throw failure(
        'is not the index its statement describes after its CREATE INDEX (uniqueness, columns, collation, operator class or predicate differ)',
      );
  }

  /** The index of the statement's name on its table, or `null`. */
  private async findNamedIndex(
    session: MigrationSession,
    statement: CreateIndexStatement,
    failure: (why: string) => Error,
  ): Promise<{ oid: unknown; valid: boolean } | null> {
    try {
      const result = await session.query(
        `SELECT i.indexrelid AS index_oid, i.indisvalid AS is_valid
           FROM pg_index i
           JOIN pg_class c ON c.oid = i.indexrelid
          WHERE c.relname = ?
            AND i.indrelid = to_regclass(?)`,
        statement.name,
        statement.relationSql,
      );
      const row = result.rows[0];
      return row ? { oid: row.index_oid, valid: isTrue(row.is_valid) } : null;
    } catch (error) {
      throw failure(
        `could not be confirmed (the catalog read failed: ${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  private async matchesOrFails(
    session: MigrationSession,
    statement: CreateIndexStatement,
    oid: unknown,
    failure: (why: string) => Error,
  ): Promise<boolean> {
    try {
      return await this.indexMatchesStatement(session, statement, oid);
    } catch (error) {
      throw failure(
        `could not be compared with its statement (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  /**
   * PostgreSQL's own normalized form of the statement's expressions and
   * predicate, from `EXPLAIN` against its table: nothing is created or run.
   */
  private async explainStatementParts(
    session: MigrationSession,
    statement: CreateIndexStatement,
  ): Promise<{ expressions: Map<number, string>; predicate: string | null }> {
    const expressions = new Map<number, string>();
    for (const [position, key] of statement.keys.entries())
      if (key.expression !== null)
        expressions.set(
          position,
          await explainExpression(
            session,
            key.expression,
            statement.relationSql,
          ),
        );
    const predicate =
      statement.predicate === null
        ? null
        : await explainPredicate(
            session,
            statement.predicate,
            statement.relationSql,
          );
    return { expressions, predicate };
  }

  /**
   * Before the concurrent phase runs anything, check every `CREATE INDEX` in
   * it (in order, across migrations): its expressions and predicate must be
   * explainable against its table. A create that fails this is refused
   * before any statement of the phase runs, so a refusal can never follow a
   * drop that already committed. The one exception is a create preceded
   * by statements that may make what it names (an `ALTER TABLE … ADD
   * COLUMN` deferred after a foreign-key validation) and by no drop of its
   * own index name: it is checked again where it runs, before it runs. A
   * drop of another index has no bearing on it; a drop of its own name
   * would leave the table without that index if the create were then
   * refused, so that create must be checkable here.
   *
   * A list marked `runsFirst` holds a definition's transactional statements
   * of a non-atomic batch, which run before its concurrent ones: they are
   * not checked here, but their drops and other statements count as above.
   */
  private async preflightConcurrentCreates(
    session: MigrationSession,
    lists: Array<{
      migrationName: string;
      statements: string[];
      runsFirst?: boolean;
    }>,
    before = 'the concurrent index phase ran anything',
  ): Promise<void> {
    let sawOther = false;
    // Index names dropped earlier in the phase, as the server stores them
    // (last part of each name: a qualified drop is matched conservatively).
    const dropped = new Set<string>();
    for (const { migrationName, statements, runsFirst } of lists) {
      for (const sql of statements) {
        const kind = classifyIndexStatement(sql);
        if (kind.kind === 'drop-index') {
          for (const parts of kind.names) dropped.add(parts[parts.length - 1]);
          continue;
        }
        if (kind.kind !== 'create-index') {
          if (kind.kind === 'other' || kind.kind === 'unreadable')
            sawOther = true;
          continue;
        }
        if (runsFirst) continue;
        const reading = readCreateIndexStatement(sql);
        if (reading.kind !== 'create-index' || reading.statement.name === null)
          throw new ConcurrentIndexRefusal(
            migrationName,
            refuseIndexStatement(
              'The CREATE INDEX statement could not be read with certainty or names no index',
              sql,
              before,
            ).message,
          );
        try {
          await this.explainStatementParts(session, reading.statement);
        } catch (error) {
          if (sawOther && !dropped.has(reading.statement.name)) continue;
          throw new ConcurrentIndexRefusal(
            migrationName,
            refuseIndexStatement(
              `The CREATE INDEX statement's expressions or predicate cannot be checked against ${reading.statement.relationSql} (${error instanceof Error ? error.message : String(error)})`,
              sql,
              before,
            ).message,
            { cause: error },
          );
        }
      }
    }
  }

  /**
   * Whether the index `oid` is the index `statement` describes, read from the
   * catalog without creating anything: uniqueness, access method, `NULLS NOT
   * DISTINCT`, each key (column, or expression compared through `EXPLAIN`)
   * with its collation, operator class and ordering, the included columns,
   * and the predicate (through `EXPLAIN`). The index's own definition
   * (`pg_get_indexdef`) is read with the same reader as the statement.
   *
   * - A key the statement writes as an expression that PostgreSQL stored as
   *   a plain column (`((status))`, `((status COLLATE "C"))`, a cast that
   *   changes nothing) is compared as that column, through `EXPLAIN`.
   * - A collation or operator class the statement names is resolved on this
   *   session, as the create resolved it (search path, access method), and
   *   compared by OID with `indcollation` / `indclass`: a same-named object
   *   in another schema is not it. A statement that names none must find
   *   none printed by `pg_get_indexdef` (the default), except that a key
   *   stored as a column from an expression must carry the expression's own
   *   collation.
   */
  private async indexMatchesStatement(
    session: MigrationSession,
    statement: CreateIndexStatement,
    oid: unknown,
  ): Promise<boolean> {
    const row = (
      await session.query(
        `SELECT pg_get_indexdef(i.indexrelid) AS definition,
                pg_get_expr(i.indpred, i.indrelid) AS predicate,
                ARRAY(SELECT k.oid::text
                        FROM unnest(i.indcollation::oid[]) WITH ORDINALITY AS k(oid, at)
                       ORDER BY k.at) AS collation_oids,
                ARRAY(SELECT k.oid::text
                        FROM unnest(i.indclass::oid[]) WITH ORDINALITY AS k(oid, at)
                       ORDER BY k.at) AS opclass_oids
           FROM pg_index i
          WHERE i.indexrelid = ?`,
        oid,
      )
    ).rows[0];
    if (!row) return false;
    const existing = readCreateIndexStatement(String(row.definition ?? ''));
    if (existing.kind !== 'create-index') return false;
    const built = existing.statement;
    if (
      built.unique !== statement.unique ||
      built.method !== statement.method ||
      built.nullsNotDistinct !== statement.nullsNotDistinct ||
      built.keys.length !== statement.keys.length ||
      built.include.join('\u0000') !== statement.include.join('\u0000')
    )
      return false;
    const collations = ((row.collation_oids as unknown[] | null) ?? []).map(
      String,
    );
    const opclasses = ((row.opclass_oids as unknown[] | null) ?? []).map(
      String,
    );
    const mine = await this.explainStatementParts(session, statement);
    for (const [position, key] of statement.keys.entries()) {
      const other = built.keys[position];
      if (
        key.descending !== other.descending ||
        key.nullsFirst !== other.nullsFirst
      )
        return false;
      const columnFromExpression =
        key.expression !== null && other.column !== null;
      if (key.column !== null) {
        if (other.column !== key.column) return false;
      } else {
        const theirs = await explainExpression(
          session,
          other.column !== null
            ? quotePostgresIdentifier(other.column)
            : (other.expression as string),
          statement.relationSql,
        );
        if (theirs !== mine.expressions.get(position)) return false;
      }
      if (key.collation !== null) {
        if (
          (await resolveCollationOid(session, key.collation)) !==
          collations[position]
        )
          return false;
      } else if (columnFromExpression) {
        if (
          (await expressionCollationOid(
            session,
            key.expression as string,
            statement,
          )) !== collations[position]
        )
          return false;
      } else if (other.collation !== null) return false;
      if (key.opclass !== null) {
        if (
          (await resolveOpclassOid(session, statement.method, key.opclass)) !==
          opclasses[position]
        )
          return false;
      } else if (other.opclass !== null) return false;
    }
    if ((row.predicate === null) !== (statement.predicate === null))
      return false;
    if (row.predicate !== null) {
      const theirs = await explainPredicate(
        session,
        String(row.predicate),
        statement.relationSql,
      );
      if (theirs !== mine.predicate) return false;
    }
    return true;
  }

  /**
   * The drop and rename that close a unique-index swap, run in the schema of
   * the table the temporary index was built on. Unqualified, the drop would
   * resolve the old name by the search path and could remove another
   * schema's index; the rename would do the same with the temporary name.
   * The old index is dropped only when it is on that table; one of that name
   * on another table stops the run (the rename could not take the name).
   */
  private async closeUniqueIndexSwap(
    session: MigrationSession,
    swap: { name: string; temporary: string; relationSql: string },
  ): Promise<void> {
    let schema: unknown;
    let holder: unknown;
    try {
      const resolved = await session.query(
        `SELECT n.nspname AS schema_name,
                (SELECT i.indrelid = t.oid
                   FROM pg_class c
                   JOIN pg_index i ON i.indexrelid = c.oid
                  WHERE c.relnamespace = t.relnamespace AND c.relname = ?) AS on_table
           FROM pg_class t
           JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE t.oid = to_regclass(?)`,
        swap.name,
        swap.relationSql,
      );
      schema = resolved.rows[0]?.schema_name;
      holder = resolved.rows[0]?.on_table;
    } catch (error) {
      throw new Error(
        `Could not resolve the table of the unique-index swap for ${swap.name}; nothing was dropped. Rerun the migration: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    if (typeof schema !== 'string')
      throw new Error(
        `The table of the unique-index swap for ${swap.name} (${swap.relationSql}) does not resolve; nothing was dropped. Rerun the migration.`,
      );
    if (holder !== null && holder !== undefined && !isTrue(holder))
      throw new Error(
        `The index name ${swap.name} in schema ${schema} belongs to another table, so the unique-index swap on ${swap.relationSql} cannot take it; nothing was dropped. Rename or drop that index, then rerun the migration.`,
      );
    const qualify = (name: string) =>
      `${quotePostgresIdentifier(schema as string)}.${quotePostgresIdentifier(name)}`;
    await session.query(
      `DROP INDEX CONCURRENTLY IF EXISTS ${qualify(swap.name)}`,
    );
    await session.query(
      `ALTER INDEX IF EXISTS ${qualify(swap.temporary)} RENAME TO ${quotePostgresIdentifier(swap.name)}`,
    );
  }

  /**
   * Before a pending `CREATE INDEX`, drop the INVALID index an earlier failed
   * `CREATE INDEX CONCURRENTLY` left under the same name, so the create
   * rebuilds it: an INVALID index is not usable by the planner and blocks the
   * name, but `CREATE INDEX … IF NOT EXISTS` treats it as present.
   *
   * The index dropped is exactly the one the create would collide with: the
   * INVALID index of the name (as PostgreSQL stores it) whose table is the
   * statement's own target, resolved on this session as the create will
   * resolve it, dropped by its schema-qualified name. A statement that cannot
   * be read with certainty, or whose table cannot be resolved, is not
   * repaired (the check after the create then keeps the migration retryable).
   */
  private async dropInvalidIndexBeforeCreate(
    session: MigrationSession,
    statement: CreateIndexStatement,
    invalidIndexes: Map<string, Set<string>>,
  ): Promise<void> {
    const { name: indexName, relationSql: table } = statement;
    const schemas = indexName ? invalidIndexes.get(indexName) : undefined;
    if (!indexName || !schemas || schemas.size === 0) return;

    let schema: unknown;
    try {
      // The INVALID index of that name whose table is the statement's own
      // target (`indrelid`), resolved as the create will resolve it. An index
      // of the name on any other table, in any schema, is not it.
      const resolved = await session.query(
        `SELECT n.nspname AS schema_name
           FROM pg_index i
           JOIN pg_class c ON c.oid = i.indexrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE i.indisvalid = false
            AND c.relname = ?
            AND i.indrelid = to_regclass(?)`,
        indexName,
        table,
      );
      schema = resolved.rows[0]?.schema_name;
    } catch (error) {
      logger.warn(
        `Could not resolve the table of pending index ${indexName}; skipping INVALID index repair: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    if (typeof schema !== 'string' || !schemas.has(schema)) return;

    logger.warn(
      `Rebuilding INVALID PostgreSQL index ${schema}.${indexName} left by a previous failed CREATE INDEX CONCURRENTLY`,
    );
    await session.query(
      `DROP INDEX CONCURRENTLY IF EXISTS ${quoteIndexName(schema)}.${quoteIndexName(indexName)}`,
    );
    schemas.delete(schema);
  }

  /**
   * Phase-2 outcomes are written only over the row phase 1 wrote, by id and
   * attempt number, while it is still `failed`: a late or stale write never
   * overwrites a record another run completed or took over.
   */
  private async recordConcurrentIndexSuccess(
    table: string,
    row: DeferredRow,
    checksum: string,
    executionTime: number,
  ): Promise<boolean> {
    const written = await this.db.query(
      `UPDATE ${table}
         SET status = 'completed', execution_time_ms = ?, applied_checksum = ?, error_message = NULL, applied_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'failed' AND attempts = ? RETURNING id`,
      executionTime,
      checksum,
      row.id,
      row.attempts,
    );
    return written.rows.length > 0;
  }

  private async recordConcurrentIndexFailure(
    table: string,
    row: DeferredRow | undefined,
    message: string,
  ): Promise<void> {
    if (!row) return;
    try {
      await this.db.query(
        `UPDATE ${table}
           SET status = 'failed', error_message = ?
         WHERE id = ? AND status = 'failed' AND attempts = ?`,
        // Keep the resume marker and its plan: this failure happened *after*
        // phase 1 committed, so the retry must skip the non-index statements.
        `${phaseOneMarker(row.digest, row.notStarted)} ${message}`,
        row.id,
        row.attempts,
      );
    } catch (persistError) {
      logger.error(
        `Failed to persist failed status for migration row ${row.id}: ${
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

    return (result.rows as MigrationRow[]).map(hydrateMigrationRow);
  }

  private needsSqliteRebuildSafety(statements: string[]): boolean {
    return (
      this.dbEngine === 'sqlite' &&
      !this.sqliteRebuildTransactionOwned &&
      statements.includes(SQLITE_RELAX_REBUILD_MARKER)
    );
  }

  private async assertSqliteForeignKeysSuspended(
    db: DatabaseInterface,
  ): Promise<void> {
    const result = await db.query('PRAGMA foreign_keys');
    if (Number(result.rows[0]?.foreign_keys) !== 0) {
      throw new Error(
        'SQLite rebuild requires an exclusive connection outside an active transaction; foreign key suspension failed',
      );
    }
  }

  private async checkSqliteForeignKeys(db: DatabaseInterface): Promise<void> {
    if ((await db.query('PRAGMA foreign_key_check')).rows.length > 0) {
      throw new Error(
        'SQLite rebuild foreign key validation failed; transaction rolled back',
      );
    }
  }

  private async assertSqliteForeignKeySetting(expected: number): Promise<void> {
    const restored = Number(
      (await this.db.query('PRAGMA foreign_keys')).rows[0]?.foreign_keys,
    );
    if (restored !== expected)
      throw new Error(
        'SQLite rebuild could not restore foreign key enforcement',
      );
  }

  /** SQLite ignores FK changes inside a transaction. Verify on both connections. */
  private async withSqliteRebuildSafety<T>(work: () => Promise<T>): Promise<T> {
    if (!this.db.transaction)
      throw new Error('SQLite rebuild requires transaction support');
    const foreignKeys = Number(
      (await this.db.query('PRAGMA foreign_keys')).rows[0]?.foreign_keys,
    );
    const legacy = Number(
      (await this.db.query('PRAGMA legacy_alter_table')).rows[0]
        ?.legacy_alter_table,
    );
    if (![0, 1].includes(foreignKeys) || ![0, 1].includes(legacy))
      throw new Error('Cannot read SQLite rebuild connection settings');
    try {
      await this.db.query(SQLITE_RELAX_REBUILD_MARKER);
      await this.assertSqliteForeignKeysSuspended(this.db);
      this.sqliteRebuildTransactionOwned = true;
      return await work();
    } finally {
      this.sqliteRebuildTransactionOwned = false;
      try {
        await this.db.query(`PRAGMA legacy_alter_table = ${legacy}`);
      } finally {
        await this.db.query(`PRAGMA foreign_keys = ${foreignKeys}`);
        await this.assertSqliteForeignKeySetting(foreignKeys);
      }
    }
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
    if (this.needsSqliteRebuildSafety(statements)) {
      return this.withSqliteRebuildSafety(() =>
        this.executeWithTransaction(statements),
      );
    }
    statements = statements.filter(
      (sql) => sql !== SQLITE_RELAX_REBUILD_MARKER,
    );
    if (this.db.transaction) {
      await this.db.transaction(async (tx) => {
        if (this.sqliteRebuildTransactionOwned)
          await this.assertSqliteForeignKeysSuspended(tx as DatabaseInterface);
        for (const sql of statements) {
          await runRetireAwareStatement(
            (statement) => tx.query(statement),
            this.dbEngine,
            sql,
          );
        }
        if (this.sqliteRebuildTransactionOwned)
          await this.checkSqliteForeignKeys(tx as DatabaseInterface);
      });
    } else {
      // Fallback to sequential execution
      for (const sql of statements) {
        await runRetireAwareStatement(
          (statement) => this.db.query(statement),
          this.dbEngine,
          sql,
        );
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
          await runRetireAwareStatement(
            (statement) => tx.query(statement),
            this.dbEngine,
            sql,
          );
        }
      });
    } else if (finalRegular.length > 0) {
      for (const sql of finalRegular) {
        await runRetireAwareStatement(
          (statement) => this.db.query(statement),
          this.dbEngine,
          sql,
        );
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

      await this.preflightConcurrentCreates(session, [
        { migrationName: '', statements: finalConcurrent },
      ]);
      const invalidIndexes = await this.readInvalidIndexes(session);

      await this.runConcurrentIndexStatements(
        session,
        finalConcurrent,
        invalidIndexes,
      );
    } finally {
      await session.release();
    }
  }
}

/**
 * A `postgresSafe` batch keys each migration's split and phase-2 record by
 * its id, so one id may appear once; refused before anything runs.
 */
function assertDistinctMigrationIds(definitions: MigrationDefinition[]): void {
  const seen = new Set<string>();
  for (const { id } of definitions) {
    if (seen.has(id))
      throw new Error(
        `Migration batch lists ${id} more than once; nothing was run. List each migration once.`,
      );
    seen.add(id);
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

  const splits = definitions.map((definition) => ({
    id: definition.id,
    split: planPostgresStatements(definition.up, useConcurrentIndexes, {
      swapUniqueRecreates: false,
    }),
  }));
  // A same-name UNIQUE recreate spans two definitions (the differ emits
  // `drop_index` then `add_index`); phase 2 runs them in batch order.
  const swapped = swapUniqueIndexRecreates(
    splits.map(({ split }) => split.concurrent),
  );
  splits.forEach(({ id, split }, index) => {
    const concurrent = swapped[index] ?? split.concurrent;
    if (concurrent.length > 0) {
      deferredSessionTargets(id, concurrent);
      plan.set(id, { regular: split.regular, concurrent });
    }
  });

  return plan;
}

const VALIDATE_CONSTRAINT_RE = /\bVALIDATE\s+CONSTRAINT\b/i;

/**
 * Keep a unique index in place while `--postgres-safe` recreates it.
 *
 * A same-name shape-drift repair is `DROP INDEX` followed by `CREATE UNIQUE
 * INDEX` under the same name. Run CONCURRENTLY, the drop commits before the
 * build starts, leaving a window with NO unique index: every
 * `ON CONFLICT (…)` upsert fails (42P10) and plain inserts can write
 * duplicates, which then make the build itself fail. This rewrites the drop
 * into build-then-swap — `CREATE UNIQUE INDEX CONCURRENTLY` under a
 * temporary name, then `DROP INDEX CONCURRENTLY` of the old one, then
 * `ALTER INDEX … RENAME` — so the table always has a unique index over the
 * old or the new key. The later create keeps its `IF NOT EXISTS` and becomes
 * a no-op. Only rewritten when the create carries `IF NOT EXISTS` (the
 * differ's DDL always does).
 *
 * @param lists - concurrent statement lists in execution order
 * @returns the rewritten lists (same length and order)
 */
export function swapUniqueIndexRecreates(lists: string[][]): string[][] {
  const result = lists.map((list) => [...list]);
  for (let li = 0; li < result.length; li++) {
    const list = result[li] ?? [];
    for (let si = 0; si < list.length; si++) {
      // Read by the PostgreSQL lexer: comments, quoting and case are what the
      // server sees, and names are compared and written as it stores them.
      const drop = classifyIndexStatement(list[si] ?? '');
      if (
        drop.kind !== 'drop-index' ||
        !drop.concurrently ||
        drop.names.length !== 1 ||
        drop.names[0].length !== 1
      )
        continue;
      const name = drop.names[0][0];
      const create = findLaterUniqueCreate(result, li, si, name);
      if (!create) continue;
      const temporary = shortenIdentifier(`${name}_smrt_swap`);
      const span = create.statement.nameSpan as { start: number; end: number };
      const buildTemporary = `${create.sql.slice(0, span.start)}${quoteIndexName(temporary)}${create.sql.slice(span.end)}`;
      list.splice(
        si,
        1,
        buildTemporary,
        `${UNIQUE_INDEX_SWAP_MARKER} DROP INDEX CONCURRENTLY IF EXISTS ${quoteIndexName(name)}`,
        `${UNIQUE_INDEX_SWAP_MARKER} ALTER INDEX IF EXISTS ${quoteIndexName(temporary)} RENAME TO ${quoteIndexName(name)}`,
      );
      si += 2;
    }
  }
  return result;
}

function findLaterUniqueCreate(
  lists: string[][],
  fromList: number,
  fromStatement: number,
  name: string,
): { sql: string; statement: CreateIndexStatement } | null {
  for (let li = fromList; li < lists.length; li++) {
    const list = lists[li] ?? [];
    const start = li === fromList ? fromStatement + 1 : 0;
    for (let si = start; si < list.length; si++) {
      const sql = list[si] ?? '';
      const kind = classifyIndexStatement(sql);
      if (kind.kind === 'create-index') {
        const reading = readCreateIndexStatement(sql);
        // An unreadable create of any name ends the search: it is not paired.
        if (reading.kind !== 'create-index') return null;
        const create = reading.statement;
        if (create.name !== name) continue;
        return create.unique && create.concurrently && create.ifNotExists
          ? { sql, statement: create }
          : null;
      }
      if (kind.kind === 'unreadable') return null;
      // Any other drop of the same name first ends the search.
      if (
        kind.kind === 'drop-index' &&
        kind.names.some((parts) => parts[parts.length - 1] === name)
      )
        return null;
    }
  }
  return null;
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
 * - `ALTER TABLE … VALIDATE CONSTRAINT` (a foreign key added `NOT VALID`)
 *   and every later statement of the same migration run outside the
 *   transaction, in order: the validation scan then holds only SHARE UPDATE
 *   EXCLUSIVE (reads and writes continue) instead of the batch's locks.
 * - A same-name UNIQUE recreate (`DROP INDEX` then `CREATE UNIQUE INDEX`) is
 *   rewritten into build-then-swap ({@link swapUniqueIndexRecreates}) so the
 *   table never runs without a unique index between the two statements.
 */
export function planPostgresStatements(
  statements: string[],
  useConcurrentIndexes: boolean,
  options: { swapUniqueRecreates?: boolean } = {},
): { concurrent: string[]; regular: string[] } {
  const concurrent: string[] = [];
  const regular: string[] = [];
  // Once a VALIDATE CONSTRAINT leaves the transaction, every later statement
  // of the same migration follows it, in order (a foreign-key replacement
  // validates its staged constraint, then drops the old one and renames).
  let deferRest = false;

  for (const sql of statements) {
    if (
      useConcurrentIndexes &&
      !deferRest &&
      VALIDATE_CONSTRAINT_RE.test(sql)
    ) {
      deferRest = true;
    }
    const kind = classifyIndexStatement(sql);
    // Index DDL whose leading keywords are read but whose rest is not: it
    // would run outside the concurrent phase's checks (or not concurrently
    // at all), so it is refused before anything runs.
    if (
      kind.kind === 'unreadable' &&
      kind.index !== null &&
      (deferRest || useConcurrentIndexes || kind.concurrently)
    )
      throw refuseIndexStatement(
        `The index statement could not be read with certainty (${kind.reason})`,
        sql,
      );
    if (deferRest && !sql.trimStart().startsWith(NULL_EQUAL_INDEX_MARKER)) {
      concurrent.push(withConcurrently(sql, kind));
      continue;
    }
    if (sql.trimStart().startsWith(NULL_EQUAL_INDEX_MARKER)) {
      if (useConcurrentIndexes) {
        throw new Error(
          'NULL-equal conflict index DDL requires an atomic maintenance-window migration; retry without --postgres-safe. Existing indexes require db:migrate-null-equal-indexes.',
        );
      }
      regular.push(sql);
      continue;
    }
    if (isConcurrentIndexStatement(kind)) {
      concurrent.push(sql);
      continue;
    }
    if (
      useConcurrentIndexes &&
      (kind.kind === 'create-index' || kind.kind === 'drop-index')
    ) {
      concurrent.push(withConcurrently(sql, kind));
      continue;
    }
    regular.push(sql);
  }

  assertConcurrentCreatesCheckable(concurrent);
  if (options.swapUniqueRecreates === false) {
    return { concurrent, regular };
  }
  return {
    concurrent: swapUniqueIndexRecreates([concurrent])[0] ?? concurrent,
    regular,
  };
}

/** `EXPLAIN` output: PostgreSQL's normalized form of a statement. */
async function explainText(
  session: MigrationSession,
  query: string,
): Promise<string> {
  const result = await session.query(`EXPLAIN (VERBOSE, COSTS OFF) ${query}`);
  return result.rows
    .map((row) => String(Object.values(row as Record<string, unknown>)[0]))
    .join('\n');
}

/** An index expression as PostgreSQL normalizes it, against its table. */
function explainExpression(
  session: MigrationSession,
  expression: string,
  relationSql: string,
): Promise<string> {
  return explainText(session, `SELECT ${expression} FROM ONLY ${relationSql}`);
}

/**
 * An index predicate as PostgreSQL normalizes it, against its table. It is
 * explained as an output column, not as a `WHERE` clause: row-level security
 * adds its policies to the scan's filter, and a policy that hides every row
 * makes any two `WHERE` plans the same constant-false plan, while the output
 * column still shows the predicate.
 */
function explainPredicate(
  session: MigrationSession,
  predicate: string,
  relationSql: string,
): Promise<string> {
  return explainText(session, `SELECT (${predicate}) FROM ONLY ${relationSql}`);
}

/** The OID (as text) of the collation `parts` names, resolved on the session. */
async function resolveCollationOid(
  session: MigrationSession,
  parts: string[],
): Promise<string | null> {
  const result = await session.query(
    'SELECT to_regcollation(?)::oid::text AS collation_oid',
    parts.map(quotePostgresIdentifier).join('.'),
  );
  const value = result.rows[0]?.collation_oid;
  return value === null || value === undefined ? null : String(value);
}

/**
 * The OID (as text) of the collation an index expression carries, as the
 * create derives it, evaluated over one row of NULLs typed as the table's
 * columns (no table row is read, so row-level security does not apply).
 * Used only for an expression PostgreSQL stored as a plain column, which
 * has no function to evaluate. A value of a type without collations
 * (integer, boolean, timestamp, uuid) carries OID 0, as `indcollation`
 * records it; its type is read first because `pg_collation_for` raises on
 * such a value instead of returning NULL.
 */
async function expressionCollationOid(
  session: MigrationSession,
  expression: string,
  statement: CreateIndexStatement,
): Promise<string | null> {
  const alias = quotePostgresIdentifier(
    statement.relation[statement.relation.length - 1] ?? '',
  );
  const rows = `FROM (SELECT (NULL::${statement.relationSql}).*) AS ${alias}`;
  const typed = await session.query(
    `SELECT (SELECT t.typcollation <> 0 FROM pg_type t WHERE t.oid = pg_typeof(${expression})::oid) AS collatable ${rows}`,
  );
  const collatable = typed.rows[0]?.collatable;
  if ([false, 'f', 'false', 0].includes(collatable as never)) return '0';
  // A type that could not be read is never taken as "no collation".
  if (!isTrue(collatable)) return null;
  const result = await session.query(
    `SELECT coalesce(to_regcollation(pg_collation_for(${expression}))::oid, 0)::text AS collation_oid ${rows}`,
  );
  const value = result.rows[0]?.collation_oid;
  return value === null || value === undefined ? null : String(value);
}

/**
 * The OID (as text) of the operator class `parts` names for access method
 * `method`, resolved as the create resolves it: the named schema, or the
 * first one on the search path that has it.
 */
async function resolveOpclassOid(
  session: MigrationSession,
  method: string,
  parts: string[],
): Promise<string | null> {
  const result =
    parts.length === 2
      ? await session.query(
          `SELECT oc.oid::text AS opclass_oid
             FROM pg_opclass oc
             JOIN pg_am am ON am.oid = oc.opcmethod
             JOIN pg_namespace n ON n.oid = oc.opcnamespace
            WHERE am.amname = ? AND n.nspname = ? AND oc.opcname = ?`,
          method,
          parts[0],
          parts[1],
        )
      : await session.query(
          `SELECT oc.oid::text AS opclass_oid
             FROM pg_opclass oc
             JOIN pg_am am ON am.oid = oc.opcmethod
            WHERE am.amname = ? AND oc.opcname = ?
              AND pg_opclass_is_visible(oc.oid)`,
          method,
          parts[0],
        );
  const value = result.rows[0]?.opclass_oid;
  return value === null || value === undefined ? null : String(value);
}

/**
 * The two statements {@link swapUniqueIndexRecreates} closes a swap with, at
 * `index` (both carry its marker), and the temporary index's table, read
 * from the statement that built it right before them; `null` when `index`
 * is not such a pair.
 */
function readSwapClose(
  statements: string[],
  index: number,
): { name: string; temporary: string; relationSql: string } | null {
  const generated = (sql: string | undefined) =>
    sql?.trimStart().startsWith(UNIQUE_INDEX_SWAP_MARKER) ?? false;
  // Only the planner's own swap is closed in its table's schema; an authored
  // drop and rename of the same shape run as written.
  if (!generated(statements[index]) || !generated(statements[index + 1]))
    return null;
  const drop = classifyIndexStatement(statements[index] ?? '');
  const rename = classifyIndexStatement(statements[index + 1] ?? '');
  if (
    drop.kind !== 'drop-index' ||
    !drop.concurrently ||
    drop.names.length !== 1 ||
    drop.names[0].length !== 1 ||
    rename.kind !== 'alter-index-rename' ||
    rename.from.length !== 1
  )
    return null;
  const name = drop.names[0][0];
  const temporary = rename.from[0];
  if (rename.to !== name) return null;
  // The planner writes the temporary build right before the two.
  const reading = readCreateIndexStatement(statements[index - 1] ?? '');
  if (reading.kind === 'create-index' && reading.statement.name === temporary)
    return { name, temporary, relationSql: reading.statement.relationSql };
  return null;
}

/** A boolean as the PostgreSQL driver may return it. */
function isTrue(value: unknown): boolean {
  return value === true || value === 't' || value === 'true' || value === 1;
}
