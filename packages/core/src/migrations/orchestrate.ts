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
import type { MigrationResult } from '../schema/types.js';
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
}

export interface MigrateSmrtSchemasResult {
  applied: boolean;
  results: MigrationResult[];
  statements: string[];
  schemaCount: number;
}

export interface PendingSchemaStatementsResult {
  diff: Awaited<ReturnType<typeof generateSchemaDiff>>;
  statements: string[];
  schemaCount: number;
  hasChanges: boolean;
}

/**
 * Compute the SQL statements needed to bring `db` in sync with the
 * currently-registered SMRT object schemas. Pure inspection — no writes.
 *
 * Useful for status commands ("how far behind is the schema?") and as the
 * inner step of `migrateSmrtSchemas`.
 */
export async function getPendingSchemaStatements(
  db: DatabaseInterface,
): Promise<PendingSchemaStatementsResult> {
  const schemas = ObjectRegistry.getAllSchemasAsDefinitions();
  const diff = await generateSchemaDiff(db, schemas);
  const statements = collectStatementsFromDiff(diff, db);
  return {
    diff,
    schemaCount: Object.keys(schemas).length,
    statements,
    hasChanges: hasActionableChanges(diff),
  };
}

/**
 * Apply any pending schema changes from `ObjectRegistry` to `db`.
 *
 * Returns `applied: false` (with no error) if the database is already in
 * sync. Throws on the first migration failure with the underlying error
 * preserved (callers should let it propagate to the CLI).
 */
export async function migrateSmrtSchemas(
  options: MigrateSmrtSchemasOptions,
): Promise<MigrateSmrtSchemasResult> {
  const pending = await getPendingSchemaStatements(options.db);
  if (!pending.hasChanges || pending.statements.length === 0) {
    return {
      applied: false,
      results: [],
      statements: [],
      schemaCount: pending.schemaCount,
    };
  }

  const tracker = new MigrationTracker({
    db: options.db,
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

  return {
    applied: true,
    results,
    statements: pending.statements,
    schemaCount: pending.schemaCount,
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
 */
function collectStatementsFromDiff(
  diff: Awaited<ReturnType<typeof generateSchemaDiff>>,
  db: DatabaseInterface,
): string[] {
  const strategy = getDDLStrategy(detectEngine(db.url));
  const statements: string[] = [];
  for (const schema of diff.added_tables) {
    statements.push(strategy.generateCreateTable(schema));
    statements.push(...strategy.generateIndexes(schema));
    statements.push(...strategy.generateTriggers(schema));
  }
  statements.push(...getSQLFromDiff(diff));
  return statements.filter((statement) => statement.trim().length > 0);
}
