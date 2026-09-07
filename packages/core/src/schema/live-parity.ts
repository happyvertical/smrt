/**
 * Live-schema parity check (#2368)
 *
 * Compares a **live** database against the shape the model layer assumes.
 * Three inputs define "expected":
 *
 * 1. **Declared table shapes** — the manifest schemas the caller passes in.
 *    These give tables, columns, types, nullability, and declared indexes.
 * 2. **Hand-DDL system tables** — `_smrt_*` tables parsed out of
 *    `src/system/schema.ts` (see `system-table-shapes.ts`). They never enter
 *    the manifest, so nothing else has ever diffed them.
 * 3. **An expected-shape index policy that does not consult the manifest** —
 *    every foreign-key / cross-package-ref / tenant column carries a leading
 *    index, every declared upsert conflict target is backed by a matching
 *    UNIQUE index, and every `unique: true` column is actually unique in the
 *    live database.
 *
 * Point 3 is the reason this module exists rather than reusing the migration
 * differ: the differ compares the live database to the manifest, i.e. to the
 * artifact that dropped the index in the first place, which is why a database
 * missing 164 tenant-column indexes reported "in sync" (#2356).
 *
 * This module is read-only. It emits findings; it never repairs.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import {
  collectIntegerWidthTargets,
  preflightIntegerWidthWidening,
} from '../migrations/integer-width.js';
import { RETIRED_SYSTEM_TABLES } from '../system/schema.js';
import { detectEngine, getDDLStrategy } from './ddl/index.js';
import type { DatabaseEngine } from './ddl/types.js';
// The canonical PostgreSQL uuid-text shape probe (#2608): every framework
// guard that decides whether a `text` column can be reinterpreted as `uuid`
// tests the same pattern (the orphan probe, the FK provisioning guard, the
// uuid convergence planner). Reused here rather than duplicated so a rename
// candidate and a uuid-convergence candidate never disagree about "shaped".
import {
  CANONICAL_UUID_PATTERN,
  CANONICAL_UUID_SQLITE_GLOB_PATTERN,
} from './foreign-key-ddl.js';
import { quoteIdentifier } from './sql-identifiers.js';
import { getSystemTableShapes } from './system-table-shapes.js';
import type { ColumnDefinition, SchemaDefinition } from './types.js';

/** How badly a finding breaks the deployment. */
export type LiveParitySeverity = 'error' | 'warning' | 'info';

/** The class of drift a finding describes. */
export type LiveParityFindingKind =
  | 'missing_table'
  | 'extra_table'
  | 'missing_column'
  | 'extra_column'
  | 'column_type_drift'
  | 'column_nullability_drift'
  | 'missing_index'
  | 'extra_index'
  | 'unindexed_reference'
  | 'conflict_target_unindexed'
  | 'conflict_target_not_unique'
  | 'unique_constraint_missing'
  | 'invalid_index'
  /** Pre-#2373 PostgreSQL/DuckDB int4 column needing opt-in widening. */
  | 'legacy_integer_width'
  /**
   * A declared column exists live and holds no data while an undeclared
   * column of a compatible type does (#2752) — the shape a framework field
   * rename leaves behind when `db:migrate` adds the new column additively
   * and never moves the old data into it.
   */
  | 'rename_data_pending';

/** One difference between the live database and the expected shape. */
export interface LiveParityFinding {
  kind: LiveParityFindingKind;
  severity: LiveParitySeverity;
  /** Table the finding is about. */
  table: string;
  /** Column or index the finding is about, when it is narrower than a table. */
  target?: string;
  /** Whether the table is an application table or a `_smrt_*` system table. */
  origin: ExpectedTableOrigin;
  message: string;
  recommendation: string;
  details?: Record<string, unknown>;
}

/** Aggregate result of one parity run. */
export interface LiveSchemaParityReport {
  engine: DatabaseEngine;
  /** Expected tables that exist in the live database and were compared. */
  tablesChecked: number;
  /** Expected tables that are absent from the live database. */
  tablesMissing: number;
  /** Whether `_smrt_*` system tables participated. */
  systemTablesIncluded: boolean;
  /**
   * `full` when index metadata (uniqueness, partial predicates, PostgreSQL
   * validity) could be read for this engine; `unavailable` when it could not,
   * in which case every index-class check is skipped rather than guessed.
   */
  indexIntrospection: 'full' | 'unavailable';
  findings: LiveParityFinding[];
  counts: Record<LiveParitySeverity, number>;
  /** True when no `error`-severity finding was produced. */
  ok: boolean;
}

/** A declared upsert conflict target for one table. */
export interface ConflictTargetInput {
  columns: string[];
  /** Where the target came from, e.g. a class name — used in messages. */
  source?: string;
}

export interface LiveSchemaParityOptions {
  db: DatabaseInterface;
  /** Expected application table shapes, keyed by table name. */
  schemas?: Record<string, SchemaDefinition>;
  /** Declared upsert conflict targets, keyed by table name. */
  conflictTargets?: Record<string, ConflictTargetInput[]>;
  /** Include `_smrt_*` system tables (default true). */
  includeSystemTables?: boolean;
  /** Explicit engine hint for adapters whose URL is empty or ambiguous. */
  engineHint?: string;
  /** Report live tables no expected shape covers (default true). */
  reportExtraTables?: boolean;
}

/** Whether an expected table is an application table or a system table. */
export type ExpectedTableOrigin = 'application' | 'system';

interface ExpectedColumn {
  name: string;
  /** Engine-materialized type text. */
  type: string;
  primaryKey: boolean;
  notNull: boolean;
  unique: boolean;
  hasDefault: boolean;
  reference?: ColumnDefinition['referenceKind'];
}

interface ExpectedIndex {
  name: string;
  columns: string[];
  unique: boolean;
}

interface ExpectedTable {
  name: string;
  origin: ExpectedTableOrigin;
  columns: ExpectedColumn[];
  indexes: ExpectedIndex[];
  conflictTargets: ConflictTargetInput[];
}

interface LiveColumn {
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
  hasDefault: boolean;
}

interface LiveIndex {
  name: string;
  columns: string[];
  unique: boolean;
  /** PostgreSQL `indisvalid`; always true on engines without the concept. */
  valid: boolean;
  /** True for the index backing a primary key. */
  primary: boolean;
  /** True when the index is partial (has a WHERE predicate). */
  partial: boolean;
}

/**
 * Thrown when the live database cannot be introspected. Callers fail closed:
 * an unreadable database is never reported as "in sync".
 */
export class LiveSchemaParityError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LiveSchemaParityError';
  }
}

/**
 * Compare a live database against the expected shape and return every
 * difference found.
 *
 * @throws {LiveSchemaParityError} when the database cannot be reached or the
 *   adapter cannot describe a table. Connection problems must fail closed.
 */
export async function checkLiveSchemaParity(
  options: LiveSchemaParityOptions,
): Promise<LiveSchemaParityReport> {
  const {
    db,
    schemas = {},
    conflictTargets = {},
    includeSystemTables = true,
    engineHint,
    reportExtraTables = true,
  } = options;

  const engine = resolveEngine(db, engineHint);
  const expected = buildExpectedTables({
    schemas,
    conflictTargets,
    includeSystemTables,
    engine,
  });

  const liveTableNames = await listLiveTables(db, engine);
  const indexCatalog = await readIndexCatalog(db, engine);
  const findings: LiveParityFinding[] = [];

  let tablesChecked = 0;
  let tablesMissing = 0;

  for (const table of expected) {
    if (!liveTableNames.has(table.name)) {
      tablesMissing++;
      findings.push({
        kind: 'missing_table',
        severity: 'error',
        table: table.name,
        origin: table.origin,
        message: `Table \`${table.name}\` is declared but does not exist in the live database.`,
        recommendation:
          table.origin === 'system'
            ? 'Initialize SMRT system tables against this database (they are created on framework bootstrap).'
            : 'Run `smrt db:migrate` to create the missing table.',
      });
      continue;
    }

    tablesChecked++;
    const liveColumns = await readLiveColumns(db, table.name);
    findings.push(...compareColumns(table, liveColumns, engine));
    findings.push(
      ...(await detectRenameDataPending(db, engine, table, liveColumns)),
    );

    if (indexCatalog) {
      const liveIndexes = await indexCatalog.forTable(table.name);
      findings.push(...compareIndexes(table, liveColumns, liveIndexes));
    }
  }

  // #2373 intentionally leaves int4/int8 equivalent to the ordinary differ
  // (and to structural parity) so fresh BIGINT DDL does not auto-rewrite a
  // production table. Surface the remaining 32-bit columns as advisory-only
  // findings here, with row counts for a maintenance-window estimate.
  const widthPreflight = await preflightIntegerWidthWidening(
    db,
    collectIntegerWidthTargets(schemas, { includeSystemTables }),
    { engineHint },
  );
  if (widthPreflight.supported) {
    for (const table of widthPreflight.tables) {
      for (const column of table.columns) {
        if (column.state !== 'pending') continue;
        findings.push({
          kind: 'legacy_integer_width',
          severity: 'warning',
          table: table.table,
          target: column.column,
          origin: table.table.startsWith('_smrt_') ? 'system' : 'application',
          message:
            `Column \`${table.table}.${column.column}\` is legacy \`${column.declaredType}\` ` +
            `instead of BIGINT (${table.rowCount ?? 0} row(s) in the table).`,
          recommendation:
            'Schedule a maintenance window, run `smrt db:migrate-int8 --dry-run`, then run `smrt db:migrate-int8` after reviewing the table-rewrite plan.',
          details: {
            actual: column.declaredType,
            expected: 'BIGINT',
            rowCount: table.rowCount,
          },
        });
      }
    }
  }

  if (reportExtraTables) {
    const expectedNames = new Set(expected.map((table) => table.name));
    for (const liveName of liveTableNames) {
      if (expectedNames.has(liveName)) continue;
      if (isInternalTableName(liveName)) continue;
      // Without system tables in scope, every `_smrt_*` table would be
      // reported as unexplained; that is a scoping artifact, not drift.
      if (!includeSystemTables && liveName.startsWith('_smrt_')) continue;
      // A retired system table is not unexplained drift — the framework
      // deliberately stopped creating it and deliberately does not drop it
      // (issue #2376). Name the exact remedy instead of the generic advice.
      const retired = RETIRED_SYSTEM_TABLES.includes(liveName);
      findings.push({
        kind: 'extra_table',
        severity: 'info',
        table: liveName,
        origin: liveName.startsWith('_smrt_') ? 'system' : 'application',
        message: retired
          ? `Live table \`${liveName}\` is a retired SMRT system table; nothing reads or writes it.`
          : `Live table \`${liveName}\` is not covered by any declared schema.`,
        recommendation: retired
          ? `Drop it once you have confirmed it is unused: DROP TABLE IF EXISTS ${liveName};`
          : 'Confirm the table belongs to another application sharing this database, or remove it once its owning model is gone.',
      });
    }
  }

  const counts: Record<LiveParitySeverity, number> = {
    error: 0,
    warning: 0,
    info: 0,
  };
  for (const finding of findings) {
    counts[finding.severity]++;
  }

  return {
    engine,
    tablesChecked,
    tablesMissing,
    systemTablesIncluded: includeSystemTables,
    indexIntrospection: indexCatalog ? 'full' : 'unavailable',
    findings,
    counts,
    ok: counts.error === 0,
  };
}

// ---------------------------------------------------------------------------
// Expected shape
// ---------------------------------------------------------------------------

function buildExpectedTables(input: {
  schemas: Record<string, SchemaDefinition>;
  conflictTargets: Record<string, ConflictTargetInput[]>;
  includeSystemTables: boolean;
  engine: DatabaseEngine;
}): ExpectedTable[] {
  const { schemas, conflictTargets, includeSystemTables, engine } = input;
  const strategy = getDDLStrategy(engine);
  const tables: ExpectedTable[] = [];

  for (const [key, schema] of Object.entries(schemas)) {
    const tableName = schema?.tableName || key;
    if (!tableName) continue;

    const columns: ExpectedColumn[] = Object.entries(schema.columns ?? {}).map(
      ([columnName, column]) => ({
        name: columnName,
        type: strategy.mapType(column.type),
        primaryKey: column.primaryKey === true,
        notNull: column.notNull === true || column.primaryKey === true,
        unique: column.unique === true,
        hasDefault: column.defaultValue !== undefined,
        reference: column.foreignKey ? 'foreignKey' : column.referenceKind,
      }),
    );

    tables.push({
      name: tableName,
      origin: 'application',
      columns,
      indexes: (schema.indexes ?? [])
        // Expression indexes (`@meta({ indexed: true })`) surface with empty
        // or null column lists in introspection, so a column-based comparison
        // can only produce false drift for them.
        .filter((index) => !index.jsonPath && (index.columns?.length ?? 0) > 0)
        .map((index) => ({
          name: index.name,
          columns: index.columns,
          unique: index.unique === true,
        })),
      conflictTargets: dedupeConflictTargets(conflictTargets[tableName] ?? []),
    });
  }

  if (includeSystemTables) {
    for (const shape of getSystemTableShapes(engine).values()) {
      tables.push({
        name: shape.tableName,
        origin: 'system',
        columns: shape.columns.map((column) => ({
          name: column.name,
          type: column.type,
          primaryKey: column.primaryKey,
          notNull: column.notNull || column.primaryKey,
          unique: column.unique,
          hasDefault: column.hasDefault,
        })),
        indexes: shape.indexes.map((index) => ({
          name: index.name,
          columns: index.columns,
          unique: index.unique,
        })),
        // Inline `UNIQUE (...)` constraints are what the framework upserts
        // against on system tables, so they are the conflict targets here.
        conflictTargets: dedupeConflictTargets(
          shape.uniqueConstraints.map((columns) => ({
            columns,
            source: `${shape.tableName} DDL`,
          })),
        ),
      });
    }
  }

  return tables;
}

function dedupeConflictTargets(
  targets: ConflictTargetInput[],
): ConflictTargetInput[] {
  const seen = new Map<string, ConflictTargetInput>();
  for (const target of targets) {
    const columns = (target.columns ?? []).filter(Boolean);
    if (columns.length === 0) continue;
    const key = [...columns].sort().join(',');
    if (!seen.has(key)) {
      seen.set(key, { columns, source: target.source });
    }
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Column comparison
// ---------------------------------------------------------------------------

function compareColumns(
  table: ExpectedTable,
  liveColumns: Map<string, LiveColumn>,
  engine: DatabaseEngine,
): LiveParityFinding[] {
  const findings: LiveParityFinding[] = [];
  const expectedNames = new Set(table.columns.map((column) => column.name));

  for (const column of table.columns) {
    const live = liveColumns.get(column.name);
    if (!live) {
      findings.push({
        kind: 'missing_column',
        severity: 'error',
        table: table.name,
        target: column.name,
        origin: table.origin,
        message: `Column \`${table.name}.${column.name}\` is declared but missing from the live database.`,
        recommendation:
          'Run `smrt db:migrate` to add the column before application writes reach this table.',
        details: { expectedType: column.type },
      });
      continue;
    }

    if (!typesAreEquivalent(column, live, engine)) {
      findings.push({
        kind: 'column_type_drift',
        severity: 'error',
        table: table.name,
        target: column.name,
        origin: table.origin,
        message: `Column \`${table.name}.${column.name}\` is \`${live.type}\` in the live database but declared \`${column.type}\`.`,
        recommendation:
          'Reconcile the column type with `smrt db:migrate`, or repair the declaration if the live type is correct.',
        details: { expected: column.type, actual: live.type },
      });
    } else {
      const expectedBucket = normalizeSqlType(column.type);
      const actualBucket = normalizeSqlType(live.type);

      // #2772: `TEXT` (live) vs `JSON`/`JSONB` (declared) is tolerated above
      // (#1335) so it never becomes an `error`, but on a table SMRT itself
      // creates this is real, repairable drift — `db:migrate` can converge
      // it (see `differ.ts`'s shape-probed `type_upgrade`). Surface it as a
      // warning rather than staying invisible; the reverse direction (a
      // native `json`/`jsonb` column backed by a text-convention manifest
      // field) stays silent — that pairing is intentional, not drift.
      //
      // Engine-gated to `postgres` to match the differ's own repair gate
      // (`jsonUpgradeCandidate` in `differ.ts`, `this.engine === 'postgres'`
      // only): on DuckDB/SQLite there is no `type_upgrade` path for this
      // pairing, so flagging it here would be a permanent, unclearable
      // warning (review finding — the same class already fixed for #2770's
      // float-width check).
      if (
        engine === 'postgres' &&
        expectedBucket === 'JSON' &&
        actualBucket === 'TEXT'
      ) {
        findings.push({
          kind: 'column_type_drift',
          severity: 'warning',
          table: table.name,
          target: column.name,
          origin: table.origin,
          message: `Column \`${table.name}.${column.name}\` is \`${live.type}\` in the live database but declared \`${column.type}\`.`,
          recommendation:
            'Run `smrt db:migrate` to converge this column to native jsonb once its live values are confirmed valid JSON.',
          details: { expected: column.type, actual: live.type },
        });
      } else if (
        expectedBucket === 'UUID' &&
        actualBucket === 'TEXT' &&
        isStructuralReference(column)
      ) {
        // #2772: the reverse of the uuid tolerance above already has a
        // framework repair path (`db:migrate-uuid`, #2608) — this differs
        // from the jsonb case in staying `info`: text/uuid interop on
        // structural columns is an intentional, long-supported compatibility
        // shape, not a bug, so this is a pointer to the optional convergence
        // path rather than a warning.
        findings.push({
          kind: 'column_type_drift',
          severity: 'info',
          table: table.name,
          target: column.name,
          origin: table.origin,
          message: `Column \`${table.name}.${column.name}\` is \`${live.type}\` in the live database but declared \`${column.type}\`; SMRT tolerates text/uuid for structural identifier/reference columns.`,
          recommendation:
            'Run `smrt db:migrate-uuid` to converge this column to native uuid, or leave it as-is — this pairing is tolerated indefinitely.',
          details: { expected: column.type, actual: live.type },
        });
      } else if (
        (engine === 'postgres' || engine === 'duckdb') &&
        expectedBucket === 'REAL' &&
        actualBucket === 'REAL'
      ) {
        // #2770: REAL/DOUBLE PRECISION/DECIMAL/NUMERIC all normalize into
        // one 'REAL' bucket above, so single- vs double-precision float
        // drift never reaches the `!typesAreEquivalent` branch — the same
        // way int4-vs-int8 drift hides behind the shared 'INTEGER' bucket
        // (see `legacy_integer_width` below). Detect it here instead.
        //
        // Engine-gated to match the differ's own repair gate (`differ.ts`,
        // `this.engine === 'postgres' || this.engine === 'duckdb'`): SQLite
        // stores every real as an 8-byte double regardless of the declared
        // type name, so there is no narrowing and no `type_upgrade` path —
        // flagging it there would be a permanent, unclearable warning
        // (review finding).
        const expectedPrecision = floatPrecisionOf(column.type, engine);
        const actualPrecision = floatPrecisionOf(live.type, engine);
        if (
          expectedPrecision &&
          actualPrecision &&
          expectedPrecision !== actualPrecision
        ) {
          const widening =
            expectedPrecision === 'double' && actualPrecision === 'single';
          findings.push({
            kind: 'column_type_drift',
            // Consistent with the other width findings (`legacy_integer_width`
            // below): a maintenance concern to schedule, not a broken write path.
            severity: 'warning',
            table: table.name,
            target: column.name,
            origin: table.origin,
            message: `Column \`${table.name}.${column.name}\` is \`${live.type}\` (${actualPrecision}-precision) in the live database but declared \`${column.type}\` (${expectedPrecision}-precision).`,
            recommendation: widening
              ? 'Run `smrt db:migrate` to widen this column to double precision (lossless).'
              : 'Narrowing to single precision can lose data; confirm the narrower declaration is intentional before repairing it manually.',
            details: { expected: column.type, actual: live.type },
          });
        }
      }
    }

    // A declared-NOT NULL column that is nullable live silently accepts rows
    // the model layer believes cannot exist; the reverse breaks every insert
    // that omits the column, which is the worse failure.
    if (!column.primaryKey && column.notNull && !live.notNull) {
      findings.push({
        kind: 'column_nullability_drift',
        severity: 'warning',
        table: table.name,
        target: column.name,
        origin: table.origin,
        message: `Column \`${table.name}.${column.name}\` is declared NOT NULL but is nullable in the live database.`,
        recommendation:
          'Backfill any NULL values and add the NOT NULL constraint, or relax the declaration.',
      });
    } else if (!column.notNull && live.notNull && !live.hasDefault) {
      findings.push({
        kind: 'column_nullability_drift',
        severity: 'error',
        table: table.name,
        target: column.name,
        origin: table.origin,
        message: `Column \`${table.name}.${column.name}\` is NOT NULL in the live database with no default, but is not declared NOT NULL. Inserts that omit it will fail.`,
        recommendation:
          'Drop the orphan NOT NULL constraint, give the column a default, or declare the column required.',
      });
    }
  }

  for (const live of liveColumns.values()) {
    if (expectedNames.has(live.name)) continue;

    const breaksInserts = live.notNull && !live.hasDefault;
    findings.push({
      kind: 'extra_column',
      severity: breaksInserts ? 'error' : 'info',
      table: table.name,
      target: live.name,
      origin: table.origin,
      message: breaksInserts
        ? `Live column \`${table.name}.${live.name}\` is undeclared, NOT NULL, and has no default — every framework insert into this table will fail.`
        : `Live column \`${table.name}.${live.name}\` is not declared by the current schema.`,
      recommendation: breaksInserts
        ? 'Drop the orphan column or give it a default; this is the residue of a renamed or removed required field.'
        : 'Confirm the column is intentional legacy data, or drop it once nothing reads it.',
      details: { type: live.type },
    });
  }

  return findings;
}

/**
 * Whether a live column type satisfies its declaration.
 *
 * Two tolerances match the model layer's actual conventions, and mirror the
 * migration differ so the two tools never disagree:
 *
 * - `TEXT` ↔ `UUID` for structural identifier/reference columns, because
 *   SQLite has no uuid type and older PostgreSQL deployments legitimately
 *   still carry text ids (R11).
 * - `TEXT` ↔ `JSON`/`JSONB` in both directions, because SMRT serializes JSON
 *   values into text columns and a native json column already holds exactly
 *   that (#1335).
 */
function typesAreEquivalent(
  expected: ExpectedColumn,
  live: LiveColumn,
  engine: DatabaseEngine,
): boolean {
  const expectedType = normalizeSqlType(expected.type);
  const actualType = normalizeSqlType(live.type);
  if (expectedType === actualType) return true;

  const uuidTextPair =
    (expectedType === 'UUID' && actualType === 'TEXT') ||
    (expectedType === 'TEXT' && actualType === 'UUID');
  if (uuidTextPair && isStructuralReference(expected)) {
    return true;
  }

  const jsonTextPair =
    (expectedType === 'JSON' && actualType === 'TEXT') ||
    (expectedType === 'TEXT' && actualType === 'JSON');
  if (jsonTextPair) return true;

  // SQLite has dynamic typing: BOOLEAN/TIMESTAMP columns are declared with
  // affinities that pragma reports verbatim, and INTEGER/NUMERIC storage is
  // interchangeable for the values SMRT writes.
  if (engine === 'sqlite') {
    const numericPair =
      (expectedType === 'BOOLEAN' && actualType === 'INTEGER') ||
      (expectedType === 'INTEGER' && actualType === 'BOOLEAN');
    if (numericPair) return true;
  }

  return false;
}

/**
 * Single- vs double-precision float classification for #2770's float-width
 * drift detection. `null` for anything that isn't unambiguously one or the
 * other (DECIMAL/NUMERIC have no fixed binary width and are out of scope).
 *
 * Bare `FLOAT` is engine-ambiguous and must be classified per `engine`:
 * PostgreSQL's `information_schema` reports `float4`/`real` as `real` and
 * `float8`/`double precision` as `double precision` — `FLOAT` alone never
 * appears there, so treating it as double-precision was previously safe.
 * DuckDB is different: `information_schema.columns.data_type` normalizes
 * *both* spellings of its single-precision type (`REAL`, `FLOAT4`) to the
 * bare string `FLOAT`, and reports its double-precision type as `DOUBLE`
 * (never `FLOAT`). Classifying DuckDB's `FLOAT` as double-precision — as a
 * shared, engine-unaware regex previously did — made every converged DuckDB
 * `REAL` column permanently misreport as narrowing drift with no
 * `db:migrate` able to clear it (review finding on #2770).
 */
function floatPrecisionOf(
  type: string,
  engine: DatabaseEngine,
): 'single' | 'double' | null {
  const upper = String(type ?? '')
    .toUpperCase()
    .trim()
    .replace(/\(\s*\d+(\s*,\s*\d+)?\s*\)/g, '');
  if (/^(REAL|FLOAT4)$/.test(upper)) return 'single';
  if (engine === 'duckdb' && upper === 'FLOAT') return 'single';
  if (/^(FLOAT8|DOUBLE|DOUBLE PRECISION|FLOAT)$/.test(upper)) return 'double';
  return null;
}

function isStructuralReference(column: ExpectedColumn): boolean {
  return (
    column.primaryKey ||
    column.reference === 'id' ||
    column.reference === 'foreignKey' ||
    column.reference === 'crossPackageRef' ||
    column.reference === 'tenantId'
  );
}

/** Fold engine-specific type spellings into comparable buckets. */
export function normalizeSqlType(type: string): string {
  const upper = String(type ?? '')
    .toUpperCase()
    .trim()
    .replace(/\(\s*[^)]*\s*\)/g, '')
    .replace(/\[\]$/, '')
    .trim();

  if (
    /^(INTEGER|INT|INT2|INT4|INT8|BIGINT|SMALLINT|TINYINT|SERIAL|BIGSERIAL)$/.test(
      upper,
    )
  )
    return 'INTEGER';
  if (
    /^(TEXT|CLOB|STRING|VARCHAR|CHAR|CHARACTER|CHARACTER VARYING|NAME)$/.test(
      upper,
    )
  )
    return 'TEXT';
  if (upper === 'UUID') return 'UUID';
  if (
    /^(REAL|FLOAT|FLOAT4|FLOAT8|DOUBLE|DOUBLE PRECISION|DECIMAL|NUMERIC|NUMBER)$/.test(
      upper,
    )
  )
    return 'REAL';
  if (/^(BOOLEAN|BOOL)$/.test(upper)) return 'BOOLEAN';
  if (/^(TIMESTAMPTZ|TIMESTAMP WITH TIME ZONE)$/.test(upper))
    return 'TIMESTAMPTZ';
  if (
    /^(DATETIME|TIMESTAMP|TIMESTAMP WITHOUT TIME ZONE|DATE|TIME)$/.test(upper)
  )
    return 'TIMESTAMP';
  if (/^(BLOB|BINARY|BYTEA)$/.test(upper)) return 'BLOB';
  if (/^(JSON|JSONB)$/.test(upper)) return 'JSON';

  return upper;
}

// ---------------------------------------------------------------------------
// Rename-data-pending detection (#2752)
// ---------------------------------------------------------------------------

/** How a candidate (undeclared, live) column's type relates to a declared column's. */
type RenameCompatibility = 'same-type' | 'text-to-uuid';

/**
 * Whether an undeclared live column could be the pre-rename home of a
 * declared column's data. "Compatible" per #2752: identical normalized
 * type, or the undeclared column is `TEXT` while the declared column is
 * `UUID` (gated separately on data shape by the caller).
 */
function renameCompatibility(
  declaredType: string,
  candidateType: string,
): RenameCompatibility | null {
  if (declaredType === candidateType) return 'same-type';
  if (declaredType === 'UUID' && candidateType === 'TEXT') {
    return 'text-to-uuid';
  }
  return null;
}

async function columnHasNonEmptyValue(
  db: DatabaseInterface,
  table: string,
  column: string,
): Promise<boolean> {
  const quotedTable = quoteIdentifier(table);
  const quotedColumn = quoteIdentifier(column);
  const result = await db.query(
    `SELECT 1 AS present FROM ${quotedTable} ` +
      `WHERE ${quotedColumn} IS NOT NULL AND CAST(${quotedColumn} AS TEXT) <> '' LIMIT 1`,
  );
  return (result?.rows?.length ?? 0) > 0;
}

async function allNonEmptyValuesUuidShaped(
  db: DatabaseInterface,
  engine: DatabaseEngine,
  table: string,
  column: string,
): Promise<boolean> {
  const quotedTable = quoteIdentifier(table);
  const quotedColumn = quoteIdentifier(column);
  const nonEmptyPredicate = `${quotedColumn} IS NOT NULL AND CAST(${quotedColumn} AS TEXT) <> ''`;

  if (engine === 'postgres') {
    const result = await db.query(
      `SELECT count(*) AS invalid_count FROM ${quotedTable} ` +
        `WHERE ${nonEmptyPredicate} ` +
        `AND CAST(${quotedColumn} AS TEXT) !~* '${CANONICAL_UUID_PATTERN}'`,
    );
    const row = result?.rows?.[0] as Record<string, unknown> | undefined;
    return Number(row?.invalid_count ?? 0) === 0;
  }

  // SQLite (the only other engine this detector runs against) has no
  // regex operator, but its case-sensitive `GLOB` can still express the
  // fixed 36-character canonical shape (against `LOWER(...)`, guarded by an
  // exact `LENGTH(...) = 36`), so this runs one server-side aggregate
  // `count(*)` too rather than fetching every non-empty value into JS to
  // test in a loop — important on a production table with many rows
  // (#2767 review).
  const result = await db.query(
    `SELECT count(*) AS invalid_count FROM ${quotedTable} ` +
      `WHERE ${nonEmptyPredicate} ` +
      `AND NOT (LENGTH(CAST(${quotedColumn} AS TEXT)) = 36 ` +
      `AND LOWER(CAST(${quotedColumn} AS TEXT)) GLOB '${CANONICAL_UUID_SQLITE_GLOB_PATTERN}')`,
  );
  const row = result?.rows?.[0] as Record<string, unknown> | undefined;
  return Number(row?.invalid_count ?? 0) === 0;
}

function buildRenameDataPendingFinding(
  table: ExpectedTable,
  declaredColumn: string,
  candidates: string[],
): LiveParityFinding {
  const single = candidates.length === 1;
  const candidateList = candidates.map((name) => `\`${name}\``).join(', ');
  return {
    kind: 'rename_data_pending',
    severity: 'warning',
    table: table.name,
    target: declaredColumn,
    origin: table.origin,
    message: single
      ? `Column \`${table.name}.${declaredColumn}\` is declared but empty, while undeclared column \`${table.name}.${candidates[0]}\` holds data of a compatible type. Data appears to still live in \`${candidates[0]}\` after a field rename.`
      : `Column \`${table.name}.${declaredColumn}\` is declared but empty, while ${candidates.length} undeclared columns hold data of a compatible type (${candidateList}). Data may still live in one of them after a field rename, but which one is ambiguous.`,
    recommendation: single
      ? `Run \`smrt db:diff\` for the suggested backfill SQL, review it, then copy data from \`${candidates[0]}\` into \`${declaredColumn}\` and drop \`${candidates[0]}\`.`
      : 'Identify which undeclared column actually holds the pre-rename data before backfilling; SMRT will not guess among multiple candidates.',
    details: { candidates },
  };
}

/**
 * Detect a pending rename backfill (#2752): a manifest-declared column that
 * exists live but holds no data, paired with an undeclared live column of a
 * compatible type that does hold data. This is the shape a framework field
 * rename leaves behind when `db:migrate` adds the new column additively and
 * never moves data into it, nor drops the old column.
 *
 * Advisory only (`warning`): this module never repairs, and when several
 * undeclared columns qualify it lists them all rather than guessing.
 */
async function detectRenameDataPending(
  db: DatabaseInterface,
  engine: DatabaseEngine,
  table: ExpectedTable,
  liveColumns: Map<string, LiveColumn>,
): Promise<LiveParityFinding[]> {
  // The row-level probes below need plain SQL this module already assumes
  // for these two engines; DuckDB/JSON are out of scope (matches the
  // PostgreSQL/SQLite advisory SQL `db:diff` emits for the same pair).
  if (engine !== 'postgres' && engine !== 'sqlite') return [];

  const expectedNames = new Set(table.columns.map((column) => column.name));
  const extraColumns = [...liveColumns.values()].filter(
    (live) => !expectedNames.has(live.name),
  );
  if (extraColumns.length === 0) return [];

  const findings: LiveParityFinding[] = [];

  for (const column of table.columns) {
    const live = liveColumns.get(column.name);
    if (!live) continue; // missing_column already covers this

    let declaredHasData: boolean;
    try {
      declaredHasData = await columnHasNonEmptyValue(
        db,
        table.name,
        column.name,
      );
    } catch {
      continue;
    }
    if (declaredHasData) continue;

    const declaredType = normalizeSqlType(column.type);
    const candidates: string[] = [];

    for (const extra of extraColumns) {
      const compatibility = renameCompatibility(
        declaredType,
        normalizeSqlType(extra.type),
      );
      if (!compatibility) continue;

      let candidateHasData: boolean;
      try {
        candidateHasData = await columnHasNonEmptyValue(
          db,
          table.name,
          extra.name,
        );
      } catch {
        continue;
      }
      if (!candidateHasData) continue;

      if (compatibility === 'text-to-uuid') {
        let shaped: boolean;
        try {
          shaped = await allNonEmptyValuesUuidShaped(
            db,
            engine,
            table.name,
            extra.name,
          );
        } catch {
          continue;
        }
        if (!shaped) continue;
      }

      candidates.push(extra.name);
    }

    if (candidates.length === 0) continue;
    candidates.sort();
    findings.push(
      buildRenameDataPendingFinding(table, column.name, candidates),
    );
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Index comparison — the manifest-independent policy lives here
// ---------------------------------------------------------------------------

function compareIndexes(
  table: ExpectedTable,
  liveColumns: Map<string, LiveColumn>,
  liveIndexes: LiveIndex[],
): LiveParityFinding[] {
  const findings: LiveParityFinding[] = [];
  const byName = new Map(liveIndexes.map((index) => [index.name, index]));
  const signatures = new Set(
    liveIndexes.map((index) => indexSignature(index.columns, index.unique)),
  );

  for (const index of liveIndexes) {
    if (index.valid) continue;
    findings.push({
      kind: 'invalid_index',
      severity: 'error',
      table: table.name,
      target: index.name,
      origin: table.origin,
      message: `Index \`${index.name}\` on \`${table.name}\` is INVALID — PostgreSQL will not use it and a unique index in this state enforces nothing.`,
      recommendation:
        'Drop and rebuild it (`REINDEX INDEX CONCURRENTLY`), then re-run the parity check.',
    });
  }

  // 1. Declared indexes the live database does not carry in that shape.
  //    Matching is by column/uniqueness signature rather than by name so an
  //    equivalent index under a different name is not reported as missing
  //    (#741), and so a same-name index whose uniqueness or columns drifted
  //    still is.
  for (const index of table.indexes) {
    if (signatures.has(indexSignature(index.columns, index.unique))) continue;
    // Conflict-target coverage is reported below with a message that explains
    // the actual consequence; do not report the same index twice.
    if (
      table.conflictTargets.some((target) =>
        sameColumnSet(index.columns, target.columns),
      )
    ) {
      continue;
    }

    const sameName = byName.get(index.name);
    findings.push({
      kind: 'missing_index',
      severity: 'warning',
      table: table.name,
      target: index.name,
      origin: table.origin,
      message: sameName
        ? `Index \`${index.name}\` on \`${table.name}\` exists but its shape drifted: declared (${index.columns.join(', ')})${index.unique ? ' UNIQUE' : ''}, live (${sameName.columns.join(', ')})${sameName.unique ? ' UNIQUE' : ''}.`
        : `Declared index \`${index.name}\` on \`${table.name}\` (${index.columns.join(', ')}) is missing from the live database.`,
      recommendation:
        table.origin === 'system'
          ? 'Re-run SMRT system-table initialization to create the missing system index.'
          : 'Run `smrt db:migrate` to create the missing index.',
    });
  }

  // 2. Conflict targets. An upsert whose conflict target has no matching
  //    UNIQUE index either errors outright (PostgreSQL) or silently inserts
  //    duplicates, so this is the one index class that is an error.
  for (const target of table.conflictTargets) {
    if (target.columns.some((column) => !liveColumns.has(column))) {
      // A missing column is already reported; do not double-report it here.
      continue;
    }

    const candidates = liveIndexes.filter((index) =>
      sameColumnSet(index.columns, target.columns),
    );
    // A *partial* unique index cannot arbitrate a plain `ON CONFLICT (cols)`:
    // PostgreSQL only infers an index whose predicate the statement repeats,
    // and on other engines it simply does not constrain the excluded rows.
    if (candidates.some((index) => index.unique && !index.partial)) {
      continue;
    }

    const partialUnique = candidates.find(
      (index) => index.unique && index.partial,
    );
    const nonUnique = candidates.find((index) => !index.unique);
    const columnList = target.columns.join(', ');
    const suffix = target.source ? ` (declared by ${target.source})` : '';

    if (nonUnique) {
      findings.push({
        kind: 'conflict_target_not_unique',
        severity: 'error',
        table: table.name,
        target: nonUnique.name,
        origin: table.origin,
        message: `Upsert conflict target \`${table.name}\` (${columnList})${suffix} is backed by \`${nonUnique.name}\`, which is not UNIQUE.`,
        recommendation:
          'Recreate the index as UNIQUE (`smrt db:migrate`); until then upserts insert duplicates instead of updating.',
      });
      continue;
    }

    findings.push({
      kind: 'conflict_target_unindexed',
      severity: 'error',
      table: table.name,
      target: partialUnique ? partialUnique.name : columnList,
      origin: table.origin,
      message: partialUnique
        ? `Upsert conflict target \`${table.name}\` (${columnList})${suffix} is backed only by the partial index \`${partialUnique.name}\`, which cannot arbitrate the upsert.`
        : `Upsert conflict target \`${table.name}\` (${columnList})${suffix} has no matching UNIQUE index in the live database.`,
      recommendation:
        'Create a full UNIQUE index over exactly these columns (`smrt db:migrate`); PostgreSQL rejects the upsert outright and other engines duplicate rows.',
    });
  }

  // 3. Columns declared unique that are not actually unique live.
  for (const column of table.columns) {
    if (!column.unique) continue;
    if (!liveColumns.has(column.name)) continue;
    // A partial unique index constrains only the rows its predicate selects,
    // so it does not make the column unique as declared.
    const unique = liveIndexes.some(
      (index) =>
        index.unique &&
        !index.partial &&
        sameColumnSet(index.columns, [column.name]),
    );
    if (unique) continue;

    findings.push({
      kind: 'unique_constraint_missing',
      severity: 'error',
      table: table.name,
      target: column.name,
      origin: table.origin,
      message: `Column \`${table.name}.${column.name}\` is declared unique but no UNIQUE index enforces it in the live database.`,
      recommendation:
        'De-duplicate existing values and create the UNIQUE index; the declaration is currently decorative.',
    });
  }

  // 4. Manifest-independent coverage policy: every foreign-key, cross-package
  //    reference and tenant column needs an index it *leads*, or every lookup
  //    and every tenant-scoped list is a full scan (#2356).
  for (const column of table.columns) {
    if (!column.reference) continue;
    if (column.reference === 'id') continue;
    if (!liveColumns.has(column.name)) continue;

    const covered = liveIndexes.some(
      (index) => index.columns[0] === column.name,
    );
    if (covered) continue;

    findings.push({
      kind: 'unindexed_reference',
      severity: 'warning',
      table: table.name,
      target: column.name,
      origin: table.origin,
      message: `Reference column \`${table.name}.${column.name}\` (${column.reference}) leads no index in the live database.`,
      recommendation:
        'Add an index led by this column; relationship loads, joins and tenant-scoped reads currently scan the whole table.',
      details: { referenceKind: column.reference },
    });
  }

  // 5. Live indexes nothing declares. Informational: an operator may have
  //    hand-added them, and nothing will recreate them after a rebuild.
  //
  //    An undeclared index whose lead column is a reference column
  //    (tenantId, foreignKey, crossPackageRef) used to be silently exempted
  //    here as deliberate policy. `migrations/differ.ts` disagreed and would
  //    drop the same index under `--drop-indexes`, so an operator following
  //    that command could remove something this check claimed to protect.
  //    Decision (#2751): treat it as drift and report it — the recommendation
  //    below already reads correctly ("declare it ... or drop it if it is
  //    obsolete"), and an `info` finding costs nothing.
  const declaredNames = new Set(table.indexes.map((index) => index.name));
  const declaredSignatures = new Set(
    table.indexes.map((index) => indexSignature(index.columns, index.unique)),
  );
  for (const index of liveIndexes) {
    if (index.primary) continue;
    // Constraint-owned indexes (`sqlite_autoindex_*`, PostgreSQL `*_key` /
    // `*_pkey`) exist because of a table constraint, not because anyone
    // declared an index; reporting them as undeclared is pure noise.
    if (isConstraintOwnedIndexName(index.name)) continue;
    if (declaredNames.has(index.name)) continue;
    if (declaredSignatures.has(indexSignature(index.columns, index.unique)))
      continue;
    if (
      table.conflictTargets.some((target) =>
        sameColumnSet(index.columns, target.columns),
      )
    ) {
      continue;
    }

    findings.push({
      kind: 'extra_index',
      severity: 'info',
      table: table.name,
      target: index.name,
      origin: table.origin,
      message: `Live index \`${index.name}\` on \`${table.name}\` (${index.columns.join(', ') || 'expression'}) is not declared by the current schema.`,
      recommendation:
        'Declare it so a rebuilt database keeps it, or drop it if it is obsolete.',
      details: { unique: index.unique, partial: index.partial },
    });
  }

  return findings;
}

function isConstraintOwnedIndexName(name: string): boolean {
  return (
    name.startsWith('sqlite_autoindex_') ||
    name.endsWith('_pkey') ||
    name.endsWith('_key')
  );
}

function indexSignature(columns: string[], unique: boolean): string {
  return `${columns.join(',')}:${unique}`;
}

/**
 * Conflict targets and unique constraints are order-insensitive: PostgreSQL
 * matches `ON CONFLICT (a, b)` against a unique index on `(b, a)`.
 */
function sameColumnSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((column, index) => column === sortedRight[index]);
}

// ---------------------------------------------------------------------------
// Live introspection
// ---------------------------------------------------------------------------

function resolveEngine(
  db: DatabaseInterface,
  engineHint?: string,
): DatabaseEngine {
  if (typeof (db as { exportTable?: unknown }).exportTable === 'function') {
    return 'json';
  }
  const dbWithConfig = db as DatabaseInterface & { config?: { url?: string } };
  return detectEngine(db.url || dbWithConfig.config?.url || '', engineHint);
}

function isInternalTableName(name: string): boolean {
  return (
    name.startsWith('sqlite_') ||
    name.startsWith('pg_') ||
    name.startsWith('duckdb_') ||
    name === 'information_schema'
  );
}

async function listLiveTables(
  db: DatabaseInterface,
  engine: DatabaseEngine,
): Promise<Set<string>> {
  const sql =
    engine === 'postgres'
      ? `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
      : `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`;

  try {
    const result = await db.query(sql);
    const rows = (result?.rows ?? []) as {
      name?: string;
      table_name?: string;
    }[];
    return new Set(
      rows.map((row) => row.name || row.table_name || '').filter(Boolean),
    );
  } catch (error) {
    throw new LiveSchemaParityError(
      `Could not list tables in the live database: ${describeError(error)}`,
      { cause: error },
    );
  }
}

async function readLiveColumns(
  db: DatabaseInterface,
  tableName: string,
): Promise<Map<string, LiveColumn>> {
  if (typeof db.getTableSchema !== 'function') {
    throw new LiveSchemaParityError(
      'The configured database adapter cannot describe tables (`getTableSchema` is unavailable), so live-schema parity cannot be verified.',
    );
  }

  let schema: Awaited<
    ReturnType<NonNullable<DatabaseInterface['getTableSchema']>>
  >;
  try {
    schema = await db.getTableSchema(tableName);
  } catch (error) {
    throw new LiveSchemaParityError(
      `Could not read the live schema of \`${tableName}\`: ${describeError(error)}`,
      { cause: error },
    );
  }

  const columns = new Map<string, LiveColumn>();
  for (const [name, column] of Object.entries(schema?.columns ?? {})) {
    columns.set(name, {
      name,
      type: String(column?.type ?? ''),
      notNull: column?.notNull === true,
      primaryKey: column?.primaryKey === true,
      hasDefault:
        column?.defaultValue !== undefined && column?.defaultValue !== null,
    });
  }
  return columns;
}

interface IndexCatalog {
  forTable(tableName: string): Promise<LiveIndex[]>;
}

/**
 * Build an index reader for the engine, or `null` when index metadata cannot
 * be read. A null catalog disables every index-class check rather than
 * reporting indexes as missing on an engine we cannot introspect.
 */
async function readIndexCatalog(
  db: DatabaseInterface,
  engine: DatabaseEngine,
): Promise<IndexCatalog | null> {
  if (engine === 'postgres') {
    return readPostgresIndexCatalog(db);
  }
  if (engine === 'sqlite') {
    return { forTable: (tableName) => readSqliteIndexes(db, tableName) };
  }
  return readDuckDbIndexCatalog(db);
}

async function readPostgresIndexCatalog(
  db: DatabaseInterface,
): Promise<IndexCatalog> {
  // One catalog pass for the whole schema: `pg_index` carries uniqueness,
  // primary-key ownership and — unlike `pg_indexes` — `indisvalid`, which is
  // the only way to see an index left INVALID by a failed CONCURRENTLY build.
  const sql = `
    SELECT t.relname AS table_name,
           c.relname AS index_name,
           i.indisunique AS is_unique,
           i.indisprimary AS is_primary,
           i.indisvalid AS is_valid,
           (i.indpred IS NOT NULL) AS is_partial,
           pg_get_indexdef(i.indexrelid) AS index_def
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'`;

  let rows: Record<string, unknown>[];
  try {
    const result = await db.query(sql);
    rows = (result?.rows ?? []) as Record<string, unknown>[];
  } catch (error) {
    throw new LiveSchemaParityError(
      `Could not read the PostgreSQL index catalog: ${describeError(error)}`,
      { cause: error },
    );
  }

  const byTable = new Map<string, LiveIndex[]>();
  for (const row of rows) {
    const tableName = String(row.table_name ?? '');
    if (!tableName) continue;
    const bucket = byTable.get(tableName) ?? [];
    bucket.push({
      name: String(row.index_name ?? ''),
      columns: parseIndexDefColumns(String(row.index_def ?? '')),
      unique: toBoolean(row.is_unique),
      primary: toBoolean(row.is_primary),
      valid: row.is_valid === undefined ? true : toBoolean(row.is_valid),
      partial: toBoolean(row.is_partial),
    });
    byTable.set(tableName, bucket);
  }

  return { forTable: async (tableName) => byTable.get(tableName) ?? [] };
}

/**
 * Extract the indexed column list from a `CREATE INDEX` definition.
 *
 * Expression components (`lower(name)`, `(meta ->> 'x')`) are kept verbatim so
 * they never collide with a plain column of the same name; ordering is
 * preserved because leading-column coverage is what the policy checks.
 */
export function parseIndexDefColumns(indexDef: string): string[] {
  const open = indexDef.indexOf('(');
  if (open === -1) return [];

  let depth = 0;
  let end = -1;
  for (let i = open; i < indexDef.length; i++) {
    if (indexDef[i] === '(') depth++;
    else if (indexDef[i] === ')') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return [];

  const body = indexDef.slice(open + 1, end);
  const parts: string[] = [];
  let current = '';
  depth = 0;
  for (const char of body) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);

  return parts
    .map((part) =>
      part
        .trim()
        // Drop operator classes and per-column modifiers PostgreSQL renders.
        .replace(/\s+(ASC|DESC|NULLS\s+(FIRST|LAST)|[a-z_]+_ops)\b/gi, '')
        .trim()
        .replace(/^"(.*)"$/, '$1'),
    )
    .filter((part) => part.length > 0);
}

async function readSqliteIndexes(
  db: DatabaseInterface,
  tableName: string,
): Promise<LiveIndex[]> {
  // `pragma_index_list` — unlike `getTableSchema()` — also reports the
  // implicit indexes SQLite creates for inline UNIQUE/PRIMARY KEY table
  // constraints (`sqlite_autoindex_*`), which is exactly where system-table
  // uniqueness lives.
  let listRows: Record<string, unknown>[];
  try {
    const result = await db.query(
      `SELECT * FROM pragma_index_list(${quoteLiteral(tableName)})`,
    );
    listRows = (result?.rows ?? []) as Record<string, unknown>[];
  } catch (error) {
    throw new LiveSchemaParityError(
      `Could not read SQLite indexes for \`${tableName}\`: ${describeError(error)}`,
      { cause: error },
    );
  }

  const indexes: LiveIndex[] = [];
  for (const row of listRows) {
    const name = String(row.name ?? '');
    if (!name) continue;

    const infoResult = await db.query(
      `SELECT * FROM pragma_index_info(${quoteLiteral(name)})`,
    );
    const infoRows = (infoResult?.rows ?? []) as Record<string, unknown>[];
    const columns = infoRows
      .slice()
      .sort((left, right) => Number(left.seqno ?? 0) - Number(right.seqno ?? 0))
      .map((infoRow) => (infoRow.name == null ? '' : String(infoRow.name)))
      .filter((column) => column.length > 0);

    indexes.push({
      name,
      columns,
      unique: toBoolean(row.unique),
      primary: String(row.origin ?? '') === 'pk',
      valid: true,
      partial: toBoolean(row.partial),
    });
  }

  return indexes;
}

async function readDuckDbIndexCatalog(
  db: DatabaseInterface,
): Promise<IndexCatalog | null> {
  // DuckDB (and the DuckDB-backed JSON adapter) expose declared indexes
  // through `duckdb_indexes()`; uniqueness constraints live in
  // `duckdb_constraints()`. Both are best-effort: if either catalog is
  // unavailable the caller skips index checks entirely.
  const byTable = new Map<string, LiveIndex[]>();
  try {
    const result = await db.query(
      `SELECT table_name, index_name, is_unique, sql FROM duckdb_indexes()`,
    );
    for (const row of (result?.rows ?? []) as Record<string, unknown>[]) {
      const tableName = String(row.table_name ?? '');
      if (!tableName) continue;
      const bucket = byTable.get(tableName) ?? [];
      bucket.push({
        name: String(row.index_name ?? ''),
        columns: parseIndexDefColumns(String(row.sql ?? '')),
        unique: toBoolean(row.is_unique),
        primary: false,
        valid: true,
        partial: false,
      });
      byTable.set(tableName, bucket);
    }
  } catch {
    return null;
  }

  try {
    const result = await db.query(
      `SELECT table_name, constraint_type, constraint_column_names FROM duckdb_constraints()`,
    );
    for (const row of (result?.rows ?? []) as Record<string, unknown>[]) {
      const constraintType = String(row.constraint_type ?? '').toUpperCase();
      if (constraintType !== 'UNIQUE' && constraintType !== 'PRIMARY KEY') {
        continue;
      }
      const tableName = String(row.table_name ?? '');
      const columns = normalizeColumnNameList(row.constraint_column_names);
      if (!tableName || columns.length === 0) continue;

      const bucket = byTable.get(tableName) ?? [];
      bucket.push({
        name: `${tableName}_${columns.join('_')}_${constraintType === 'UNIQUE' ? 'key' : 'pkey'}`,
        columns,
        unique: true,
        primary: constraintType === 'PRIMARY KEY',
        valid: true,
        partial: false,
      });
      byTable.set(tableName, bucket);
    }
  } catch {
    // Constraints are not optional metadata on this engine: DuckDB requires an
    // inline UNIQUE constraint for upsert, so uniqueness lives almost entirely
    // in `duckdb_constraints()` rather than in `duckdb_indexes()`. Without it,
    // `conflict_target_unindexed` and `unique_constraint_missing` would fire as
    // *errors* against a correct database. Degrade the whole catalog instead —
    // the caller then skips every index check and the report says
    // `indexIntrospection: 'unavailable'`.
    return null;
  }

  return { forTable: async (tableName) => byTable.get(tableName) ?? [] };
}

function normalizeColumnNameList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry)).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .replace(/^[[{]|[\]}]$/g, '')
      .split(',')
      .map((entry) => entry.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }
  return [];
}

function toBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    return value === '1' || value.toLowerCase() === 'true' || value === 't';
  }
  return false;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
