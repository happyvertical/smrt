/**
 * High-level "make my SMRT app's schema match its database" orchestration.
 *
 * Wraps `ObjectRegistry.getAllSchemasAsDefinitions()` → `generateSchemaDiff`
 * → `MigrationTracker.applyAll`. Apps that just want to run pending
 * schema changes call `migrateSmrtSchemas({ db, packageName, version })`
 * and don't have to assemble the migration definition by hand.
 *
 * The migration name is timestamped, so re-running on an up-to-date
 * database is a no-op (the diff is empty, no statements are generated,
 * `applied: false` is returned).
 */

import { createLogger } from '@happyvertical/logger';
import type { DatabaseInterface } from '@happyvertical/sql';
import { ObjectRegistry } from '../registry.js';
import { getDDLStrategy } from '../schema/ddl/index.js';
import type { DatabaseEngine } from '../schema/ddl/types.js';
import { planForeignKeyCreation } from '../schema/foreign-key-planner.js';
import type { MigrationResult, SchemaChange } from '../schema/types.js';
import { decideSchemaChange, isCommentOnlySql } from './change-kinds.js';
import {
  generateSchemaDiff,
  getSQLFromChanges,
  hasActionableChanges,
  isAdvisoryOnlyChange,
  resolveMigrationEngine,
} from './differ.js';
import {
  createMigrationDefinition,
  generateMigrationTimestamp,
} from './generator.js';
import {
  collectMigrateRecordInput,
  readLastMigrateRecord,
  recordSuccessfulMigrate,
} from './migrate-record.js';
import {
  decideMigrationRun,
  type MigrationRunDecision,
} from './migration-run-decision.js';
import { MigrationTracker } from './tracker.js';

const logger = createLogger({ level: 'info' });

/**
 * A live constraint the migrator relaxes to match the manifest: `DROP NOT NULL`
 * on a manifest-nullable column (automatic on PostgreSQL, #4897) or, with
 * `relaxColumns`, `DROP DEFAULT`. Listed per column so none is applied silently.
 */
export interface RelaxedColumn {
  table: string;
  column: string;
  alteration: 'drop_not_null' | 'drop_default';
}

/** Executable constraint relaxations in a diff, one entry per column. */
export function collectRelaxedColumns(
  diff: Awaited<ReturnType<typeof generateSchemaDiff>>,
): RelaxedColumn[] {
  const relaxed: RelaxedColumn[] = [];
  for (const change of diff.changes) {
    if (
      change.type !== 'alter_column' ||
      !change.name ||
      (change.alteration !== 'drop_not_null' &&
        change.alteration !== 'drop_default') ||
      isAdvisoryOnlyChange(change)
    ) {
      continue;
    }
    const statements = change.sqlStatements ?? (change.sql ? [change.sql] : []);
    if (statements.every((statement) => statement.trim().startsWith('--'))) {
      continue;
    }
    relaxed.push({
      table: change.table,
      column: change.name,
      alteration: change.alteration,
    });
  }
  return relaxed;
}

export interface MigrateSmrtSchemasOptions {
  db: DatabaseInterface;
  /** Stored on the migration record so the audit log shows which app applied it. */
  packageName: string;
  /**
   * Stored on the migration record. Typically the app's package.json
   * version. Optional because most apps don't have a runtime-readable
   * version handy and would hardcode a stale string if forced to supply
   * one — `'unknown'` is honest. Pass an explicit value when you can
   * (e.g. `version: process.env.APP_VERSION`).
   */
  version?: string;
  /** Override the description on the synthetic migration definition. */
  description?: string;
  /** Override the migration name (default: `<timestamp>_smrt_schema_sync`). */
  name?: string;
  /** Forwarded to MigrationTracker — defaults to true for pg-safe runs. */
  postgresSafe?: boolean;
  /** Forwarded to MigrationTracker — defaults to true. */
  reconcile?: boolean;
  /** Forwarded to MigrationTracker — defaults to true for `CREATE INDEX CONCURRENTLY`. */
  useConcurrentIndexes?: boolean;
  /**
   * Forwarded to MigrationTracker (Postgres lock timeout, milliseconds).
   * Lets apps that customize tracker timeouts directly preserve their
   * tuning when going through the orchestrator. Falls back to the
   * tracker's default (30000ms) when omitted.
   */
  lockTimeout?: number;
  /**
   * Forwarded to MigrationTracker (Postgres statement timeout, ms). Falls
   * back to the tracker's default (60000ms) when omitted.
   */
  statementTimeout?: number;
  /**
   * Explicit engine hint forwarded to `detectEngine`, `SchemaComparer`, and
   * `MigrationTracker`. Useful when `db.url` doesn't unambiguously identify
   * the engine (e.g. the JSON adapter, which uses DuckDB internally and may
   * not be recognizable by URL alone). All three layers honor the same hint
   * so the generated DDL, drift comparison, and execution path stay
   * consistent — without it, an empty-URL connection could produce
   * Postgres-flavored DDL but run through the SQLite tracker path.
   *
   * Typed as `DatabaseEngine` so unsupported values (e.g. `'mysql'`) fail at
   * compile time rather than silently falling back to `'sqlite'` at runtime.
   */
  engineHint?: DatabaseEngine;
  /**
   * Confirm that historical PostgreSQL Date writers used UTC wall times before
   * reinterpreting legacy TIMESTAMP/TEXT/JSON columns as TIMESTAMPTZ.
   */
  postgresTimestampMigration?: { legacyTimezone: 'UTC' };
  /**
   * Store empty or whitespace-only text as NULL when converging a nullable
   * legacy `text` column to a typed column (#3226). See
   * `DiffOptions.emptyTextAsNull`.
   */
  emptyTextAsNull?: boolean;
  /** Explicitly allow relaxing live column constraints. */
  relaxColumns?: boolean;
  /** Exact package removals explicitly confirmed by the caller. */
  confirmRemovedPackages?: string[];
}

export interface MigrateSmrtSchemasResult
  extends Omit<MigrationRunDecision<SchemaChange>, 'proceed'> {
  /** True when any stop refused the entire run, before tracker bootstrap. */
  refused: boolean;
  applied: boolean;
  results: MigrationResult[];
  statements: string[];
  schemaCount: number;
  /**
   * Exactly the stop decisions from change-kinds.ts. Reports, including
   * warning-level orphan columns and unrequested relaxations, are excluded.
   * Inspect diff.changes for those reports even when this array is empty.
   */
  unactionableChanges: SchemaChange[];
  /**
   * Convenience: `unactionableChanges.length > 0`. Lets a caller write
   * `if (result.hasManualDrift) ...` without iterating the array first,
   * and makes the case visible to anyone scanning the result shape (the
   * full array is easy to gloss over when `applied: false`).
   */
  hasManualDrift: boolean;
  /**
   * Constraint relaxations in `statements`, one per column (`DROP NOT NULL` on
   * manifest-nullable columns by default on PostgreSQL, #4897).
   */
  relaxedColumns: RelaxedColumn[];
}

export interface PendingSchemaStatementsResult {
  decision: MigrationRunDecision<SchemaChange>;
  diff: Awaited<ReturnType<typeof generateSchemaDiff>>;
  statements: string[];
  schemaCount: number;
  hasChanges: boolean;
  /**
   * Schema changes the differ detected but that have no executable SQL
   * (incompatible `type_mismatch` entries, or `type_upgrade` entries whose
   * only generated SQL is an advisory comment because the engine cannot
   * upgrade the column in place — e.g. SQLite type widening). Surfacing
   * these lets status commands distinguish "no drift" from "drift the
   * orchestrator can't fix on its own."
   */
  unactionableChanges: SchemaChange[];
  /**
   * Convenience: `unactionableChanges.length > 0`. Mirrors the
   * `MigrateSmrtSchemasResult.hasManualDrift` shortcut.
   */
  hasManualDrift: boolean;
  /**
   * Constraint relaxations in `statements`, one per column (`DROP NOT NULL` on
   * manifest-nullable columns by default on PostgreSQL, #4897).
   */
  relaxedColumns: RelaxedColumn[];
}

/**
 * Compute the SQL statements needed to bring `db` in sync with the
 * currently-registered SMRT object schemas. Pure inspection — no writes.
 *
 * Useful for status commands ("how far behind is the schema?") and as the
 * inner step of `migrateSmrtSchemas`.
 *
 * **Note on the returned `statements`:** these are the engine-correct DDL
 * statements as the differ + DDL strategy produce them, *prior to* any
 * Postgres-specific rewrites the `MigrationTracker` applies at execution
 * time (e.g. rewriting `CREATE INDEX` → `CREATE INDEX CONCURRENTLY` and
 * moving CONCURRENTLY statements outside the surrounding transaction).
 * The list is suitable for preview/status/"what would change?" use cases.
 * For the exact byte-for-byte SQL the tracker ran, inspect the
 * `MigrationResult`s from `migrateSmrtSchemas` or the tracker's own logs.
 */
export async function getPendingSchemaStatements(
  db: DatabaseInterface,
  options: {
    engineHint?: DatabaseEngine;
    postgresTimestampMigration?: { legacyTimezone: 'UTC' };
    emptyTextAsNull?: boolean;
    /** Explicitly allow relaxing live column constraints. */
    relaxColumns?: boolean;
  } = {},
): Promise<PendingSchemaStatementsResult> {
  const schemas = ObjectRegistry.getAllSchemasAsDefinitions();
  // Forward engineHint into the diff itself so the SchemaComparer's
  // existing-table SQL (ALTER/index drift) uses the same DDL strategy
  // we use for newly-added tables — otherwise the two halves of the
  // statement list can land on different engines (split-brain) when
  // `db.url` is empty or ambiguous.
  const diff = await generateSchemaDiff(db, schemas, {
    engineHint: options.engineHint,
    postgresTimestampMigration: options.postgresTimestampMigration,
    emptyTextAsNull: options.emptyTextAsNull,
    relaxColumns: options.relaxColumns,
  });
  const statements = collectStatementsFromDiff(diff, db, options.engineHint);
  const unactionableChanges = collectUnactionableChanges(
    diff,
    resolveMigrationEngine(db, options.engineHint),
  );
  return {
    diff,
    decision: decideMigrationRun({
      changes: diff.changes,
      addedTables: diff.added_tables,
      engine: resolveMigrationEngine(db, options.engineHint),
    }),
    schemaCount: Object.keys(schemas).length,
    statements,
    hasChanges: hasActionableChanges(diff),
    unactionableChanges,
    hasManualDrift: unactionableChanges.length > 0,
    relaxedColumns: collectRelaxedColumns(diff),
  };
}

/**
 * Apply any pending schema changes from `ObjectRegistry` to `db`.
 *
 * Returns `applied: false` (with no error) if the database is already in
 * sync. Throws on the first migration failure with the underlying error
 * preserved (callers should let it propagate to the CLI).
 *
 * **Note on the returned `statements`:** mirrors `getPendingSchemaStatements`
 * — the list is the planned DDL, prior to Postgres-specific tracker rewrites
 * (CONCURRENTLY, transaction reordering). The actual executed SQL is
 * tracked in the returned `results`.
 *
 * **Note on `applied` semantics under `reconcile: true` (the default):**
 * the tracker may re-execute a migration that is already in `completed`
 * state when the checksum matches — that counts as `applied: true` in the
 * returned `MigrationResult`. So `result.applied === true` means "the
 * tracker ran the migration", not specifically "the database changed for
 * the first time." Pass `reconcile: false` if you need to distinguish a
 * fresh apply from a reconcile-replay over an existing completed record.
 *
 * **Note on repeated failures:** the migration name defaults to a fresh
 * timestamp on every call, so a sequence of failed runs leaves one
 * `failed` row in `_smrt_schema_migrations` per attempt. Pass an explicit
 * `name` if you want to overwrite the same record across retries.
 *
 * A stop refuses the whole run before tracker bootstrap. `refused`, `stops`,
 * and `heldBack` expose that decision directly; wrappers need no policy of
 * their own. `unactionableChanges` and `hasManualDrift` remain available.
 */
export async function migrateSmrtSchemas(
  options: MigrateSmrtSchemasOptions,
): Promise<MigrateSmrtSchemasResult> {
  const pending = await getPendingSchemaStatements(options.db, {
    engineHint: options.engineHint,
    postgresTimestampMigration: options.postgresTimestampMigration,
    emptyTextAsNull: options.emptyTextAsNull,
    relaxColumns: options.relaxColumns,
  });
  const recordInput = collectMigrateRecordInput();
  const last = await readLastMigrateRecord(options.db, {
    engineHint: options.engineHint,
  });
  const decision = decideMigrationRun({
    changes: pending.diff.changes,
    addedTables: pending.diff.added_tables,
    engine: resolveMigrationEngine(options.db, options.engineHint),
    packagesSeen: {
      recorded: last.state === 'recorded' ? last.record.packages : null,
      current: recordInput.packages,
      confirmedRemoved: options.confirmRemovedPackages ?? [],
    },
  });
  const { stops, heldBack, proceed, packageStops, notices } = decision;
  for (const notice of notices) logger.info(notice);
  if (!proceed) {
    return {
      applied: false,
      refused: true,
      stops,
      packageStops,
      notices,
      heldBack,
      results: [],
      statements: pending.statements,
      schemaCount: pending.schemaCount,
      unactionableChanges: pending.unactionableChanges,
      hasManualDrift: pending.hasManualDrift,
      relaxedColumns: [],
    };
  }
  if (!pending.hasChanges || pending.statements.length === 0) {
    if (!pending.hasManualDrift) {
      await recordSuccessfulMigrate(options.db, {
        input: recordInput,
        engineHint: options.engineHint,
      });
    }
    return {
      applied: false,
      refused: false,
      stops,
      packageStops,
      notices,
      heldBack,
      results: [],
      statements: [],
      schemaCount: pending.schemaCount,
      unactionableChanges: pending.unactionableChanges,
      hasManualDrift: pending.hasManualDrift,
      relaxedColumns: [],
    };
  }

  const tracker = new MigrationTracker({
    db: options.db,
    engineHint: resolveMigrationEngine(options.db, options.engineHint),
    lockTimeout: options.lockTimeout,
    statementTimeout: options.statementTimeout,
    useConcurrentIndexes: options.useConcurrentIndexes ?? true,
  });
  const migration = createMigrationDefinition(
    options.name ?? `${generateMigrationTimestamp()}_smrt_schema_sync`,
    pending.statements,
    [],
    {
      description: options.description ?? 'Synchronize SMRT object schemas',
      packageName: options.packageName,
      version: options.version ?? 'unknown',
    },
  );

  const results = await tracker.applyAll([migration], {
    atomic: true,
    postgresSafe: options.postgresSafe ?? true,
    reconcile: options.reconcile ?? true,
  });

  const failed = results.find((result) => !result.success);
  if (failed) {
    throw failed.error instanceof Error
      ? failed.error
      : new Error(String(failed.error ?? `Migration ${failed.name} failed`));
  }

  if (!pending.hasManualDrift) {
    await recordSuccessfulMigrate(options.db, {
      input: recordInput,
      engineHint: options.engineHint,
    });
  }

  const applied = results.some(
    (result) => result.applied !== false && result.skipped !== true,
  );

  const relaxedColumns = applied ? pending.relaxedColumns : [];
  for (const { table, column, alteration } of relaxedColumns) {
    logger.info(
      `Relaxed ${table}.${column} (${alteration}) to match the manifest`,
    );
  }

  return {
    applied,
    refused: false,
    stops,
    packageStops,
    notices,
    heldBack,
    results,
    statements: pending.statements,
    schemaCount: pending.schemaCount,
    unactionableChanges: pending.unactionableChanges,
    hasManualDrift: pending.hasManualDrift,
    relaxedColumns,
  };
}

/**
 * Materialize the diff into the engine-correct SQL statements.
 *
 * For new tables we delegate to the engine's `DDLStrategy` so column types
 * (`REAL` → `DOUBLE PRECISION` on Postgres, `JSON` → `JSONB`, etc.),
 * partial-index `WHERE` clauses, and trigger syntax all match what the
 * SchemaComparer would expect on subsequent runs. Emitting the raw
 * abstract `SchemaDefinition.ddl` here would cause immediate type-drift
 * migrations on Postgres/DuckDB.
 *
 * Column/index/trigger changes for existing tables continue to come from
 * `getSQLFromDiff`, which is already engine-aware via the differ's per-
 * change `sqlStatements`.
 *
 * Exported for statement-ordering tests; it is not part of the package's
 * public entry point (`migrations/index.ts` re-exports names explicitly).
 *
 * @param diff - Schema diff to materialize.
 * @param db - Database whose adapter selects the DDL strategy.
 * @param engineHint - Explicit engine when `db.url` is empty or ambiguous.
 * @returns Ordered, executable DDL statements.
 */
export function collectStatementsFromDiff(
  diff: Awaited<ReturnType<typeof generateSchemaDiff>>,
  db: DatabaseInterface,
  engineHint?: DatabaseEngine,
): string[] {
  const strategy = getDDLStrategy(resolveMigrationEngine(db, engineHint));
  const statements: string[] = [];
  const tablePlan = planForeignKeyCreation(diff.added_tables, strategy.engine);
  // #2608: the pre-R11 uuid convergence has to precede *every* foreign-key
  // statement. `planForeignKeyCreation` only defers the constraints inside a
  // mutual cycle, so an acyclic new child table keeps its FK **inline in
  // CREATE TABLE** — a fresh `uuid` child pointing at a legacy `text` parent
  // would fail with SQLSTATE 42804 before the parent could be converted.
  // Conversions only ever rewrite columns that already exist, so they are
  // safe to run ahead of every CREATE TABLE in this batch.
  statements.push(
    ...getSQLFromChanges(
      diff.changes.filter((change) => change.phase === 'pre_foreign_key'),
    ),
  );
  for (const schema of tablePlan.schemas) {
    statements.push(strategy.generateCreateTable(schema));
    statements.push(...strategy.generateIndexes(schema));
    statements.push(...strategy.generateTriggers(schema));
  }
  statements.push(...tablePlan.deferredStatements);
  statements.push(
    ...getSQLFromChanges(
      diff.changes.filter((change) => change.phase !== 'pre_foreign_key'),
    ),
  );
  // Drop empty and comment-only entries. SQLite type-widening upgrades
  // surface as `-- SQLite: Type upgrade for X requires table recreation`
  // — passing those through to the tracker records a successful migration
  // without actually fixing the column, so the same drift re-appears on
  // every subsequent run. Those changes are surfaced separately via
  // `unactionableChanges` so callers can prompt for manual remediation.
  return statements.filter((statement) => {
    const trimmed = statement.trim();
    if (trimmed.length === 0) return false;
    return !isCommentOnlySql(trimmed);
  });
}

/**
 * Only stops need intervention. Warning-level reports (including orphan NOT
 * NULL columns and unrequested relaxations) never set hasManualDrift (#4925).
 * @internal
 */
export function collectUnactionableChanges(
  diff: Awaited<ReturnType<typeof generateSchemaDiff>>,
  engine: DatabaseEngine = 'sqlite',
): SchemaChange[] {
  return diff.changes.filter(
    (change) => decideSchemaChange(change, engine).decision === 'stop',
  );
}
