/**
 * One-time remediation for the five orphaned framework-base tables (#2647).
 *
 * #2644 stopped `getAllSchemasAsDefinitions()` from planning a table for
 * SMRT's abstract framework-base classes (`SmrtObject`, `SmrtClass`,
 * `SmrtCollection`, `SmrtHierarchical`, `SmrtPolymorphicAssociation`), but it
 * does not remove the ones a pre-fix `db:migrate` already created. Any
 * deployment that ran `db:migrate` before that fix has all five tables, and
 * the differ now reports them as permanent orphans (#2369's
 * `includeDroppedTables` stays `false` on purpose — see below).
 *
 * This module is a narrow, named remediation, deliberately **not** a change
 * to the general differ: `SchemaDiff.orphan_tables` already reports orphan
 * tables, and `includeDroppedTables` (default `false`, both call sites pass
 * it explicitly) is the opt-in for the executable `DROP TABLE`. That default
 * must stay `false` — flipping it globally would make `db:migrate` drop *any*
 * table absent from the manifest, which for a consumer with hand-managed or
 * legacy tables is unacceptable data loss. Dropping only these five specific,
 * hand-typed names is safe *because* nothing but the retired base-class
 * planning path could ever have created them; a general orphan drop is not.
 *
 * Safety model, in order:
 * 1. {@link FRAMEWORK_BASE_TABLE_NAMES} is a literal, hand-typed list. It is
 *    never derived from a differ orphan report or any other dynamic source —
 *    doing so would recreate the dangerous global-drop path by another route.
 * 2. {@link planFrameworkBaseTableDrop} is read-only. For every name in the
 *    list that exists live, it verifies the table has *only* that table's
 *    expected columns — the universal `id`/`slug`/`context`/`created_at`/
 *    `updated_at` base for three of the five, extended with the real fields
 *    `SmrtHierarchical`/`SmrtPolymorphicAssociation` themselves declare for
 *    `smrt_hierarchicals`/`smrt_polymorphic_associations` (see
 *    {@link EXPECTED_COLUMN_BUCKETS_BY_TABLE}) — with a plausible type for
 *    each, is referenced by no foreign key anywhere in the live database,
 *    and is empty. Any live table missing that shape — e.g. a consumer's
 *    own, unrelated table that happens to share one of these five names —
 *    is reported as unsafe and dropped nothing.
 * 3. {@link dropFrameworkBaseTables} refuses to run against a plan that is
 *    not `safe`, locks every PostgreSQL target `IN ACCESS EXCLUSIVE MODE`
 *    (a plain `SELECT COUNT(*)` alone would not block a concurrent writer),
 *    and then re-verifies shape, type, and emptiness — not just the row
 *    count — inside that same bounded transaction immediately before
 *    dropping anything. A table rewritten or replaced between planning and
 *    execution therefore still stops the whole batch, not just a row-count
 *    race. Foreign keys are checked at planning time only. On PostgreSQL, a
 *    foreign key added afterward is still caught — its FK enforcement is
 *    dependency-based, so `DROP TABLE` refuses when a real dependent
 *    exists. This does **not** hold on SQLite/DuckDB: SQLite's `DROP TABLE`
 *    only enforces against the rows actually being removed, so an empty
 *    parent (exactly this function's precondition) drops cleanly past a
 *    real foreign key, and DuckDB's adapter cannot even see the reference
 *    at plan time (see {@link qualifyIdentifier}'s doc comment). No data is
 *    lost either way — the residual risk on those two engines is a
 *    dangling reference, not data loss, confined to a narrow window a
 *    one-time operator-run command makes unlikely in practice.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { detectEngine } from '../schema/ddl/index.js';
import type { DatabaseEngine } from '../schema/ddl/types.js';
import { quoteIdentifier } from '../schema/sql-identifiers.js';
import { toSafeInteger } from '../utils/safe-integer.js';

/**
 * The exact five orphaned framework-base tables #2644 stopped planning.
 *
 * NEVER derive this list from `SchemaDiff.orphan_tables` or any other dynamic
 * introspection — that would turn this narrow remediation into the same
 * dangerous global orphan-drop that `includeDroppedTables` deliberately
 * refuses to be. Every entry is a plain string literal, on purpose.
 */
export const FRAMEWORK_BASE_TABLE_NAMES = [
  'smrt_objects',
  'smrt_classes',
  'smrt_collections',
  'smrt_hierarchicals',
  'smrt_polymorphic_associations',
] as const;

export type FrameworkBaseTableName =
  (typeof FRAMEWORK_BASE_TABLE_NAMES)[number];

/**
 * Every one of the five tables carries this universal base — but two of
 * them are not plain aliases of it. `SmrtHierarchical` and
 * `SmrtPolymorphicAssociation` are abstract classes that *extend* the
 * universal shape with their own real fields (true parent-id trees; the
 * meta/role/sort columns generic associations need), exactly like any
 * concrete class extending them would inherit those fields. Verified
 * directly against a genuine pre-#2644 `db:migrate` run (a real installed
 * multi-package consumer, not hand-typed DDL): `smrt_hierarchicals` and
 * `smrt_polymorphic_associations` are generated with the extra columns
 * below every time, on every engine. A per-table expectation is therefore
 * required — treating all five as the plain 5-column baseline would refuse
 * to ever drop these two genuine framework-base tables, reporting their own
 * real columns as "unexpected".
 */
const UNIVERSAL_BASE_COLUMNS = [
  'id',
  'slug',
  'context',
  'created_at',
  'updated_at',
] as const;

/**
 * Coarse, dialect-tolerant type buckets. A live column with a matching
 * *name* but an unrelated *type* (`id INTEGER`, `context BOOLEAN`, ...) is
 * not a genuine framework-base table — it is a consumer's own table that
 * happens to share every column name — and a name-only check alone cannot
 * see that.
 *
 * Buckets, not exact strings: PostgreSQL may report `TIMESTAMP` or
 * `TIMESTAMPTZ` depending on configuration, DuckDB normalizes `TEXT` to
 * `VARCHAR`, and SQLite's generator emits `DATETIME` — all legitimate for a
 * real framework-base table on their engine. Only a column outside its
 * expected bucket entirely (an integer where text was expected, a boolean,
 * a float) is refused.
 */
type ColumnTypeBucket = 'text' | 'uuid' | 'timestamp' | 'integer' | 'other';

function classifyColumnType(type: string): ColumnTypeBucket {
  const normalized = type
    .toUpperCase()
    .trim()
    .replace(/\(\s*\d+\s*\)/g, '');
  if (/^UUID$/.test(normalized)) return 'uuid';
  if (/^(TEXT|CLOB|STRING|VARCHAR|CHAR)/.test(normalized)) return 'text';
  if (/^(TIMESTAMP|DATETIME|DATE)/.test(normalized)) return 'timestamp';
  if (/^(INTEGER|INT|BIGINT|SMALLINT|TINYINT)$/.test(normalized)) {
    return 'integer';
  }
  return 'other';
}

const UNIVERSAL_BASE_BUCKETS: Record<
  (typeof UNIVERSAL_BASE_COLUMNS)[number],
  readonly ColumnTypeBucket[]
> = {
  id: ['text', 'uuid'],
  slug: ['text'],
  context: ['text'],
  created_at: ['timestamp'],
  updated_at: ['timestamp'],
};

/**
 * The exact columns (and their expected type buckets) each of the five
 * tables may have — the universal base for three of them, extended for
 * `smrt_hierarchicals` (true parent-id tree: `parent_id`) and
 * `smrt_polymorphic_associations` (generic association: `meta_type`,
 * `meta_id`, `role`, `sort_order`), matching {@link SmrtHierarchical} /
 * {@link SmrtPolymorphicAssociation}'s own real field declarations exactly.
 * Anything more, or anything missing, on any of the five means the live
 * table is not what this remediation expects — most likely a consumer's
 * own unrelated table that happens to share the name — and must be refused
 * rather than guessed about.
 */
const EXPECTED_COLUMN_BUCKETS_BY_TABLE: Record<
  FrameworkBaseTableName,
  Readonly<Record<string, readonly ColumnTypeBucket[]>>
> = {
  smrt_objects: UNIVERSAL_BASE_BUCKETS,
  smrt_classes: UNIVERSAL_BASE_BUCKETS,
  smrt_collections: UNIVERSAL_BASE_BUCKETS,
  smrt_hierarchicals: {
    ...UNIVERSAL_BASE_BUCKETS,
    parent_id: ['text', 'uuid'],
  },
  smrt_polymorphic_associations: {
    ...UNIVERSAL_BASE_BUCKETS,
    meta_type: ['text'],
    meta_id: ['text', 'uuid'],
    role: ['text'],
    sort_order: ['integer'],
  },
};

const DEFAULT_POSTGRES_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_POSTGRES_STATEMENT_TIMEOUT_MS = 60_000;

/** Why a target table was refused. A table can carry more than one. */
export type FrameworkBaseTableRefusal =
  | { kind: 'not-empty'; rowCount: number }
  | {
      kind: 'unexpected-shape';
      actualColumns: string[];
      missingColumns: string[];
      extraColumns: string[];
    }
  | {
      kind: 'unexpected-column-type';
      mismatches: Array<{
        column: string;
        actualType: string;
        expectedBuckets: string[];
      }>;
    }
  | {
      kind: 'referenced-by-foreign-key';
      references: Array<{ table: string; column: string }>;
    }
  | { kind: 'introspection-unavailable'; reason: string };

/** Plan/refusal findings for one of the five candidate tables. */
export interface FrameworkBaseTableReport {
  table: FrameworkBaseTableName;
  /** Whether this table exists in the live database at all. */
  exists: boolean;
  /** `null` when the table does not exist or its row count was not read. */
  rowCount: number | null;
  /** Live index names on this table, enumerated from the schema — never guessed. */
  indexNames: string[];
  /** Empty when this table (if it exists) is safe to drop. */
  refusals: FrameworkBaseTableRefusal[];
}

/** The full remediation plan: what would be dropped, and why it is or isn't safe. */
export interface FrameworkBaseTablesPlan {
  engine: DatabaseEngine;
  /** One entry per {@link FRAMEWORK_BASE_TABLE_NAMES}, in that order. */
  tables: FrameworkBaseTableReport[];
  /** True only when every existing target table has zero refusals. */
  safe: boolean;
  /**
   * The plan for the `--dry-run` preview: `DROP INDEX` for every companion
   * index (enumerated from the live schema, never guessed) followed by
   * `DROP TABLE` for its table, per existing target table. Empty when
   * `safe` is `false` or no target table exists.
   *
   * {@link dropFrameworkBaseTables} does not execute the `DROP INDEX`
   * entries verbatim — see its doc comment for why — so this array is a
   * complete and accurate *forecast* of what a real run does to the
   * database, but is not literally replayed statement-by-statement.
   */
  statements: string[];
}

export interface PlanFrameworkBaseTableDropOptions {
  /** Adapter hint when the database URL does not identify the engine. */
  engineHint?: string;
}

function resolveDatabaseUrl(db: DatabaseInterface): string {
  const dbWithConfig = db as DatabaseInterface & { config?: { url?: string } };
  return db.url || dbWithConfig.config?.url || '';
}

/**
 * Qualify a table or index identifier so execution resolves to exactly the
 * object inspection looked at.
 *
 * `getExistingTableNames()` and `getTableSchema()` both scope PostgreSQL
 * discovery to the `public` schema, but a plain `quoteIdentifier(name)` in a
 * `SELECT`/`DROP` statement resolves through the session's `search_path`
 * instead — which can list another schema before `public`. An empty,
 * unrelated same-named table or index earlier on that path would otherwise
 * satisfy every safety check yet let the DROP hit a different object than
 * the one just verified. SQLite and DuckDB have no equivalent search-path
 * ambiguity for this module's purposes, so only PostgreSQL is schema-qualified.
 *
 * Known limitation, documented rather than fixed: this module (like
 * `differ.ts` and `live-parity.ts` elsewhere in this package) only ever
 * discovers PostgreSQL objects in the `public` schema — multi-schema
 * PostgreSQL deployments are not a supported SMRT configuration anywhere in
 * this package. A table in a *different* schema with a foreign key onto one
 * of these five names is therefore invisible to the `referenced-by-foreign-key`
 * check. It is not, however, an actual data-loss risk: PostgreSQL's own
 * foreign-key enforcement refuses the `DROP TABLE` at execution time
 * ("cannot drop table ... because other objects depend on it") inside this
 * module's bounded transaction, so nothing is still dropped — exactly the
 * same fail-safe shape as the documented DuckDB foreign-key gap below, just
 * surfaced as a generic execution error instead of a curated refusal.
 */
function qualifyIdentifier(engine: DatabaseEngine, name: string): string {
  return engine === 'postgres'
    ? `"public".${quoteIdentifier(name)}`
    : quoteIdentifier(name);
}

async function getExistingTableNames(
  db: DatabaseInterface,
  engine: DatabaseEngine,
): Promise<Set<string>> {
  const query =
    engine === 'postgres'
      ? `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
      : // SQLite and DuckDB both expose the SQLite-compatible `sqlite_master`
        // catalog (differ.ts's `getExistingTables()` verified this against a
        // live DuckDB build; see that comment for detail).
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`;

  const result = await db.query(query);
  const rows = result.rows as { name?: string; table_name?: string }[];
  return new Set(
    rows.map((row) => row.name || row.table_name || '').filter(Boolean),
  );
}

async function countRows(
  db: DatabaseInterface,
  engine: DatabaseEngine,
  table: string,
): Promise<number> {
  const result = await db.query(
    `SELECT COUNT(*) AS row_count FROM ${qualifyIdentifier(engine, table)}`,
  );
  return toSafeInteger(
    result.rows?.[0]?.row_count ?? 0,
    `Framework base-table row count for ${table}`,
  );
}

/**
 * Render a millisecond timeout as a PostgreSQL interval literal.
 *
 * Mirrors `formatPostgresTimeout` in `migrations/tracker.ts` (#2362) — kept
 * as a tiny local copy rather than an import so this module stays a
 * self-contained, easily audited remediation rather than reaching into the
 * migration tracker's internals for one string helper.
 */
function formatPostgresTimeout(milliseconds: number): string {
  return `${Math.max(0, Math.trunc(milliseconds))}ms`;
}

/**
 * Column name → declared type, read with a query every engine supports
 * *inside a transaction* — unlike `getTableSchema()`, which
 * `@happyvertical/sql` does not expose on the connection object a
 * `db.transaction()` callback receives (verified directly: `typeof
 * tx.getTableSchema` is `undefined`). Used only for the execution-time
 * re-check in {@link dropFrameworkBaseTables}; planning uses the richer
 * `getTableSchema()` on the ordinary (non-transactional) connection.
 *
 * Returns `null` when the table cannot be described right now — SQLite
 * returns zero rows for an unknown table, DuckDB instead throws a Catalog
 * Error (caught below) — either way meaning "cannot confirm this is safe",
 * which must fail closed exactly like a table that no longer exists.
 */
async function inspectColumnTypes(
  db: DatabaseInterface,
  engine: DatabaseEngine,
  table: string,
): Promise<Record<string, string> | null> {
  try {
    if (engine === 'postgres') {
      const result = await db.query(
        `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
        table,
      );
      const rows = result.rows as { column_name: string; data_type: string }[];
      if (rows.length === 0) return null;
      const columns: Record<string, string> = {};
      for (const row of rows) columns[row.column_name] = row.data_type;
      return columns;
    }

    const result = await db.query(
      `PRAGMA table_info(${quoteIdentifier(table)})`,
    );
    const rows = result.rows as { name?: string; type?: string }[];
    if (rows.length === 0) return null;
    const columns: Record<string, string> = {};
    for (const row of rows) {
      if (row.name) columns[row.name] = row.type ?? '';
    }
    return columns;
  } catch {
    return null;
  }
}

/**
 * Compare a freshly-read column map against `table`'s expected shape/type,
 * returning a human-readable reason it is unsafe, or `null` when it matches
 * exactly. Shared by the execution-time re-check so its comparison logic
 * cannot drift from {@link assessTargets}'s own definitions
 * ({@link EXPECTED_COLUMN_BUCKETS_BY_TABLE}, {@link classifyColumnType}).
 */
function describeColumnMismatch(
  table: FrameworkBaseTableName,
  columns: Record<string, string>,
): string | null {
  const expectedBuckets = EXPECTED_COLUMN_BUCKETS_BY_TABLE[table];
  const expectedColumns = Object.keys(expectedBuckets);
  const actualColumns = Object.keys(columns).sort();
  const missingColumns = expectedColumns.filter(
    (column) => !(column in columns),
  );
  const extraColumns = actualColumns.filter(
    (column) => !(column in expectedBuckets),
  );
  if (missingColumns.length > 0 || extraColumns.length > 0) {
    return `unexpected column shape (actual columns: ${actualColumns.join(', ')})`;
  }

  const typeMismatches = expectedColumns
    .map((column) => {
      const actualType = columns[column] ?? '';
      const bucket = classifyColumnType(actualType);
      return expectedBuckets[column].includes(bucket)
        ? null
        : `${column} is "${actualType}"`;
    })
    .filter((entry): entry is string => entry !== null);
  if (typeMismatches.length > 0) {
    return `unexpected column type (${typeMismatches.join(', ')})`;
  }

  return null;
}

/**
 * Read-only assessment: for each of the five target names, is it safe to
 * drop, and why or why not?
 *
 * Used only by {@link planFrameworkBaseTableDrop}'s unlocked preflight, via
 * `getTableSchema()`. {@link dropFrameworkBaseTables}'s own execution-time
 * re-check does **not** call this function or reuse its logic wholesale: it
 * re-verifies shape and type from raw `information_schema.columns` /
 * `PRAGMA table_info` instead, because `getTableSchema()` is not available
 * on the transaction-scoped connection a `db.transaction()` callback
 * receives (see that function's own doc comment for the full rationale,
 * including why foreign keys are deliberately not re-scanned there). Never
 * mutates the database.
 */
async function assessTargets(
  db: DatabaseInterface,
  engine: DatabaseEngine,
): Promise<{ tables: FrameworkBaseTableReport[]; safe: boolean }> {
  if (typeof db.getTableSchema !== 'function') {
    // Fail closed for any target that actually exists: without shape
    // introspection we cannot tell a genuine framework-base table apart
    // from a consumer's own unrelated table of the same name. But existence
    // itself only needs a raw catalog query (`getExistingTableNames()`,
    // which never calls `getTableSchema()`), so a database with none of the
    // five tables present is still a safe, clean no-op even on an adapter
    // this degraded — refusing unconditionally here would report five
    // nonexistent tables as unsafe instead of nothing to do.
    const existingTableNames = await getExistingTableNames(db, engine);
    const tables: FrameworkBaseTableReport[] = FRAMEWORK_BASE_TABLE_NAMES.map(
      (name) =>
        existingTableNames.has(name)
          ? {
              table: name,
              exists: true,
              rowCount: null,
              indexNames: [],
              refusals: [
                {
                  kind: 'introspection-unavailable' as const,
                  reason:
                    'The configured database adapter cannot describe tables (`getTableSchema` is unavailable), so table shape cannot be verified.',
                },
              ],
            }
          : {
              table: name,
              exists: false,
              rowCount: null,
              indexNames: [],
              refusals: [],
            },
    );
    return {
      tables,
      safe: tables.every((table) => table.refusals.length === 0),
    };
  }

  const existingTableNames = await getExistingTableNames(db, engine);

  // Build one reverse foreign-key index across every live table, not just
  // the five candidates: a real, unrelated table anywhere in the database
  // could reference one of these names, and only a full-catalog scan catches
  // that (mirrors differ.ts's own full-catalog scan for the #2608 uuid
  // convergence plan).
  //
  // Known gap on DuckDB: `@happyvertical/sql`'s DuckDB adapter never
  // populates `getTableSchema().foreignKeys` (verified directly — even a
  // table-level `FOREIGN KEY (...) REFERENCES ...` constraint comes back
  // empty), so this scan cannot see a real inbound reference there and the
  // plan will report the table safe. DuckDB itself still refuses the DROP
  // TABLE with a catalog error inside the bounded transaction in that case,
  // so nothing unsafe is actually dropped — the refusal just surfaces at
  // execution instead of at planning, with DuckDB's own error text instead
  // of `referenced-by-foreign-key`.
  const inboundForeignKeys = new Map<
    string,
    Array<{ table: string; column: string }>
  >();
  for (const liveTable of existingTableNames) {
    const liveSchema = await db.getTableSchema(liveTable);
    for (const foreignKey of liveSchema?.foreignKeys ?? []) {
      const references =
        inboundForeignKeys.get(foreignKey.referencesTable) ?? [];
      references.push({ table: liveTable, column: foreignKey.column });
      inboundForeignKeys.set(foreignKey.referencesTable, references);
    }
  }

  const tables: FrameworkBaseTableReport[] = [];
  let safe = true;

  for (const name of FRAMEWORK_BASE_TABLE_NAMES) {
    if (!existingTableNames.has(name)) {
      tables.push({
        table: name,
        exists: false,
        rowCount: null,
        indexNames: [],
        refusals: [],
      });
      continue;
    }

    const schema = await db.getTableSchema(name);
    const refusals: FrameworkBaseTableRefusal[] = [];

    if (!schema) {
      refusals.push({
        kind: 'introspection-unavailable',
        reason: `getTableSchema("${name}") returned no result even though the table exists.`,
      });
      tables.push({
        table: name,
        exists: true,
        rowCount: null,
        indexNames: [],
        refusals,
      });
      safe = false;
      continue;
    }

    const expectedBucketsForTable = EXPECTED_COLUMN_BUCKETS_BY_TABLE[name];
    const expectedColumnsForTable = Object.keys(expectedBucketsForTable);
    const actualColumns = Object.keys(schema.columns).sort();
    const missingColumns = expectedColumnsForTable.filter(
      (column) => !schema.columns[column],
    );
    const extraColumns = actualColumns.filter(
      (column) => !(column in expectedBucketsForTable),
    );
    if (missingColumns.length > 0 || extraColumns.length > 0) {
      refusals.push({
        kind: 'unexpected-shape',
        actualColumns,
        missingColumns,
        extraColumns,
      });
    } else {
      // The column *set* matches exactly — only meaningful to type-check
      // when every expected column is actually present and nothing extra
      // is there to confuse the comparison.
      const mismatches = expectedColumnsForTable
        .map((column) => {
          const actualType = schema.columns[column]?.type ?? '';
          const bucket = classifyColumnType(actualType);
          const expectedBuckets = expectedBucketsForTable[column];
          return expectedBuckets.includes(bucket)
            ? null
            : { column, actualType, expectedBuckets: [...expectedBuckets] };
        })
        .filter(
          (mismatch): mismatch is NonNullable<typeof mismatch> =>
            mismatch !== null,
        );
      if (mismatches.length > 0) {
        refusals.push({ kind: 'unexpected-column-type', mismatches });
      }
    }

    const references = inboundForeignKeys.get(name) ?? [];
    if (references.length > 0) {
      refusals.push({ kind: 'referenced-by-foreign-key', references });
    }

    const rowCount = await countRows(db, engine, name);
    if (rowCount > 0) {
      refusals.push({ kind: 'not-empty', rowCount });
    }

    const indexNames = (schema.indexes ?? []).map((index) => index.name);

    if (refusals.length > 0) safe = false;

    tables.push({ table: name, exists: true, rowCount, indexNames, refusals });
  }

  return { tables, safe };
}

/**
 * Read-only preflight: is it safe to drop the five framework-base tables,
 * and what exactly would that require?
 *
 * Never mutates the database. Safe to call for `--dry-run` and as the
 * required first half of a real run.
 */
export async function planFrameworkBaseTableDrop(
  db: DatabaseInterface,
  options: PlanFrameworkBaseTableDropOptions = {},
): Promise<FrameworkBaseTablesPlan> {
  const engine = detectEngine(resolveDatabaseUrl(db), options.engineHint);
  const { tables, safe } = await assessTargets(db, engine);

  const statements: string[] = [];
  if (safe) {
    for (const table of tables) {
      if (!table.exists) continue;
      for (const indexName of table.indexNames) {
        statements.push(
          `DROP INDEX IF EXISTS ${qualifyIdentifier(engine, indexName)}`,
        );
      }
      statements.push(
        `DROP TABLE IF EXISTS ${qualifyIdentifier(engine, table.table)}`,
      );
    }
  }

  return { engine, tables, safe, statements };
}

export interface DropFrameworkBaseTablesOptions {
  /** PostgreSQL lock timeout in milliseconds (defaults to 30 seconds). */
  lockTimeout?: number;
  /** PostgreSQL statement timeout in milliseconds (defaults to 60 seconds). */
  statementTimeout?: number;
}

export interface DropFrameworkBaseTablesResult {
  droppedTables: string[];
  droppedIndexes: string[];
}

/**
 * Execute a plan produced by {@link planFrameworkBaseTableDrop}.
 *
 * Refuses outright when the plan is not `safe` — callers must resolve every
 * refusal (by fixing the underlying data, or accepting that a table is not a
 * genuine framework-base table) rather than forcing this function past them.
 *
 * On PostgreSQL the whole batch runs in one transaction bounded by
 * `SET LOCAL lock_timeout` / `SET LOCAL statement_timeout` (#2362), so a
 * batch that queues behind a long-running writer fails fast and rolls back
 * instead of holding locks against every writer. Every target is then locked
 * `IN ACCESS EXCLUSIVE MODE` — a plain `SELECT COUNT(*)` alone only takes an
 * ACCESS SHARE lock, which would let a concurrent writer commit a row (or a
 * concurrent DDL session replace the table entirely) between the check and
 * the DROP; holding the exclusive lock first makes the check-then-drop
 * sequence atomic.
 *
 * Immediately before dropping anything, this re-verifies column shape,
 * column type, and emptiness inside that same transaction — not just the
 * row count `planFrameworkBaseTableDrop()` already checked. This uses raw
 * `information_schema.columns` (PostgreSQL) / `PRAGMA table_info`
 * (SQLite/DuckDB) queries rather than `getTableSchema()`: `@happyvertical/sql`
 * does not expose that richer introspection method on the transaction-scoped
 * connection this callback receives, only `query()`. Foreign keys are
 * deliberately **not** re-scanned here — doing so would need a fresh
 * full-catalog scan on every drop.
 *
 * On PostgreSQL a foreign key that appeared after planning is still caught:
 * its FK enforcement is dependency-based, so `DROP TABLE` itself refuses
 * when a real dependent exists, empty parent or not. **This does not hold
 * on SQLite** — verified directly: `DROP TABLE` there only checks FK
 * enforcement against the rows actually being removed, so a parent with
 * zero rows (exactly the state this function requires) drops cleanly even
 * with a real, enforced foreign key pointing at it, leaving the referencing
 * table with a dangling reference. On SQLite/DuckDB, the plan-time
 * full-catalog scan is therefore the *only* gate against a foreign key on
 * these two engines — narrower than PostgreSQL's, on top of the
 * already-documented DuckDB introspection gap in
 * {@link qualifyIdentifier}'s doc comment where that plan-time scan cannot
 * see the reference at all. No data is lost either way (the target table is
 * verified empty before every drop); the residual risk is a dangling
 * reference in the very narrow window between planning and this
 * transaction, on either engine, or an FK created after planning at all.
 *
 * Only `plan.statements`' `DROP TABLE` entries are executed — the
 * `DROP INDEX` entries are not. An index name is unique per schema
 * (PostgreSQL) / globally (SQLite), so nothing re-verifies it is still the
 * same object between planning and execution the way the table itself now
 * is; re-issuing a stale `DROP INDEX` by name could hit an unrelated index
 * created under that name in the meantime. `DROP TABLE` cascades to every
 * index actually owned by the table on every engine this module supports,
 * resolved fresh from the database's own catalog at drop time — identity-safe
 * by construction, unlike a second name-based statement would be.
 */
export async function dropFrameworkBaseTables(
  db: DatabaseInterface,
  plan: FrameworkBaseTablesPlan,
  options: DropFrameworkBaseTablesOptions = {},
): Promise<DropFrameworkBaseTablesResult> {
  if (!plan.safe) {
    throw new Error(
      'Refusing to drop framework base tables: the plan reported at least one unsafe table. Re-run planFrameworkBaseTableDrop() and resolve every refusal first — nothing was dropped.',
    );
  }

  const targets = plan.tables.filter((table) => table.exists);
  if (targets.length === 0) {
    return { droppedTables: [], droppedIndexes: [] };
  }

  if (!db.transaction) {
    throw new Error(
      'Dropping framework base tables requires a database adapter with transaction support.',
    );
  }

  const lockTimeoutMs = options.lockTimeout ?? DEFAULT_POSTGRES_LOCK_TIMEOUT_MS;
  const statementTimeoutMs =
    options.statementTimeout ?? DEFAULT_POSTGRES_STATEMENT_TIMEOUT_MS;
  const isPostgres = plan.engine === 'postgres';

  await db.transaction(async (tx) => {
    if (isPostgres) {
      await tx.query(
        `SET LOCAL lock_timeout = '${formatPostgresTimeout(lockTimeoutMs)}'`,
      );
      await tx.query(
        `SET LOCAL statement_timeout = '${formatPostgresTimeout(statementTimeoutMs)}'`,
      );
    }

    // On PostgreSQL, a plain `SELECT COUNT(*)` takes only an ACCESS SHARE
    // lock, which does not block a concurrent writer or a concurrent DDL
    // session dropping and recreating the same name as an unrelated table:
    // either could land after this check passes but before the DROP below
    // acquires its own exclusive lock. Acquire ACCESS EXCLUSIVE on every
    // target *before* re-assessing it so the check and the drop are atomic —
    // once held, no other session can read, write, or alter the table until
    // this transaction ends, and `SET LOCAL lock_timeout` above bounds the
    // wait for it exactly as it bounds the DROP itself.
    if (isPostgres) {
      for (const table of targets) {
        await tx.query(
          `LOCK TABLE ${qualifyIdentifier(plan.engine, table.table)} IN ACCESS EXCLUSIVE MODE`,
        );
      }
    }

    // Re-verify shape, type, and emptiness inside this transaction (locked,
    // on PostgreSQL) immediately before dropping anything — a table could
    // have been rewritten, or (on PostgreSQL, before the locks above were
    // acquired) dropped and replaced by an unrelated same-named table, since
    // the read-only plan. Trusting the original plan's findings past that
    // point would let the drop proceed against a table the plan never
    // actually verified. See this function's own doc comment for why
    // foreign keys are not re-scanned here.
    for (const target of targets) {
      const liveColumns = await inspectColumnTypes(
        tx,
        plan.engine,
        target.table,
      );
      if (!liveColumns) {
        throw new Error(
          `Refusing to drop "${target.table}": it could not be re-verified inside the transaction (it may no longer exist). Nothing was dropped.`,
        );
      }

      const mismatch = describeColumnMismatch(target.table, liveColumns);
      if (mismatch) {
        throw new Error(
          `Refusing to drop "${target.table}": a fresh check inside the transaction found an ${mismatch}. Nothing was dropped.`,
        );
      }

      const rowCount = await countRows(tx, plan.engine, target.table);
      if (rowCount > 0) {
        throw new Error(
          `Refusing to drop "${target.table}": it now has ${rowCount} row(s) though it was empty when planned. Nothing was dropped.`,
        );
      }
    }

    // Execute only the `DROP TABLE` statements, never the `DROP INDEX`
    // statements `plan.statements` also carries for the dry-run preview.
    // An index name is unique per schema (PostgreSQL) / globally (SQLite),
    // so a live name collision with the one enumerated at plan time
    // necessarily means the object is not the one this re-check just
    // verified — the same "swapped between planning and execution" risk
    // the table-side re-check above closes, but for indexes there is no
    // cheap re-verification to run. `DROP TABLE` itself cascades to every
    // index actually owned by the table on every engine this module
    // supports, which is identity-safe by construction: the database
    // resolves "this table's indexes" fresh at drop time from its own
    // catalog, never by matching the stale planned name.
    for (const statement of plan.statements) {
      if (statement.startsWith('DROP INDEX')) continue;
      await tx.query(statement);
    }
  });

  return {
    droppedTables: targets.map((table) => table.table),
    droppedIndexes: targets.flatMap((table) => table.indexNames),
  };
}
