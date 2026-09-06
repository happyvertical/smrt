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
 *    list that exists live, it verifies the table has *only* the universal
 *    baseline columns (`id`, `slug`, `context`, `created_at`, `updated_at`),
 *    is referenced by no foreign key anywhere in the live database, and is
 *    empty. Any live table missing that shape — e.g. a consumer's own,
 *    unrelated table that happens to share one of these five names — is
 *    reported as unsafe and dropped nothing.
 * 3. {@link dropFrameworkBaseTables} refuses to run against a plan that is
 *    not `safe`, locks every PostgreSQL target `IN ACCESS EXCLUSIVE MODE`
 *    before re-checking it (a plain `SELECT COUNT(*)` alone would not block
 *    a concurrent writer), and re-verifies emptiness a second time inside
 *    the bounded transaction immediately before dropping anything, so a
 *    write that lands between planning and execution still stops the drop.
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
 * The only columns a genuine (never-instantiated) framework-base table may
 * have. Anything more, or anything missing, means the live table is not what
 * this remediation expects — most likely a consumer's own unrelated table
 * that happens to share the name — and must be refused rather than guessed
 * about.
 */
const BASELINE_COLUMN_NAMES = [
  'id',
  'slug',
  'context',
  'created_at',
  'updated_at',
] as const;

const BASELINE_COLUMN_SET: ReadonlySet<string> = new Set(BASELINE_COLUMN_NAMES);

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
   * The exact bounded DDL that would run: `DROP INDEX` for every companion
   * index (enumerated from the live schema) followed by `DROP TABLE` for its
   * table, per existing target table. Empty when `safe` is `false` or no
   * target table exists.
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

  if (typeof db.getTableSchema !== 'function') {
    // Fail closed: without shape introspection we cannot tell a genuine
    // framework-base table apart from a consumer's own unrelated table of
    // the same name, so every target table is reported unsafe.
    const tables: FrameworkBaseTableReport[] = FRAMEWORK_BASE_TABLE_NAMES.map(
      (name) => ({
        table: name,
        exists: true,
        rowCount: null,
        indexNames: [],
        refusals: [
          {
            kind: 'introspection-unavailable',
            reason:
              'The configured database adapter cannot describe tables (`getTableSchema` is unavailable), so table shape cannot be verified.',
          },
        ],
      }),
    );
    return { engine, tables, safe: false, statements: [] };
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

    const actualColumns = Object.keys(schema.columns).sort();
    const missingColumns = BASELINE_COLUMN_NAMES.filter(
      (column) => !schema.columns[column],
    );
    const extraColumns = actualColumns.filter(
      (column) => !BASELINE_COLUMN_SET.has(column),
    );
    if (missingColumns.length > 0 || extraColumns.length > 0) {
      refusals.push({
        kind: 'unexpected-shape',
        actualColumns,
        missingColumns,
        extraColumns,
      });
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
 * instead of holding locks against every writer. Every target is then
 * locked `IN ACCESS EXCLUSIVE MODE` — a plain `SELECT COUNT(*)` alone only
 * takes an ACCESS SHARE lock, which would let a concurrent writer commit a
 * row between the check and the DROP; holding the exclusive lock first
 * makes the check-then-drop sequence atomic. Only then is every target
 * table's row count re-checked (inside that same transaction, on all
 * engines): if anything wrote to a table between planning and this call,
 * the whole batch is refused and nothing is dropped.
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
    // lock, which does not block a concurrent writer: a row could commit
    // into a target table after this check passes but before the DROP
    // below acquires its own exclusive lock, and that row would be dropped
    // along with the table it landed in. Acquire ACCESS EXCLUSIVE on every
    // target *before* re-checking emptiness so the check and the drop are
    // atomic — once held, no other session can read or write the table
    // until this transaction ends, and `SET LOCAL lock_timeout` above
    // bounds the wait for it exactly as it bounds the DROP itself.
    if (isPostgres) {
      for (const table of targets) {
        await tx.query(
          `LOCK TABLE ${qualifyIdentifier(plan.engine, table.table)} IN ACCESS EXCLUSIVE MODE`,
        );
      }
    }

    // Belt-and-suspenders on every engine: nothing should have written to
    // these tables between the read-only plan and this transaction, but if
    // it did, refuse the whole batch rather than drop a table that is no
    // longer empty.
    for (const table of targets) {
      const rowCount = await countRows(tx, plan.engine, table.table);
      if (rowCount > 0) {
        throw new Error(
          `Refusing to drop "${table.table}": it now has ${rowCount} row(s) though it was empty when planned. Nothing was dropped.`,
        );
      }
    }

    for (const statement of plan.statements) {
      await tx.query(statement);
    }
  });

  return {
    droppedTables: targets.map((table) => table.table),
    droppedIndexes: targets.flatMap((table) => table.indexNames),
  };
}
