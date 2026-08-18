/**
 * SQLite table-rebuild migrations (issue #2370)
 *
 * SQLite has no `ALTER TABLE ... ALTER COLUMN ... TYPE`. Before this module
 * every type-bucket change on SQLite (the canonical one being a numeric
 * default edited from `0` to `0.0`, i.e. INTEGER → REAL) turned into an
 * advisory differ comment, which `db:migrate` classifies as
 * *manual intervention* and exits 1 for — forever, because nothing in the
 * toolchain could ever perform the change.
 *
 * This module turns that comment into the executable rebuild SQLite's own
 * documentation prescribes ("Making Other Kinds Of Table Schema Changes",
 * lang_altertable.html):
 *
 * 1. `PRAGMA defer_foreign_keys = ON` — defers foreign-key enforcement to
 *    COMMIT so the window where the table does not exist cannot raise. It is
 *    honored *inside* a transaction (unlike `PRAGMA foreign_keys`, which is a
 *    silent no-op there) and resets itself at COMMIT/ROLLBACK.
 * 2. Create a new table under a reserved `_smrt_rebuild_` name carrying the
 *    target shape.
 * 3. Copy every row across.
 * 4. Drop the original table.
 * 5. Rename the new table into its place, with `PRAGMA legacy_alter_table`
 *    ON for the rename itself (see {@link buildSqliteRebuildStatements}).
 * 6. Recreate the indexes and triggers that died with the original table.
 *
 * The whole plan is a plain statement list, so it is executed by the
 * `MigrationTracker` inside the same transaction as the rest of the batch:
 * a failure anywhere rolls the table back to its original shape and contents.
 *
 * ## The target shape comes from the live DDL, not from the manifest
 *
 * The new table is the *original* `CREATE TABLE` text with only the drifted
 * columns' type tokens replaced. That deliberately preserves everything the
 * manifest does not model or does not own here: columns the manifest has
 * dropped (SMRT is additive — a rebuild must not become an implicit
 * `DROP COLUMN`), table-level constraints, `CHECK`s, collations, and table
 * options such as `WITHOUT ROWID`. The `add_column` changes in the same batch
 * still run their own `ALTER TABLE ... ADD COLUMN`, against the rebuilt table
 * — {@link planSqliteTableRebuilds} hoists the rebuild ahead of them for
 * exactly that reason.
 *
 * ## Why the copy carries no CAST
 *
 * The copy is a plain `INSERT INTO new SELECT ... FROM old`; SQLite applies
 * the destination column's *affinity* on insert, which is exactly the
 * conversion a fresh table would have performed (integer `1` becomes real
 * `1.0` in a REAL column). An explicit `CAST` would be strictly worse: casting
 * a non-numeric TEXT value to REAL/INTEGER silently yields `0`, and casting an
 * ISO timestamp string to SQLite's NUMERIC-affinity `DATETIME` silently yields
 * the leading year. Affinity conversion leaves values it cannot convert
 * untouched instead of destroying them.
 *
 * ## When the rebuild refuses
 *
 * With `PRAGMA foreign_keys` enabled — which the SMRT SQLite adapter is by
 * default — `DROP TABLE` performs an implicit `DELETE FROM` that fires
 * `ON DELETE` actions on children. A child with `ON DELETE CASCADE` therefore
 * loses its rows, and `defer_foreign_keys` does not help: it defers
 * constraint *checks*, not FK *actions*. So when any table declares a foreign
 * key onto the rebuild target and enforcement is on, the plan is refused and
 * the change stays a manual intervention. That includes the target's own
 * self-references, because the staging table copies them and so becomes a
 * child of the table being dropped.
 */

import { createLogger } from '@happyvertical/logger';
import { quoteIdentifier } from '../schema/sql-identifiers.js';
import type { SchemaChange, SQLDataType } from '../schema/types.js';
import type { DatabaseInterface } from './types.js';

const logger = createLogger({ level: 'info' });

/**
 * Prefix of the reserved staging table a rebuild creates. `_smrt_`-prefixed
 * names are SMRT system tables, which the differ's dropped-table sweep skips,
 * so a staging table left behind by a non-transactional adapter cannot be
 * mistaken for user data.
 */
export const SQLITE_REBUILD_TABLE_PREFIX = '_smrt_rebuild_';

/**
 * The advisory SQL the differ emits for a SQLite type upgrade it cannot
 * perform with an `ALTER TABLE`. `planSqliteTableRebuilds` replaces it with an
 * executable plan; when it cannot, the comment survives and `db:migrate`
 * reports the column as manual drift exactly as it did before #2370.
 */
export function sqliteRebuildPlaceholderSql(columnName: string): string {
  return `-- SQLite: Type upgrade for ${quoteIdentifier(columnName)} requires table recreation`;
}

/**
 * True when `sql` is the differ's "requires table recreation" placeholder —
 * i.e. a type upgrade waiting for this module to turn it into a rebuild.
 */
export function isSqliteRebuildPlaceholder(sql: string | undefined): boolean {
  return typeof sql === 'string' && sql.includes('requires table recreation');
}

function blockedSql(columnName: string, reason: string): string {
  // Must stay a single line, and must not read as a no-op: the CLI classifies
  // any comment that says "no change needed" as noop and drops it silently.
  return `-- SQLite: ${quoteIdentifier(columnName)} requires a table rebuild, blocked: ${reason}`;
}

function coveredSql(columnName: string, rebuiltWith: string): string {
  // Classified `noop` by the CLI (`no change needed`): the sibling change
  // carrying the plan rebuilds the whole table, this column included.
  return `-- SQLite: ${quoteIdentifier(columnName)} is rebuilt with ${quoteIdentifier(rebuiltWith)} in one table rebuild (no change needed)`;
}

/** A rebuild plan: the ordered statements plus what they touch. */
export interface SqliteTableRebuildPlan {
  /** Ordered, executable statements. Run them in one transaction. */
  statements: string[];
  /** Columns copied from the old table into the new one, in table order. */
  copiedColumns: string[];
  /** Names of the indexes and triggers recreated after the swap. */
  recreatedObjects: string[];
}

/** Live SQLite state a rebuild needs before it can plan anything. */
interface SqliteRebuildContext {
  /** `sqlite_master.sql` for the table (SQLite normalizes IF NOT EXISTS away). */
  createTableSql: string;
  /**
   * Column names in `PRAGMA table_info` order. That pragma omits generated
   * columns, which is what the copy wants: they are not insertable and the
   * preserved DDL recomputes them in the new table.
   */
  columns: string[];
  /** Indexes and triggers that will die with the dropped table. */
  objects: { name: string; sql: string }[];
  /** Whether `PRAGMA foreign_keys` enforcement is on for this connection. */
  foreignKeysEnabled: boolean;
  /** Current `PRAGMA legacy_alter_table` value, restored after the rename. */
  legacyAlterTable: boolean;
  /** Other tables declaring a foreign key onto this table. */
  inboundReferences: string[];
}

export interface PlanSqliteTableRebuildsOptions {
  db: DatabaseInterface;
  tableName: string;
  /** The table's changes, as produced by the differ's column comparison. */
  changes: SchemaChange[];
  /** Abstract → SQLite type mapping (the engine's DDL strategy `mapType`). */
  mapType: (type: SQLDataType) => string;
}

/**
 * Replace every "requires table recreation" placeholder for `tableName` with
 * one executable rebuild.
 *
 * All of the table's drifted columns are retyped by a *single* rebuild, so the
 * first placeholder carries the plan and the rest become no-ops that reference
 * it. Returns the changes unchanged when there is nothing to rebuild, and
 * leaves the placeholders in place (annotated with the reason) when the
 * rebuild cannot be planned safely — the pre-#2370 manual-intervention
 * behavior.
 *
 * When a plan is produced, the rebuild is hoisted to the front of the table's
 * changes. The plan's staging DDL and copy list are captured from the live
 * schema *at diff time*, so a same-batch `ALTER TABLE ... ADD COLUMN` that ran
 * first would be silently undone by the rebuild — both statements succeed, the
 * transaction commits, and the new column is simply gone. The differ emits
 * changes in manifest field order, which puts an `add_column` first whenever
 * the new field is declared above the retyped one, so the order has to be
 * imposed here rather than assumed. Rebuild first, then add columns to the
 * rebuilt table.
 */
export async function planSqliteTableRebuilds(
  options: PlanSqliteTableRebuildsOptions,
): Promise<SchemaChange[]> {
  const { db, tableName, changes, mapType } = options;

  const pending = changes.filter(
    (change) =>
      change.type === 'type_upgrade' &&
      change.name &&
      change.column &&
      isSqliteRebuildPlaceholder(change.sql),
  );
  if (pending.length === 0) {
    return changes;
  }

  const block = (reason: string): SchemaChange[] => {
    logger.debug(
      `[SQLiteRebuild] Cannot rebuild ${tableName}: ${reason}; leaving ${pending.length} type upgrade(s) as manual drift`,
    );
    return changes.map((change) =>
      pending.includes(change)
        ? { ...change, sql: blockedSql(change.name as string, reason) }
        : change,
    );
  };

  let context: SqliteRebuildContext;
  try {
    context = await readSqliteRebuildContext(db, tableName);
  } catch (error) {
    return block(
      `live schema introspection failed (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  if (!context.createTableSql) {
    return block('no CREATE TABLE statement found in sqlite_master');
  }
  if (context.columns.length === 0) {
    return block('PRAGMA table_info returned no columns');
  }
  if (context.foreignKeysEnabled && context.inboundReferences.length > 0) {
    return block(
      `PRAGMA foreign_keys is ON and ${context.inboundReferences
        .map((name) => `"${name}"`)
        .join(
          ', ',
        )} declare a foreign key onto this table, so DROP TABLE would fire their ON DELETE actions`,
    );
  }

  const columnTypes = new Map<string, string>();
  for (const change of pending) {
    columnTypes.set(
      change.name as string,
      mapType((change.column as { type: SQLDataType }).type),
    );
  }

  const plan = buildSqliteRebuildStatements({
    tableName,
    createTableSql: context.createTableSql,
    columnTypes,
    columns: context.columns,
    objects: context.objects,
    legacyAlterTable: context.legacyAlterTable,
  });

  if (!plan) {
    return block(
      'the live CREATE TABLE statement could not be rewritten for the target column types',
    );
  }

  const [primary, ...covered] = pending;
  const rebuilt = changes.map((change) => {
    if (change === primary) {
      return {
        ...change,
        // `sql` stays a real statement so the CLI classifies this upgrade as
        // executable; every consumer that actually runs the change prefers
        // `sqlStatements`.
        sql: plan.statements[0],
        sqlStatements: plan.statements,
      };
    }
    if (covered.includes(change)) {
      const { sqlStatements: _dropped, ...rest } = change;
      return {
        ...rest,
        sql: coveredSql(change.name as string, primary.name as string),
      };
    }
    return change;
  });

  // Hoist the rebuild ahead of the table's other column changes, keeping both
  // groups in their original relative order. Consumers execute `diff.changes`
  // in order, and the plan was built from the pre-batch table shape.
  const rebuildPositions = new Set(
    pending.map((change) => changes.indexOf(change)),
  );
  return [
    ...rebuilt.filter((_, index) => rebuildPositions.has(index)),
    ...rebuilt.filter((_, index) => !rebuildPositions.has(index)),
  ];
}

/**
 * Read everything the rebuild needs from the live database.
 *
 * Every query is SQLite-only (`sqlite_master`, `PRAGMA`), and the caller only
 * reaches this for an engine already detected as SQLite.
 */
async function readSqliteRebuildContext(
  db: DatabaseInterface,
  tableName: string,
): Promise<SqliteRebuildContext> {
  const tableRows = await db.query(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
    tableName,
  );
  const createTableSql = readString(
    (tableRows.rows[0] as { sql?: unknown } | undefined)?.sql,
  );

  const columnRows = await db.query(
    `PRAGMA table_info(${quoteIdentifier(tableName)})`,
  );
  const columns = columnRows.rows
    .map((row) => readString((row as { name?: unknown }).name))
    .filter((name): name is string => Boolean(name));

  // `sql IS NULL` marks the implicit indexes SQLite creates for inline
  // PRIMARY KEY / UNIQUE constraints; those are carried by the CREATE TABLE
  // text and must not be replayed separately.
  const objectRows = await db.query(
    `SELECT name, sql FROM sqlite_master
      WHERE tbl_name = ? AND sql IS NOT NULL
        AND type IN ('index', 'trigger') AND name NOT LIKE 'sqlite_%'`,
    tableName,
  );
  const objects: { name: string; sql: string }[] = [];
  for (const row of objectRows.rows as { name?: unknown; sql?: unknown }[]) {
    const name = readString(row.name);
    const sql = readString(row.sql);
    if (name && sql) {
      objects.push({ name, sql });
    }
  }

  const foreignKeysEnabled = readPragmaFlag(
    await db.query('PRAGMA foreign_keys'),
  );
  const legacyAlterTable = readPragmaFlag(
    await db.query('PRAGMA legacy_alter_table'),
  );

  const inboundReferences = foreignKeysEnabled
    ? await readInboundForeignKeys(db, tableName)
    : [];

  return {
    createTableSql,
    columns,
    objects,
    foreignKeysEnabled,
    legacyAlterTable,
    inboundReferences,
  };
}

/**
 * Names of tables that declare a foreign key onto `tableName`.
 *
 * The table itself counts. A self-reference is copied verbatim into the
 * staging table, which therefore becomes a real child of the live table, and
 * `DROP TABLE` then cascades the *staged* rows away — verified: a two-row
 * self-referencing table finishes the rebuild holding one row.
 */
async function readInboundForeignKeys(
  db: DatabaseInterface,
  tableName: string,
): Promise<string[]> {
  const tables = await db.query(
    `SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  );

  const referencing: string[] = [];
  const target = tableName.toLowerCase();
  for (const row of tables.rows as { name?: unknown }[]) {
    const name = readString(row.name);
    if (!name) continue;
    const fks = await db.query(
      `PRAGMA foreign_key_list(${quoteIdentifier(name)})`,
    );
    const referencesTarget = (fks.rows as { table?: unknown }[]).some(
      (fk) => readString(fk.table).toLowerCase() === target,
    );
    if (referencesTarget) {
      referencing.push(name);
    }
  }

  return referencing;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Read a single-row/single-column PRAGMA result as a boolean. */
function readPragmaFlag(result: { rows: Record<string, unknown>[] }): boolean {
  const row = result.rows[0];
  if (!row) return false;
  const value = Object.values(row)[0];
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value !== '0' && value !== '';
  return false;
}

export interface BuildSqliteRebuildStatementsInput {
  tableName: string;
  /** The live `sqlite_master.sql` CREATE TABLE text. */
  createTableSql: string;
  /** Column name → target SQLite type, for the columns being retyped. */
  columnTypes: Map<string, string>;
  /** Every column of the live table, in `PRAGMA table_info` order. */
  columns: string[];
  /** Indexes and triggers to replay after the swap. */
  objects: { name: string; sql: string }[];
  /** Current `PRAGMA legacy_alter_table` value, restored after the rename. */
  legacyAlterTable: boolean;
}

/**
 * Build the ordered statement list for one table rebuild.
 *
 * Returns `null` when the live `CREATE TABLE` text cannot be rewritten (an
 * unparsable statement, or a requested column that is not in it) — the caller
 * then leaves the change as manual drift rather than emitting SQL that would
 * "succeed" without fixing the column, which would re-diff forever.
 *
 * `PRAGMA legacy_alter_table` brackets the rename because SQLite ≥ 3.25
 * re-parses the whole schema on `ALTER TABLE ... RENAME`: a view left
 * referencing the just-dropped table makes the rename fail outright
 * ("error in view … no such table"). Legacy mode renames the table without
 * that reference rewriting, which is exactly what a rebuild wants — the name
 * the views refer to is about to exist again. It is restored to its previous
 * value immediately afterwards; a rolled-back batch leaves it set, which is
 * inert for SMRT (nothing else in the toolchain renames a table) but is
 * documented in `packages/core/agents/schema-paths.md`.
 */
export function buildSqliteRebuildStatements(
  input: BuildSqliteRebuildStatementsInput,
): SqliteTableRebuildPlan | null {
  const {
    tableName,
    createTableSql,
    columnTypes,
    columns,
    objects,
    legacyAlterTable,
  } = input;

  const stagingTable = `${SQLITE_REBUILD_TABLE_PREFIX}${tableName}`;
  const createStaging = rewriteSqliteCreateTable(createTableSql, {
    tableName: stagingTable,
    columnTypes,
  });
  if (!createStaging) {
    return null;
  }

  const quotedTable = quoteIdentifier(tableName);
  const quotedStaging = quoteIdentifier(stagingTable);
  const columnList = columns.map((name) => quoteIdentifier(name)).join(', ');

  const statements = [
    // Deferred FK enforcement survives the window where the table is absent.
    // Unlike `PRAGMA foreign_keys`, this one is honored inside a transaction
    // and resets itself at COMMIT/ROLLBACK.
    'PRAGMA defer_foreign_keys = ON',
    // Idempotent for a retry after a partially applied non-transactional run.
    `DROP TABLE IF EXISTS ${quotedStaging}`,
    createStaging,
    `INSERT INTO ${quotedStaging} (${columnList}) SELECT ${columnList} FROM ${quotedTable}`,
    `DROP TABLE ${quotedTable}`,
    'PRAGMA legacy_alter_table = ON',
    `ALTER TABLE ${quotedStaging} RENAME TO ${quotedTable}`,
    `PRAGMA legacy_alter_table = ${legacyAlterTable ? 'ON' : 'OFF'}`,
    // The indexes and triggers went down with the dropped table. Their
    // original text still names the table correctly (it was renamed back), so
    // replaying it verbatim preserves partial predicates, expression indexes,
    // and trigger bodies that a manifest-driven regeneration would flatten.
    ...objects.map((object) => object.sql),
  ];

  return {
    statements,
    copiedColumns: [...columns],
    recreatedObjects: objects.map((object) => object.name),
  };
}

/**
 * Rewrite a live `CREATE TABLE` statement into the rebuild's target shape:
 * the same body under a new table name, with the declared type of each column
 * in `columnTypes` replaced.
 *
 * Everything else is preserved verbatim — other columns, their defaults,
 * `NOT NULL`/`PRIMARY KEY`/`CHECK`/`COLLATE` clauses, table-level
 * constraints, and trailing table options (`WITHOUT ROWID`, `STRICT`).
 *
 * Returns `null` if the statement cannot be parsed or if any requested column
 * is not present in it.
 */
export function rewriteSqliteCreateTable(
  createTableSql: string,
  target: { tableName: string; columnTypes: Map<string, string> },
): string | null {
  const parsed = parseCreateTableBody(createTableSql);
  if (!parsed) {
    return null;
  }

  const wanted = new Map<string, string>();
  for (const [name, type] of target.columnTypes) {
    wanted.set(name.toLowerCase(), type);
  }

  const rewritten: string[] = [];
  for (const item of parsed.items) {
    const columnName = readColumnDefinitionName(item);
    const newType = columnName ? wanted.get(columnName.toLowerCase()) : null;
    if (!columnName || !newType) {
      rewritten.push(item);
      continue;
    }
    const replaced = replaceColumnType(item, newType);
    if (!replaced) {
      return null;
    }
    rewritten.push(replaced);
    wanted.delete(columnName.toLowerCase());
  }

  if (wanted.size > 0) {
    // A column the differ wants retyped is not in the live DDL. Rebuilding
    // would not fix the drift, so refuse instead of emitting a no-op plan.
    return null;
  }

  const tail = parsed.tail ? ` ${parsed.tail}` : '';
  return `CREATE TABLE ${quoteIdentifier(target.tableName)} (\n  ${rewritten.join(
    ',\n  ',
  )}\n)${tail}`;
}

interface ParsedCreateTable {
  /** Top-level, comma-separated column and constraint definitions. */
  items: string[];
  /** Table options after the closing paren (`WITHOUT ROWID`, `STRICT`). */
  tail: string;
}

/**
 * Split a `CREATE TABLE` statement into its top-level definition items plus
 * any trailing table options, honoring SQLite's quoting (`'…'`, `"…"`,
 * `` `…` ``, `[…]`) and comments so a quoted comma or paren cannot split the
 * body.
 *
 * @internal exported for testing
 */
export function parseCreateTableBody(sql: string): ParsedCreateTable | null {
  let index = 0;
  let open = -1;
  while (index < sql.length) {
    const skipped = skipQuotedOrComment(sql, index);
    if (skipped !== null) {
      index = skipped;
      continue;
    }
    if (sql[index] === '(') {
      open = index;
      break;
    }
    index++;
  }
  if (open === -1) {
    return null;
  }

  const items: string[] = [];
  let depth = 1;
  let itemStart = open + 1;
  let close = -1;
  index = open + 1;
  while (index < sql.length) {
    const skipped = skipQuotedOrComment(sql, index);
    if (skipped !== null) {
      index = skipped;
      continue;
    }
    const char = sql[index];
    if (char === '(') {
      depth++;
    } else if (char === ')') {
      depth--;
      if (depth === 0) {
        close = index;
        items.push(sql.slice(itemStart, index));
        break;
      }
    } else if (char === ',' && depth === 1) {
      items.push(sql.slice(itemStart, index));
      itemStart = index + 1;
    }
    index++;
  }

  if (close === -1) {
    return null;
  }

  const trimmed = items.map((item) => item.trim()).filter(Boolean);
  if (trimmed.length === 0) {
    return null;
  }

  return {
    items: trimmed,
    tail: sql
      .slice(close + 1)
      .trim()
      .replace(/;+$/, '')
      .trim(),
  };
}

/**
 * If `sql[index]` opens a quoted identifier, string literal, or comment,
 * return the index just past its end. Otherwise return `null`.
 */
function skipQuotedOrComment(sql: string, index: number): number | null {
  const char = sql[index];

  if (char === "'" || char === '"' || char === '`') {
    let cursor = index + 1;
    while (cursor < sql.length) {
      if (sql[cursor] === char) {
        // A doubled delimiter is an escaped one, not the end of the token.
        if (sql[cursor + 1] === char) {
          cursor += 2;
          continue;
        }
        return cursor + 1;
      }
      cursor++;
    }
    return sql.length;
  }

  if (char === '[') {
    const end = sql.indexOf(']', index + 1);
    return end === -1 ? sql.length : end + 1;
  }

  if (char === '-' && sql[index + 1] === '-') {
    const end = sql.indexOf('\n', index);
    return end === -1 ? sql.length : end + 1;
  }

  if (char === '/' && sql[index + 1] === '*') {
    const end = sql.indexOf('*/', index + 2);
    return end === -1 ? sql.length : end + 2;
  }

  return null;
}

/**
 * Keywords that start a *table*-level constraint, i.e. a body item that is not
 * a column definition.
 */
const TABLE_CONSTRAINT_KEYWORDS = new Set([
  'constraint',
  'primary',
  'unique',
  'check',
  'foreign',
]);

/**
 * Keywords that end a column's type name and start its constraint list.
 */
const COLUMN_CONSTRAINT_KEYWORDS = new Set([
  'constraint',
  'primary',
  'not',
  'null',
  'unique',
  'check',
  'default',
  'collate',
  'references',
  'generated',
  'as',
]);

interface Identifier {
  name: string;
  end: number;
}

/** Read the leading identifier of a body item (quoted or bare). */
function readLeadingIdentifier(item: string): Identifier | null {
  let index = 0;
  while (index < item.length && /\s/.test(item[index])) index++;
  if (index >= item.length) return null;

  const char = item[index];
  if (char === '"' || char === '`' || char === '[') {
    const end = skipQuotedOrComment(item, index);
    if (end === null) return null;
    const raw = item.slice(index + 1, end - 1);
    // `[…]` has no escape form; `"…"` / `` `…` `` double the delimiter.
    return {
      name: char === '[' ? raw : raw.split(char + char).join(char),
      end,
    };
  }

  const match = /^[A-Za-z_][\w$]*/.exec(item.slice(index));
  if (!match) return null;
  return { name: match[0], end: index + match[0].length };
}

/**
 * The column name of a body item, or `null` when the item is a table-level
 * constraint rather than a column definition.
 *
 * @internal exported for testing
 */
export function readColumnDefinitionName(item: string): string | null {
  const identifier = readLeadingIdentifier(item);
  if (!identifier) return null;

  const isQuoted = /^\s*["`[]/.test(item);
  if (
    !isQuoted &&
    TABLE_CONSTRAINT_KEYWORDS.has(identifier.name.toLowerCase())
  ) {
    return null;
  }
  return identifier.name;
}

/**
 * Replace the declared type of a column definition, keeping its name and every
 * constraint that follows. A column declared without a type gets one inserted.
 *
 * @internal exported for testing
 */
export function replaceColumnType(
  item: string,
  newType: string,
): string | null {
  const identifier = readLeadingIdentifier(item);
  if (!identifier) return null;

  const head = item.slice(0, identifier.end);
  let index = identifier.end;

  // The type name is one or more bare words followed by an optional
  // `(size[, size])` — everything before the first column-constraint keyword.
  let typeEnd = index;
  while (index < item.length) {
    while (index < item.length && /\s/.test(item[index])) index++;
    const match = /^[A-Za-z_][\w$]*/.exec(item.slice(index));
    if (!match || COLUMN_CONSTRAINT_KEYWORDS.has(match[0].toLowerCase())) {
      break;
    }
    index += match[0].length;
    typeEnd = index;
  }

  // Optional parenthesized type argument, e.g. VARCHAR(255).
  if (typeEnd > identifier.end) {
    let cursor = typeEnd;
    while (cursor < item.length && /\s/.test(item[cursor])) cursor++;
    if (item[cursor] === '(') {
      let depth = 0;
      while (cursor < item.length) {
        const skipped = skipQuotedOrComment(item, cursor);
        if (skipped !== null) {
          cursor = skipped;
          continue;
        }
        if (item[cursor] === '(') depth++;
        else if (item[cursor] === ')') {
          depth--;
          if (depth === 0) {
            typeEnd = cursor + 1;
            break;
          }
        }
        cursor++;
      }
    }
  }

  const rest = item.slice(typeEnd);
  const separator = rest.length === 0 || /^\s/.test(rest) ? '' : ' ';
  return `${head} ${newType}${separator}${rest}`;
}
