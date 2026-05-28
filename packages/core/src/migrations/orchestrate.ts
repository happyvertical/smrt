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
import type { DatabaseInterface } from '@happyvertical/sql';
import { ObjectRegistry } from '../registry.js';
import { detectEngine, getDDLStrategy } from '../schema/ddl/index.js';
import type { MigrationResult, SchemaChange } from '../schema/types.js';
import {
  generateSchemaDiff,
  getSQLFromDiff,
  hasActionableChanges,
} from './differ.js';
import {
  createMigrationDefinition,
  generateMigrationTimestamp,
} from './generator.js';
import { MigrationTracker } from './tracker.js';

export interface MigrateSmrtSchemasOptions {
  db: DatabaseInterface;
  /** Stored on the migration record so the audit log shows which app applied it. */
  packageName: string;
  /** Stored on the migration record. Typically the app's package.json version. */
  version: string;
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
   */
  engineHint?: string;
}

export interface MigrateSmrtSchemasResult {
  applied: boolean;
  results: MigrationResult[];
  statements: string[];
  schemaCount: number;
  /**
   * Schema changes the orchestrator detected but cannot apply automatically
   * (incompatible type mismatches, SQLite type upgrades that require table
   * recreation, etc.). Empty when the schema is fully reconciled. Inspect
   * this to surface a "manual migration required" warning in CLI output.
   */
  unactionableChanges: SchemaChange[];
}

export interface PendingSchemaStatementsResult {
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
  options: { engineHint?: string } = {},
): Promise<PendingSchemaStatementsResult> {
  const schemas = ObjectRegistry.getAllSchemasAsDefinitions();
  // Forward engineHint into the diff itself so the SchemaComparer's
  // existing-table SQL (ALTER/index drift) uses the same DDL strategy
  // we use for newly-added tables — otherwise the two halves of the
  // statement list can land on different engines (split-brain) when
  // `db.url` is empty or ambiguous.
  const diff = await generateSchemaDiff(db, schemas, {
    engineHint: options.engineHint,
  });
  const statements = collectStatementsFromDiff(diff, db, options.engineHint);
  const unactionableChanges = collectUnactionableChanges(diff);
  return {
    diff,
    schemaCount: Object.keys(schemas).length,
    statements,
    hasChanges: hasActionableChanges(diff),
    unactionableChanges,
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
 * **Note on `unactionableChanges`:** the differ can detect schema drift
 * the migration step can't auto-resolve — incompatible type mismatches,
 * SQLite type widening that needs table recreation, etc. Those changes
 * appear in `result.unactionableChanges` and are NOT applied (the
 * statements list is filtered to executable DDL only). When the diff
 * contains *only* unactionable changes, the function returns
 * `applied: false` with a populated `unactionableChanges` so callers can
 * surface a "manual migration required" signal. Without inspecting that
 * field, the result would look indistinguishable from "already in sync."
 */
export async function migrateSmrtSchemas(
  options: MigrateSmrtSchemasOptions,
): Promise<MigrateSmrtSchemasResult> {
  const pending = await getPendingSchemaStatements(options.db, {
    engineHint: options.engineHint,
  });
  if (!pending.hasChanges || pending.statements.length === 0) {
    return {
      applied: false,
      results: [],
      statements: [],
      schemaCount: pending.schemaCount,
      unactionableChanges: pending.unactionableChanges,
    };
  }

  const tracker = new MigrationTracker({
    db: options.db,
    engineHint: options.engineHint,
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
      version: options.version,
    },
  );

  const results = await tracker.applyAll([migration], {
    postgresSafe: options.postgresSafe ?? true,
    reconcile: options.reconcile ?? true,
  });

  const failed = results.find((result) => !result.success);
  if (failed) {
    throw failed.error instanceof Error
      ? failed.error
      : new Error(String(failed.error ?? `Migration ${failed.name} failed`));
  }

  const applied = results.some(
    (result) => result.applied !== false && result.skipped !== true,
  );

  return {
    applied,
    results,
    statements: pending.statements,
    schemaCount: pending.schemaCount,
    unactionableChanges: pending.unactionableChanges,
  };
}

/** Mirror of the `getDatabaseUrl` helper in class.ts — some adapters
 * (JSON, certain in-memory wrappers) leave `db.url` undefined and expose
 * the URL on `db.config?.url` instead. Detecting the engine from a raw
 * `db.url` would throw or silently fall through to the sqlite default.
 */
function resolveDatabaseUrl(db: DatabaseInterface): string {
  const dbWithConfig = db as DatabaseInterface & {
    config?: { url?: string };
  };
  return db.url || dbWithConfig.config?.url || '';
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
 */
function collectStatementsFromDiff(
  diff: Awaited<ReturnType<typeof generateSchemaDiff>>,
  db: DatabaseInterface,
  engineHint?: string,
): string[] {
  const strategy = getDDLStrategy(
    detectEngine(resolveDatabaseUrl(db), engineHint),
  );
  const statements: string[] = [];
  for (const schema of diff.added_tables) {
    statements.push(strategy.generateCreateTable(schema));
    statements.push(...strategy.generateIndexes(schema));
    statements.push(...strategy.generateTriggers(schema));
  }
  statements.push(...getSQLFromDiff(diff));
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

/** True if every non-empty line of `sql` is a `--` comment. */
function isCommentOnlySql(sql: string): boolean {
  const lines = sql
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.length > 0 && lines.every((line) => line.startsWith('--'));
}

/**
 * Surface changes the differ produced but that the migrator cannot apply
 * automatically — either `type_mismatch` entries (the differ explicitly
 * gives up on these) or `type_upgrade` entries whose generated SQL is
 * advisory-comment-only (SQLite table-recreation cases, etc.). Callers
 * use this to distinguish "schema is in sync" from "schema is drifted but
 * we can't fix it from here."
 */
function collectUnactionableChanges(
  diff: Awaited<ReturnType<typeof generateSchemaDiff>>,
): SchemaChange[] {
  const unactionable: SchemaChange[] = [];
  for (const change of diff.changes) {
    if (change.type === 'type_mismatch') {
      unactionable.push(change);
      continue;
    }
    const statements = change.sqlStatements ?? (change.sql ? [change.sql] : []);
    if (
      statements.length > 0 &&
      statements.every((stmt) => isCommentOnlySql(stmt.trim()))
    ) {
      unactionable.push(change);
    }
  }
  return unactionable;
}
