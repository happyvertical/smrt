/**
 * DuckDB table changes that `ALTER TABLE` cannot make (#4937).
 *
 * DuckDB refuses an `ALTER` in three situations that PostgreSQL accepts:
 *
 * - the table has an index: the index would have to be dropped around the
 *   `ALTER`, and in a database file it cannot be created again in the same
 *   transaction ("already exists");
 * - another table has a foreign key onto it: nothing on it can be altered;
 * - the same transaction already ran an `UPDATE`: "outstanding updates".
 *
 * It also has no `ADD CONSTRAINT`, so a foreign key can only be added or
 * removed by building the table again.
 *
 * This module is the post-pass over one table's changes. When the table has
 * no index, nothing references it and every change works with `ALTER`, the
 * changes stand as generated. Otherwise it folds the table's changes into one rebuild
 * that runs in the migration's transaction: copy the table and every table that
 * references it into staging tables, drop them, create them again from their
 * live definitions (the target with its changes), copy the rows back and
 * replay the indexes. The transaction makes it atomic: a failure anywhere rolls
 * the tables back to their original shape and rows.
 *
 * The rebuild is refused, and the changes stay stops, when a table of the group
 * references itself or two of them reference each other: DuckDB cannot copy
 * rows into a table whose foreign key points at itself in one statement. It is
 * refused too when a table the migration creates references a table of the
 * group: that table is created first, and DuckDB then refuses to drop it.
 *
 * Rebuilds whose groups share a table are combined into one plan by
 * {@link combineDuckDbRebuilds}, so a rebuild never creates a table again from a
 * definition another change of the same migration has replaced. Every rebuild
 * ends by checking each table of its group against the plan (columns, indexes,
 * foreign keys, row count, and the values of every stored column) and fails
 * the transaction when they differ.
 *
 * A column type change (`type_upgrade`) always takes the rebuild (P5a): one
 * route, one set of guards. Its plan never touches a view (`view-guard.ts`):
 * it is refused while a view does not bind or a dependency-tracked view
 * depends on the group, starts with a guard on the target database, schema,
 * views and source column types, and ends with a bind probe per view.
 *
 * Every table, staging table, index and probe is named `"db"."schema"."name"`
 * from planning, and the guard pins the current database and schema, so a
 * temporary object of the same name or another current schema cannot redirect
 * a statement. The copy lists stored columns only: generated columns are
 * classified by the live definition text and by DuckDB's binder, and the plan
 * is refused when the two disagree. Table, column and index comments are
 * written again after the indexes.
 */
import {
  quoteIdentifier,
  quoteStringLiteral,
} from '../schema/sql-identifiers.js';
import type { SchemaChange, SQLDataType } from '../schema/types.js';
import {
  rebuildPlanStaleMessage,
  TableChangedSincePlanError,
} from './rebuild-plan-guard.js';
import {
  parseCreateTableBody,
  readColumnDefinitionName,
  rewriteSqliteCreateTable,
  type SqliteRebuildPlanResult,
} from './sqlite-rebuild.js';
import type { DatabaseInterface } from './types.js';
import {
  errorMessages,
  listViews,
  parseViewProbe,
  type QualifiedView,
  qualifiedViewName,
  REBUILD_PLAN_VIEWS_STALE_MARKER,
  unboundViews,
  ViewsChangedSincePlanError,
  viewProbeStatement,
} from './view-guard.js';

/** Prefix of the staging tables a rebuild creates inside its transaction. */
export const DUCKDB_REBUILD_TABLE_PREFIX = '_smrt_rebuild_';

export interface PlanDuckDbTableChangesOptions {
  db: DatabaseInterface;
  tableName: string;
  /** The table's column changes. */
  changes: SchemaChange[];
  /** The table's foreign-key changes. */
  constraintChanges?: SchemaChange[];
  mapType: (type: SQLDataType) => string;
  /** The SQL literal of the default a change declares. */
  formatDefault?: (change: SchemaChange) => string | undefined;
  /** The table-level constraint text for an added foreign key. */
  foreignKeyDefinition?: (change: SchemaChange) => string | undefined;
  /** The full column definition for a column the rebuild adds. */
  addedColumnDefinition?: (change: SchemaChange) => string;
  /** Statements to run after the rebuild for a column it adds. */
  addedColumnFollowUps?: (change: SchemaChange) => string[];
  /**
   * Refuse the rebuild with this reason. The differ sets it when this table's
   * rebuild overlaps another one and the two cannot be combined into one plan.
   */
  blockRebuild?: string;
  /**
   * Foreign keys of the tables this migration creates: a new table is created
   * before the changes run, and DuckDB then refuses to alter or drop the table
   * it references.
   */
  plannedReferences?: Edge[];
  /**
   * Also check the connection's temporary views. Set when the plan runs on the
   * connection that planned it (the system compatibility pass); another
   * connection's temporary views are not visible.
   */
  includeTemporaryViews?: boolean;
}

/** A live table as the rebuild reads it. */
export interface TableInfo {
  name: string;
  createSql: string;
  /** Every column, generated ones included, in catalog order. */
  columns: string[];
  indexes: Array<{ name: string; sql: string; columns: string[] }>;
  /**
   * `duckdb_tables().sql` and each `duckdb_indexes().sql` exactly as the
   * catalog gave them when the table was read. The rebuild compares the live
   * catalog with these before it touches the table ({@link planGuardStatements}).
   */
  catalog?: {
    tableSql: string;
    indexSql: string[];
    /** The table's comments as {@link COMMENTS_FINGERPRINT} rendered them. */
    comments?: string;
  };
  /** The catalog (database) and schema the table was read in. */
  database?: string;
  schema?: string;
  /** `duckdb_columns().data_type` per column. */
  types?: Record<string, string>;
  /** Table, column and index comments, replayed after a rebuild. */
  comments?: {
    table: string | null;
    columns: Array<[string, string]>;
    indexes: Array<[string, string]>;
  };
  /** Stored (not generated) columns, set once classified ({@link classifyColumns}). */
  stored?: string[];
  /** Generated columns, set once classified. */
  generated?: string[];
}

/**
 * @internal Test seams for the generated-column classifier (P5a). Never set
 * outside tests.
 */
export const duckDbRebuildTestHooks: {
  /** Override the text scan's answer for one column. */
  textScanGenerated?: (
    table: string,
    column: string,
    scanned: boolean,
  ) => boolean;
  /** Override the stored-column list a table is copied with. */
  storedColumns?: (table: string, stored: string[]) => string[];
} = {};

const statementsOf = (change: SchemaChange): string[] =>
  change.sqlStatements ?? (change.sql ? [change.sql] : []);
const hasUpdate = (change: SchemaChange): boolean =>
  statementsOf(change).some((sql) => /^\s*UPDATE\b/i.test(sql));
const alters = (change: SchemaChange): boolean =>
  statementsOf(change).some((sql) => /\bALTER\s+COLUMN\b/i.test(sql));
const unquote = (name: string): string =>
  name.replace(/^"(.*)"$/, '$1').replace(/""/g, '"');

/** The reason a new table blocks altering or rebuilding these tables, if one does. */
function plannedReferenceBlock(
  tables: string[],
  planned: Edge[],
): string | undefined {
  const edge = planned.find((item) => tables.includes(item.parent));
  return edge
    ? `the new table "${edge.child}" this migration creates references "${edge.parent}", and DuckDB cannot alter or rebuild a table that another table references`
    : undefined;
}

function blockedSql(name: string, reason: string): string {
  // One line: a reason can quote a database message, and every line of the
  // refusal must stay inside the comment.
  return `-- DuckDB: ${quoteIdentifier(name)} requires a table rebuild, blocked: ${reason}`.replace(
    /\s+/g,
    ' ',
  );
}

/** `"db"."schema"."name"` for an object of the table's schema. */
function qualified(info: TableInfo, name: string): string {
  return info.database !== undefined && info.schema !== undefined
    ? `${quoteIdentifier(info.database)}.${quoteIdentifier(info.schema)}.${quoteIdentifier(name)}`
    : quoteIdentifier(name);
}

/**
 * The table's table, column and index comments as one text, rendered by the
 * same expression at planning and in the plan guard.
 */
const COMMENTS_FINGERPRINT = (where: string) =>
  `CAST(struct_pack(t := (SELECT comment FROM duckdb_tables() WHERE ${where}), c := (SELECT list(struct_pack(n := column_name, m := comment) ORDER BY column_index) FROM duckdb_columns() WHERE ${where}), i := (SELECT list(struct_pack(n := index_name, m := comment) ORDER BY index_name) FROM duckdb_indexes() WHERE ${where} AND sql IS NOT NULL)) AS VARCHAR)`;

async function readTable(
  db: DatabaseInterface,
  name: string,
): Promise<TableInfo | undefined> {
  const where =
    'database_name = current_database() AND schema_name = current_schema() AND table_name = ?';
  const table = await db.query(
    `SELECT sql, comment, database_name, schema_name FROM duckdb_tables() WHERE ${where}`,
    name,
  );
  const tableRow = table.rows[0] as
    | {
        sql?: unknown;
        comment?: unknown;
        database_name?: unknown;
        schema_name?: unknown;
      }
    | undefined;
  const createSql = String(tableRow?.sql ?? '');
  if (!createSql) return undefined;
  const columnRows = (
    await db.query(
      `SELECT column_name, data_type, comment FROM duckdb_columns() WHERE ${where} ORDER BY column_index`,
      name,
    )
  ).rows as Array<{
    column_name?: unknown;
    data_type?: unknown;
    comment?: unknown;
  }>;
  const columns = columnRows.map((row) => String(row.column_name));
  const indexRows = (
    await db.query(
      `SELECT index_name, sql, comment FROM duckdb_indexes() WHERE ${where} AND sql IS NOT NULL`,
      name,
    )
  ).rows;
  const indexes = indexRows.flatMap((row) => {
    const { index_name: indexName, sql } = row as {
      index_name?: unknown;
      sql?: unknown;
    };
    if (typeof indexName !== 'string' || typeof sql !== 'string') return [];
    const text = sql.replace(/;\s*$/, '');
    const open = text.indexOf('(');
    const list = open === -1 ? '' : text.slice(open + 1, text.lastIndexOf(')'));
    return [
      {
        name: indexName,
        sql: text,
        columns: list.split(',').map((part) => unquote(part.trim())),
      },
    ];
  });
  const comments = await db.query(
    `SELECT ${COMMENTS_FINGERPRINT(where.replace('table_name = ?', 'table_name = $1'))} AS comments`,
    name,
  );
  const text = (value: unknown) =>
    typeof value === 'string' && value.length > 0 ? value : null;
  return {
    name,
    createSql: createSql.replace(/;\s*$/, ''),
    columns,
    indexes,
    catalog: {
      tableSql: createSql,
      indexSql: indexRows.flatMap((row) => {
        const sql = (row as { sql?: unknown }).sql;
        return typeof sql === 'string' ? [sql] : [];
      }),
      comments: String((comments.rows[0] as { comments?: unknown })?.comments),
    },
    database: String(tableRow?.database_name),
    schema: String(tableRow?.schema_name),
    types: Object.fromEntries(
      columnRows.map((row) => [String(row.column_name), String(row.data_type)]),
    ),
    comments: {
      table: text(tableRow?.comment),
      columns: columnRows.flatMap((row) => {
        const comment = text(row.comment);
        return comment === null ? [] : [[String(row.column_name), comment]];
      }) as Array<[string, string]>,
      indexes: indexRows.flatMap((row) => {
        const { index_name: indexName, comment } = row as {
          index_name?: unknown;
          comment?: unknown;
        };
        const value = text(comment);
        return value === null || typeof indexName !== 'string'
          ? []
          : [[indexName, value]];
      }) as Array<[string, string]>,
    },
  };
}

/** Whether a column definition item is generated, read outside literals and quoted names. */
function isGeneratedDefinition(item: string): boolean {
  let bare = '';
  for (let index = 0; index < item.length; ) {
    const char = item[index];
    if (char === "'" || char === '"') {
      let cursor = index + 1;
      while (cursor < item.length) {
        if (item[cursor] === char) {
          if (item[cursor + 1] === char) {
            cursor += 2;
            continue;
          }
          break;
        }
        cursor++;
      }
      bare += ' ';
      index = cursor + 1;
      continue;
    }
    bare += char;
    index++;
  }
  return /\bGENERATED\s+ALWAYS\s+AS\b/i.test(bare);
}

/**
 * Classify every column of a table as stored or generated, twice: by its
 * definition in the live `CREATE TABLE` text and by DuckDB's binder (an
 * `EXPLAIN INSERT` into the column, which only a generated column refuses).
 * Returns the reason when the two disagree or a column does not map to exactly
 * one definition; otherwise sets `stored` and `generated` on `info`.
 */
async function classifyColumns(
  db: DatabaseInterface,
  info: TableInfo,
): Promise<string | undefined> {
  const definitions = new Map<string, string[]>();
  for (const item of parseCreateTableBody(info.createSql)?.items ?? []) {
    const name = readColumnDefinitionName(item);
    if (!name) continue;
    const key = name.toLowerCase();
    definitions.set(key, [...(definitions.get(key) ?? []), item]);
  }
  const stored: string[] = [];
  const generated: string[] = [];
  const table = qualified(info, info.name);
  for (const column of info.columns) {
    const items = definitions.get(column.toLowerCase()) ?? [];
    if (items.length !== 1)
      return `column "${column}" of table "${info.name}" does not map to exactly one definition in its CREATE TABLE statement`;
    const scanned = isGeneratedDefinition(items[0]);
    const text =
      duckDbRebuildTestHooks.textScanGenerated?.(info.name, column, scanned) ??
      scanned;
    const quoted = quoteIdentifier(column);
    let binder: boolean | undefined;
    try {
      await db.query(
        `EXPLAIN INSERT INTO ${table} (${quoted}) SELECT ${quoted} FROM ${table} LIMIT 0`,
      );
      binder = false;
    } catch (error) {
      binder = errorMessages(error).some((message) =>
        /Cannot insert into a generated column/i.test(message),
      )
        ? true
        : undefined;
    }
    if (binder === undefined || binder !== text)
      return `column "${column}" of table "${info.name}" cannot be classified as stored or generated (its definition and DuckDB disagree)`;
    (text ? generated : stored).push(column);
  }
  info.stored = stored;
  info.generated = generated;
  return undefined;
}

/** The stored columns a table is copied with. */
const copyColumns = (info: TableInfo): string[] => {
  const stored = info.stored ?? info.columns;
  return duckDbRebuildTestHooks.storedColumns?.(info.name, stored) ?? stored;
};

/**
 * Catalog entries that depend on a table of the group and are not tables of
 * the group (views created with `enable_view_dependencies`): DuckDB refuses
 * to drop the table while they exist.
 */
async function readDependents(
  db: DatabaseInterface,
  tables: TableInfo[],
): Promise<string[]> {
  const names = tables.map((info) => quoteStringLiteral(info.name)).join(', ');
  const scope =
    'database_name = current_database() AND schema_name = current_schema()';
  const { rows } = await db.query(
    `SELECT DISTINCT v.database_name, v.schema_name, v.view_name, CAST(d.refobjid AS VARCHAR) AS oid
       FROM duckdb_dependencies() d
       JOIN duckdb_tables() t ON t.table_oid = d.objid
       LEFT JOIN duckdb_views() v ON v.view_oid = d.refobjid
      WHERE t.${scope.replace(' AND ', ' AND t.')} AND t.table_name IN (${names})
        AND d.deptype <> 'a'
        AND d.refobjid NOT IN (SELECT table_oid FROM duckdb_tables() WHERE ${scope} AND table_name IN (${names}))
      ORDER BY 1, 2, 3, 4`,
  );
  return rows.map((row) =>
    typeof row.view_name === 'string'
      ? qualifiedViewName({
          database: String(row.database_name),
          schema: String(row.schema_name),
          name: row.view_name,
        })
      : `catalog entry ${String(row.oid)}`,
  );
}

/** The views a column type change is checked against, as of planning. */
export interface DuckDbViewSnapshot {
  database: string;
  schema: string;
  /** Whether the connection's temporary views are included. */
  temporary: boolean;
  /** {@link viewFingerprintSql} as of planning. */
  fingerprint: string;
  views: QualifiedView[];
}

/**
 * Every view of the current database (and the temporary ones, when asked) as
 * one text: catalog, schema, name, temporary flag and SQL. The same
 * expression runs at planning and in the plan guard.
 */
const viewFingerprintSql = (temporary: boolean) =>
  `(SELECT coalesce(md5(CAST(list(struct_pack(d := database_name, s := schema_name, v := view_name, t := temporary, q := sql) ORDER BY database_name, schema_name, view_name) AS VARCHAR)), 'none') FROM duckdb_views() WHERE NOT internal AND (database_name = current_database()${temporary ? " OR database_name = 'temp'" : ''}))`;

async function readViewSnapshot(
  db: DatabaseInterface,
  temporary: boolean,
): Promise<DuckDbViewSnapshot> {
  const { rows } = await db.query(
    `SELECT current_database() AS database_name, current_schema() AS schema_name, ${viewFingerprintSql(temporary)} AS fingerprint`,
  );
  const row = rows[0] as Record<string, unknown>;
  return {
    database: String(row.database_name),
    schema: String(row.schema_name),
    temporary,
    fingerprint: String(row.fingerprint),
    views: await listViews(db, { includeTemporary: temporary }),
  };
}

/** One live foreign key: the child table, its key columns, the parent table. */
export interface DuckDbReference {
  child: string;
  parent: string;
  /** The child's key columns, comma-separated, as the catalog lists them. */
  columns: string;
}

/** Every foreign key in the schema: child table to the parent it references. */
async function readReferences(
  db: DatabaseInterface,
): Promise<DuckDbReference[]> {
  const { rows } = await db.query(
    `SELECT table_name, referenced_table,
            array_to_string(constraint_column_names, ',') AS key_columns
     FROM duckdb_constraints()
     WHERE database_name = current_database() AND schema_name = current_schema()
       AND constraint_type = 'FOREIGN KEY'`,
  );
  return rows.flatMap((row) => {
    const {
      table_name: child,
      referenced_table: parent,
      key_columns: columns,
    } = row as {
      table_name?: unknown;
      referenced_table?: unknown;
      key_columns?: unknown;
    };
    return typeof child === 'string' && typeof parent === 'string'
      ? [{ child, parent, columns: typeof columns === 'string' ? columns : '' }]
      : [];
  });
}

/** A foreign key between two tables, child to parent. */
export type Edge = { child: string; parent: string };

/** The tables and every table that references one of them, directly or not. */
function closeOverReferencing(start: string[], edges: Edge[]): string[] {
  const group = [...start];
  for (let index = 0; index < group.length; index++) {
    for (const edge of edges) {
      if (edge.parent === group[index] && !group.includes(edge.child))
        group.push(edge.child);
    }
  }
  return group;
}

/** The tables ordered parents first, or `undefined` when the edges form a cycle. */
function parentsFirst(tables: string[], edges: Edge[]): string[] | undefined {
  const inGroup = edges.filter(
    (edge) => tables.includes(edge.child) && tables.includes(edge.parent),
  );
  if (inGroup.some((edge) => edge.child === edge.parent)) return undefined;
  const order: string[] = [];
  const remaining = [...tables];
  while (remaining.length > 0) {
    const next = remaining.find(
      (name) =>
        !inGroup.some(
          (edge) => edge.child === name && remaining.includes(edge.parent),
        ),
    );
    if (!next) return undefined;
    order.push(next);
    remaining.splice(remaining.indexOf(next), 1);
  }
  return order;
}

/** The table and every table that references it, directly or not, parents first. */
function referencingGroup(
  tableName: string,
  references: Edge[],
): { order: string[]; cyclic: boolean } {
  const group = closeOverReferencing([tableName], references);
  const order = parentsFirst(group, references);
  return order ? { order, cyclic: false } : { order: group, cyclic: true };
}

/**
 * What one table's rebuild makes of it: its final definition and how each of
 * its final columns is filled from the copy of its pre-migration rows.
 */
export interface DuckDbTableRebuild {
  table: string;
  /** `CREATE TABLE` in the table's final shape. */
  createSql: string;
  /** The final columns, in order. */
  columns: string[];
  /** One expression per final column, read from the copy of the old rows. */
  sources: string[];
  /** `CREATE INDEX` statements replayed after the copy. */
  indexes: string[];
  /** Statements that run after the copy, such as a new column's unique index. */
  followUps: string[];
  /** Key columns whose foreign key the rebuild removes. */
  removedKeyColumns: string[];
  /** Foreign keys the rebuild adds. */
  addedKeys: Array<{ column: string; parent: string }>;
  /**
   * Every final column, generated ones included (`columns` lists the stored
   * columns the copy fills). Defaults to `columns`.
   */
  allColumns?: string[];
  /**
   * The stored columns whose values the content check compares, each with
   * the expression over the old rows it must equal and its final type.
   */
  content?: Array<{ column: string; source: string; type: string }>;
  /** Columns whose type the rebuild changes, with their type at planning. */
  upgraded?: Array<{ column: string; from: string }>;
  /** The views checked around a column type change, as of planning. */
  views?: DuckDbViewSnapshot;
}

/**
 * A planned DuckDB rebuild, kept so the differ can combine rebuilds whose
 * groups overlap into one plan (#4937).
 */
export interface DuckDbRebuildPlan {
  rebuild: DuckDbTableRebuild;
  /** The live definition of every table in its group. */
  tables: TableInfo[];
  /** Every live foreign key in the schema. */
  references: DuckDbReference[];
  /** The change that carries the rebuild's statements. */
  carrier: SchemaChange;
}

export interface DuckDbPlanResult extends SqliteRebuildPlanResult {
  /** Present when the table is rebuilt. */
  rebuild?: DuckDbRebuildPlan;
}

/** The temporary table the rebuild check writes its findings to. */
const CHECK_TABLE = quoteIdentifier('_smrt_check_rebuild');
/** The temporary table the plan guard writes its findings to. */
const PLAN_GUARD_TABLE = quoteIdentifier('_smrt_rebuild_plan_guard');
const INDEX_NAME =
  /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?("(?:[^"]|"")+"|[^\s(]+)\s+ON\s+("(?:[^"]|"")+"|[^\s(]+)/i;
const readIndexName = (
  sql: string,
): { name: string; table: string } | undefined => {
  const match = INDEX_NAME.exec(sql);
  return match
    ? { name: unquote(match[1]), table: unquote(match[2]) }
    : undefined;
};
const literalList = (values: string[]) =>
  `[${values.map((value) => quoteStringLiteral(value)).join(', ')}]::VARCHAR[]`;

/**
 * Statements that compare what a rebuild built with what its plan meant to
 * build, for every table of the group, and roll the transaction back with the
 * differences when they disagree: the columns, the indexes, the foreign keys
 * and the row count of each table.
 *
 * The findings are written to a temporary table first and raised by a second
 * statement that holds no string literal, so the SQL adapter's redaction of
 * literals does not blank the message.
 */
function checkStatements(
  expected: Array<{
    table: string;
    /** `"db"."schema"."table"` and its staging copy. */
    target: string;
    staging: string;
    columns: string[];
    indexes: string[];
    keys: string[];
    content: Array<{ column: string; source: string; type: string }>;
  }>,
): string[] {
  const where = (table: string) =>
    `database_name = current_database() AND schema_name = current_schema() AND table_name = ${quoteStringLiteral(table)}`;
  const problems: string[] = [];
  const problem = (
    table: string,
    what: string,
    built: string,
    planned: string,
  ) =>
    `SELECT CASE WHEN ${built} IS DISTINCT FROM ${planned} THEN ${quoteStringLiteral(
      `table rebuild check failed: ${quoteIdentifier(table)} has ${what} `,
    )} || CAST(${built} AS VARCHAR) || ${quoteStringLiteral(', the plan built ')} || CAST(${planned} AS VARCHAR) END AS problem`;
  for (const item of expected) {
    problems.push(
      problem(
        item.table,
        'columns',
        `(SELECT list(column_name ORDER BY column_index) FROM duckdb_columns() WHERE ${where(item.table)})`,
        literalList(item.columns),
      ),
      problem(
        item.table,
        'indexes',
        `list_sort(coalesce((SELECT list(index_name) FROM duckdb_indexes() WHERE ${where(item.table)} AND sql IS NOT NULL), []::VARCHAR[]))`,
        `list_sort(${literalList(item.indexes)})`,
      ),
      problem(
        item.table,
        'foreign keys',
        `list_sort(coalesce((SELECT list(lower(array_to_string(constraint_column_names, ',') || '->' || referenced_table)) FROM duckdb_constraints() WHERE ${where(item.table)} AND constraint_type = 'FOREIGN KEY'), []::VARCHAR[]))`,
        `list_sort(${literalList(item.keys.map((key) => key.toLowerCase()))})`,
      ),
      problem(
        item.table,
        'a row count of',
        `(SELECT count(*) FROM ${item.target})`,
        `(SELECT count(*) FROM ${item.staging})`,
      ),
    );
    // Every stored value must be the old one (cast to the column's final
    // type): a stored column left out of the copy, or a wrong source, shows
    // here even when the names and the row count agree.
    for (const entry of item.content)
      problems.push(
        problem(
          item.table,
          `values of ${quoteIdentifier(entry.column)} with checksum`,
          `(SELECT sum(hash(${quoteIdentifier(entry.column)})) FROM ${item.target})`,
          `(SELECT sum(hash(CAST((${entry.source}) AS ${entry.type}))) FROM ${item.staging})`,
        ),
      );
  }
  return [
    `CREATE TEMP TABLE ${CHECK_TABLE} AS SELECT problem FROM (${problems.join(' UNION ALL ')}) WHERE problem IS NOT NULL`,
    `SELECT error(CAST(list(problem) AS VARCHAR)) FROM temp.${CHECK_TABLE} HAVING count(*) > 0`,
    `DROP TABLE temp.${CHECK_TABLE}`,
  ];
}

/**
 * Statements that stop a rebuild when a table of its group is no longer the
 * one it was planned from (see `rebuild-plan-guard.ts`).
 *
 * The rebuild creates every table of the group again from the definition read
 * at planning time and replays the indexes read then. A column or index
 * another connection added since is in neither and would go with the dropped
 * table. Before anything else in the transaction, the live `duckdb_tables()`
 * and `duckdb_indexes()` text of each table is compared with the planned
 * text; any difference raises and rolls the transaction back. The findings go
 * through a temporary table, as in {@link checkStatements} and for the same
 * reason.
 */
function planGuardStatements(tables: TableInfo[]): string[] {
  const where = (table: string) =>
    `database_name = current_database() AND schema_name = current_schema() AND table_name = ${quoteStringLiteral(table)}`;
  const problems: string[] = [];
  for (const info of tables) {
    if (!info.catalog) continue;
    const changed = [
      `(SELECT sql FROM duckdb_tables() WHERE ${where(info.name)}) IS DISTINCT FROM ${quoteStringLiteral(info.catalog.tableSql)}`,
      `list_sort(coalesce((SELECT list(sql) FROM duckdb_indexes() WHERE ${where(info.name)} AND sql IS NOT NULL), []::VARCHAR[])) IS DISTINCT FROM list_sort(${literalList(info.catalog.indexSql)})`,
      ...(info.catalog.comments === undefined
        ? []
        : [
            `${COMMENTS_FINGERPRINT(where(info.name))} IS DISTINCT FROM ${quoteStringLiteral(info.catalog.comments)}`,
          ]),
    ].join(' OR ');
    problems.push(
      `SELECT CASE WHEN ${changed} THEN ${quoteStringLiteral(rebuildPlanStaleMessage(info.name))} END AS problem`,
    );
  }
  if (problems.length === 0) return [];
  return [
    `CREATE TEMP TABLE ${PLAN_GUARD_TABLE} AS SELECT problem FROM (${problems.join(' UNION ALL ')}) WHERE problem IS NOT NULL`,
    `SELECT error(CAST(list(problem) AS VARCHAR)) FROM temp.${PLAN_GUARD_TABLE} HAVING count(*) > 0`,
    `DROP TABLE temp.${PLAN_GUARD_TABLE}`,
  ];
}

/** The temporary table the views guard writes its finding to. */
const VIEWS_GUARD_TABLE = quoteIdentifier('_smrt_rebuild_views_guard');

/**
 * Statements that stop a column type change when the database it was planned
 * against is not the one it runs on (P5a, E4): the current database and
 * schema (every name in the plan is qualified with them), the views of the
 * database, and the type of each column it converts. They run first, before
 * the table guard, and roll the transaction back with
 * {@link REBUILD_PLAN_VIEWS_STALE_MARKER}.
 */
function viewsGuardStatements(
  snapshot: DuckDbViewSnapshot,
  upgraded: Array<{ table: string; column: string; from: string }>,
): string[] {
  const changed = [
    `current_database() IS DISTINCT FROM ${quoteStringLiteral(snapshot.database)}`,
    `current_schema() IS DISTINCT FROM ${quoteStringLiteral(snapshot.schema)}`,
    `${viewFingerprintSql(snapshot.temporary)} IS DISTINCT FROM ${quoteStringLiteral(snapshot.fingerprint)}`,
    ...upgraded.map(
      ({ table, column, from }) =>
        `(SELECT data_type FROM duckdb_columns() WHERE database_name = ${quoteStringLiteral(snapshot.database)} AND schema_name = ${quoteStringLiteral(snapshot.schema)} AND table_name = ${quoteStringLiteral(table)} AND column_name = ${quoteStringLiteral(column)}) IS DISTINCT FROM ${quoteStringLiteral(from)}`,
    ),
  ].join(' OR ');
  return [
    `CREATE TEMP TABLE ${VIEWS_GUARD_TABLE} AS SELECT problem FROM (SELECT CASE WHEN ${changed} THEN ${quoteStringLiteral(`${REBUILD_PLAN_VIEWS_STALE_MARKER}. Nothing was changed; run the migrate again`)} END AS problem) WHERE problem IS NOT NULL`,
    `SELECT error(CAST(list(problem) AS VARCHAR)) FROM temp.${VIEWS_GUARD_TABLE} HAVING count(*) > 0`,
    `DROP TABLE temp.${VIEWS_GUARD_TABLE}`,
  ];
}

const CREATE_TABLE_NAME =
  /^(\s*CREATE\s+TABLE\s+)("(?:[^"]|"")+"|[^\s(]+)(?=\s*\()/i;
const CREATE_INDEX_TARGET =
  /^(\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"(?:[^"]|"")+"|[^\s(]+)\s+ON\s+)("(?:[^"]|"")+"|[^\s(]+)/i;

/** The statement with its table name replaced by `name`, or `undefined`. */
const qualifyStatement = (pattern: RegExp, sql: string, name: string) =>
  pattern.test(sql)
    ? sql.replace(pattern, (_all, head: string) => `${head}${name}`)
    : undefined;

/**
 * The statements of one rebuild of a group of tables: copy every table, drop
 * them, create each in its final shape (a table without changes from its live
 * definition), copy each table's rows once, replay the indexes, check the
 * result against the plan, and drop the copies.
 *
 * `tables` must hold every table that references a table of the group.
 */
function buildGroupRebuild(
  tables: TableInfo[],
  rebuilds: Map<string, DuckDbTableRebuild>,
  references: DuckDbReference[],
): { statements: string[] } | { blocked: string } {
  const names = tables.map((info) => info.name);
  const byName = new Map(tables.map((info) => [info.name, info]));
  const removed = (reference: DuckDbReference) =>
    rebuilds
      .get(reference.child)
      ?.removedKeyColumns.some(
        (column) => column.toLowerCase() === reference.columns.toLowerCase(),
      ) ?? false;
  const finalKeys = (name: string) => [
    ...references
      .filter((reference) => reference.child === name && !removed(reference))
      .map((reference) => ({
        child: name,
        parent: reference.parent,
        columns: reference.columns,
      })),
    ...(rebuilds.get(name)?.addedKeys ?? []).map((key) => ({
      child: name,
      parent: key.parent,
      columns: key.column,
    })),
  ];
  const dropOrder = parentsFirst(names, references);
  const createOrder = parentsFirst(names, names.flatMap(finalKeys));
  if (!dropOrder || !createOrder)
    return {
      blocked:
        'a table in the group references itself, or two of them reference each other, and DuckDB cannot copy rows into such tables',
    };
  for (const rebuild of rebuilds.values()) {
    if (!byName.has(rebuild.table))
      return { blocked: `table "${rebuild.table}" could not be read` };
    if (rebuild.columns.length !== rebuild.sources.length)
      return {
        blocked: `the copy of table "${rebuild.table}" could not be planned`,
      };
  }

  // Every name is qualified with the catalog and schema the tables were read
  // in; the views guard pins both for a column type change.
  const anchor = tables[0];
  const target = (name: string) => qualified(anchor, name);
  const staging = (name: string) =>
    qualified(anchor, `${DUCKDB_REBUILD_TABLE_PREFIX}${name}`);
  const qualifyIndex = (sql: string, name: string) =>
    qualifyStatement(CREATE_INDEX_TARGET, sql, target(name)) ?? sql;

  // A column type change: the views as of planning, and the source types.
  const snapshots = [...rebuilds.values()].flatMap((rebuild) =>
    rebuild.views ? [rebuild.views] : [],
  );
  if (
    snapshots.some(
      (snapshot) =>
        snapshot.fingerprint !== snapshots[0].fingerprint ||
        snapshot.database !== snapshots[0].database ||
        snapshot.schema !== snapshots[0].schema,
    )
  )
    throw new ViewsChangedSincePlanError();
  const snapshot = snapshots.find((item) => item.temporary) ?? snapshots[0];
  const upgraded = [...rebuilds.values()].flatMap((rebuild) =>
    (rebuild.upgraded ?? []).map((item) => ({ table: rebuild.table, ...item })),
  );

  // First of all: the database, its views and every table must still be the
  // ones this plan was built from.
  const statements: string[] = [
    ...(snapshot ? viewsGuardStatements(snapshot, upgraded) : []),
    ...planGuardStatements(tables),
  ];
  for (const name of dropOrder)
    statements.push(
      `CREATE TABLE ${staging(name)} AS SELECT * FROM ${target(name)}`,
    );
  for (const name of [...dropOrder].reverse())
    statements.push(`DROP TABLE ${target(name)}`);
  for (const name of createOrder) {
    const info = byName.get(name) as TableInfo;
    const rebuild = rebuilds.get(name);
    const columns = rebuild?.columns ?? copyColumns(info);
    const sources =
      rebuild?.sources ?? columns.map((column) => quoteIdentifier(column));
    const create = qualifyStatement(
      CREATE_TABLE_NAME,
      rebuild?.createSql ?? info.createSql,
      target(name),
    );
    if (!create)
      return {
        blocked: `the CREATE TABLE statement of table "${name}" could not be read`,
      };
    statements.push(create);
    statements.push(
      `INSERT INTO ${target(name)} (${columns
        .map((column) => quoteIdentifier(column))
        .join(', ')}) SELECT ${sources.join(', ')} FROM ${staging(name)}`,
    );
  }
  const followUps = names.flatMap(
    (name) => rebuilds.get(name)?.followUps ?? [],
  );
  for (const name of createOrder)
    statements.push(
      ...(
        rebuilds.get(name)?.indexes ??
        (byName.get(name) as TableInfo).indexes.map((index) => index.sql)
      ).map((sql) => qualifyIndex(sql, name)),
    );
  statements.push(
    ...followUps.map((sql) => {
      const index = readIndexName(sql);
      return index && names.includes(index.table)
        ? qualifyIndex(sql, index.table)
        : sql;
    }),
  );

  // The comments the drop discarded.
  for (const name of createOrder) {
    const info = byName.get(name) as TableInfo;
    const rebuild = rebuilds.get(name);
    const finalColumns = new Set(rebuild?.allColumns ?? info.columns);
    const finalIndexes = new Set(
      (rebuild?.indexes ?? info.indexes.map((index) => index.sql)).map(
        (sql) => readIndexName(sql)?.name,
      ),
    );
    const comments = info.comments;
    if (!comments) continue;
    if (comments.table !== null)
      statements.push(
        `COMMENT ON TABLE ${target(name)} IS ${quoteStringLiteral(comments.table)}`,
      );
    for (const [column, comment] of comments.columns)
      if (finalColumns.has(column))
        statements.push(
          `COMMENT ON COLUMN ${target(name)}.${quoteIdentifier(column)} IS ${quoteStringLiteral(comment)}`,
        );
    for (const [index, comment] of comments.indexes)
      if (finalIndexes.has(index))
        statements.push(
          `COMMENT ON INDEX ${qualified(anchor, index)} IS ${quoteStringLiteral(comment)}`,
        );
  }

  // What the plan meant to build, table by table.
  const expected: Parameters<typeof checkStatements>[0] = [];
  for (const name of createOrder) {
    const info = byName.get(name) as TableInfo;
    const rebuild = rebuilds.get(name);
    const indexes = (
      rebuild?.indexes ?? info.indexes.map((index) => index.sql)
    ).map((sql) => readIndexName(sql));
    for (const sql of followUps) {
      const index = readIndexName(sql);
      if (index?.table === name) indexes.push(index);
    }
    if (indexes.some((index) => !index))
      return { blocked: `an index of table "${name}" could not be read` };
    expected.push({
      table: name,
      target: target(name),
      staging: staging(name),
      columns: rebuild?.allColumns ?? rebuild?.columns ?? info.columns,
      indexes: indexes.map((index) => (index as { name: string }).name),
      keys: finalKeys(name).map(
        (reference) => `${reference.columns}->${reference.parent}`,
      ),
      content:
        rebuild?.content ??
        (info.stored ?? []).map((column) => ({
          column,
          source: quoteIdentifier(column),
          type: info.types?.[column] ?? 'VARCHAR',
        })),
    });
  }
  statements.push(...checkStatements(expected));
  for (const name of dropOrder) statements.push(`DROP TABLE ${staging(name)}`);
  // Last: every view of the database must still bind (a column type change).
  if (snapshot)
    statements.push(...snapshot.views.map((view) => viewProbeStatement(view)));
  return { statements };
}

export async function planDuckDbTableChanges(
  options: PlanDuckDbTableChangesOptions,
): Promise<DuckDbPlanResult> {
  const { db, tableName, changes } = options;
  const constraints = options.constraintChanges ?? [];
  const unplanned: SqliteRebuildPlanResult = {
    changes,
    constraintChanges: constraints,
    planInConstraints: false,
  };

  const alterClass = changes.filter(
    (change) =>
      (change.type === 'alter_column' &&
        change.name &&
        [
          'set_not_null',
          'drop_not_null',
          'set_default',
          'drop_default',
        ].includes(change.alteration ?? '') &&
        !change.advisory &&
        statementsOf(change).some((sql) => !sql.trim().startsWith('--'))) ||
      (change.type === 'type_upgrade' &&
        change.name &&
        change.column &&
        !change.advisory &&
        alters(change)) ||
      (change.type === 'drop_column' && change.name),
  );
  const keyedColumns = new Set(
    constraints.flatMap((change) =>
      change.type === 'add_foreign_key' &&
      change.engineUnsupported === true &&
      change.foreignKey
        ? [change.foreignKey.column]
        : [],
    ),
  );
  // A foreign key on a column this run adds goes in with the column.
  const addsWithAlter = changes.filter(
    (change) =>
      change.type === 'add_column' &&
      change.name &&
      change.column &&
      (hasUpdate(change) || alters(change) || keyedColumns.has(change.name)),
  );
  const foreignKeyOps = constraints.filter(
    (change) =>
      (change.type === 'add_foreign_key' &&
        change.engineUnsupported === true &&
        !change.orphanBlocked &&
        change.foreignKey !== undefined) ||
      (change.type === 'drop_foreign_key' && change.foreignKey !== undefined),
  );
  if (
    alterClass.length === 0 &&
    foreignKeyOps.length === 0 &&
    !addsWithAlter.some(hasUpdate)
  )
    return unplanned;

  const pending = [...alterClass, ...addsWithAlter, ...foreignKeyOps];
  const block = (reason: string): SqliteRebuildPlanResult => ({
    changes: changes.map((change) => {
      if (!alterClass.includes(change) && !addsWithAlter.includes(change))
        return change;
      const { sqlStatements: _statements, ...rest } = change;
      return {
        ...rest,
        kindHint:
          change.type === 'type_upgrade'
            ? ('type.rebuild-unavailable' as const)
            : ('column.rebuild-unavailable' as const),
        sql: blockedSql(change.name as string, reason),
      };
    }),
    constraintChanges: constraints.map((change) =>
      foreignKeyOps.includes(change) && change.advisory
        ? {
            ...change,
            advisory: {
              ...change.advisory,
              message: `${change.advisory.message} The table rebuild is not possible: ${reason}.`,
            },
          }
        : change,
    ),
    planInConstraints: false,
  });

  // These need a rebuild whatever the catalog says. A column type change is
  // always a rebuild (P5a): the ALTER route had its own guards, probes and an
  // unguarded fallback when the catalog could not be read.
  const typeChanges = alterClass.filter(
    (change) => change.type === 'type_upgrade',
  );
  const mustRebuild =
    foreignKeyOps.length > 0 ||
    addsWithAlter.some(hasUpdate) ||
    alterClass.some(hasUpdate) ||
    typeChanges.length > 0;
  let table: TableInfo | undefined;
  let references: DuckDbReference[] = [];
  try {
    table = await readTable(db, tableName);
    references = await readReferences(db);
  } catch (error) {
    if (!mustRebuild) return unplanned;
    return block(
      `live schema introspection failed (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (!table) {
    // An adapter that cannot show the definition cannot show the indexes
    // either; the ALTER statements stand as generated.
    return mustRebuild
      ? block('no CREATE TABLE statement found for the table')
      : unplanned;
  }
  const group = referencingGroup(tableName, references);
  const inbound = group.order.length > 1;

  const rebuildNeeded =
    mustRebuild ||
    (inbound && (alterClass.length > 0 || addsWithAlter.length > 0)) ||
    // DuckDB refuses an ALTER on an indexed table, and in a database file it
    // cannot create an index again in the transaction that dropped it around
    // the ALTER ("already exists"), so an indexed table is rebuilt.
    (table.indexes.length > 0 && alterClass.length > 0);

  const planned = plannedReferenceBlock(
    rebuildNeeded ? group.order : alterClass.length > 0 ? [tableName] : [],
    options.plannedReferences ?? [],
  );
  if (planned) return block(planned);

  // No index and nothing referencing the table: ALTER works as generated.
  if (!rebuildNeeded) return unplanned;

  if (group.cyclic)
    return block(
      'a table in the group references itself, and DuckDB cannot copy rows into such a table',
    );
  if (options.blockRebuild) return block(options.blockRebuild);

  // What the rebuild does to the target table.
  const columnTypes = new Map<string, string>();
  const tighten = new Map<string, string>();
  const nullable = new Set<string>();
  const setDefaults = new Map<string, string>();
  const dropDefaults = new Set<string>();
  const dropColumns = new Set<string>();
  const removeForeignKeyColumns = new Set<string>();
  const appendConstraints: string[] = [];
  const appended: Array<{ name: string; definition: string; copy: string }> =
    [];
  const followUps: string[] = [];
  for (const change of alterClass) {
    const name = change.name as string;
    if (change.type === 'drop_column') dropColumns.add(name);
    else if (change.type === 'type_upgrade') {
      const type = options.mapType(
        (change.column as { type: SQLDataType }).type,
      );
      columnTypes.set(name, type);
    } else if (change.alteration === 'drop_not_null') nullable.add(name);
    else if (change.alteration === 'drop_default') dropDefaults.add(name);
    else if (change.alteration === 'set_default') {
      const declared = options.formatDefault?.(change);
      if (declared === undefined)
        return block(`the default of "${name}" cannot be written as SQL`);
      setDefaults.set(name, declared);
    } else {
      const backfill = change.column?.backfill;
      const declared = options.formatDefault?.(change);
      const expression =
        typeof backfill === 'string'
          ? `COALESCE(${quoteIdentifier(name)}, (${backfill}))`
          : declared !== undefined && hasUpdate(change)
            ? `COALESCE(${quoteIdentifier(name)}, ${declared})`
            : quoteIdentifier(name);
      tighten.set(name, expression);
    }
  }
  for (const change of addsWithAlter) {
    const name = change.name as string;
    const column = change.column as NonNullable<SchemaChange['column']>;
    const definition = options.addedColumnDefinition?.(change);
    if (!definition)
      return block(`the column "${name}" cannot be written as SQL`);
    const declared = options.formatDefault?.(change);
    appended.push({
      name,
      definition,
      copy:
        typeof column.backfill === 'string'
          ? `(${column.backfill})`
          : (declared ?? 'NULL'),
    });
    followUps.push(...(options.addedColumnFollowUps?.(change) ?? []));
  }
  const knownColumns = new Set(
    [...table.columns, ...appended.map((column) => column.name)].map((name) =>
      name.toLowerCase(),
    ),
  );
  for (const change of foreignKeyOps) {
    const column = (change.foreignKey as { column: string }).column;
    if (!knownColumns.has(column.toLowerCase()))
      return block(`the table has no column "${column}" for the foreign key`);
    removeForeignKeyColumns.add(column);
    if (change.type === 'add_foreign_key') {
      const definition = options.foreignKeyDefinition?.(change);
      if (!definition) return block('the foreign key cannot be written as SQL');
      appendConstraints.push(definition);
    }
  }

  const target = rewriteSqliteCreateTable(table.createSql, {
    tableName,
    columnTypes,
    notNullColumns: new Set(tighten.keys()),
    nullableColumns: nullable,
    setDefaults,
    dropDefaults,
    dropColumns,
    removeForeignKeyColumns,
    appendDefinitions: appended.map((column) => column.definition),
    appendConstraints,
  });
  if (!target)
    return block('the live CREATE TABLE statement could not be rewritten');
  // A table-level constraint that names a dropped column cannot be kept.
  for (const item of parseCreateTableBody(table.createSql)?.items ?? []) {
    if (readColumnDefinitionName(item)) continue;
    for (const dropped of dropColumns) {
      if (item.includes(dropped))
        return block(
          `a constraint on the table also uses the dropped column "${dropped}"`,
        );
    }
  }

  let tables: TableInfo[];
  try {
    tables = [table];
    for (const name of group.order) {
      if (name === tableName) continue;
      const other = await readTable(db, name);
      if (!other) return block(`table "${name}" could not be read`);
      tables.push(other);
    }
  } catch (error) {
    return block(
      `live schema introspection failed (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  // Stored columns only are copied; every table of the group is classified.
  let views: DuckDbViewSnapshot | undefined;
  try {
    for (const info of tables) {
      const unclassified = await classifyColumns(db, info);
      if (unclassified) return block(unclassified);
    }
    const generatedTarget = [...columnTypes.keys()].find((column) =>
      table.generated?.includes(column),
    );
    if (generatedTarget)
      return block(
        `the column "${generatedTarget}" is generated; its type follows its expression and is not converted by a rebuild`,
      );
    // A dependency-tracked view blocks the drop itself.
    const dependents = await readDependents(db, tables);
    if (dependents.length > 0)
      return block(
        `${dependents.join(', ')} depend${dependents.length === 1 ? 's' : ''} on the table (a view created with enable_view_dependencies); drop ${dependents.length === 1 ? 'it' : 'them'} first`,
      );
    if (typeChanges.length > 0) {
      // Every view must bind before the change, or its check after the change
      // proves nothing.
      views = await readViewSnapshot(
        db,
        options.includeTemporaryViews === true,
      );
      const unbound = await unboundViews(db, views.views);
      if (unbound.length > 0)
        return block(
          `a column type change is checked against every view, and ${unbound
            .map(
              ({ view, message }) =>
                `${qualifiedViewName(view)} does not bind (${message})`,
            )
            .join(
              '; ',
            )}; repair or drop ${unbound.length === 1 ? 'it' : 'them'} first`,
        );
    }
  } catch (error) {
    return block(
      `live schema introspection failed (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  const stored = table.stored ?? table.columns;
  const kept = stored.filter((column) => !dropColumns.has(column));
  const copied = copyColumns(table).filter(
    (column) => !dropColumns.has(column),
  );
  const sourceOf = (column: string) => {
    const expression = tighten.get(column) ?? quoteIdentifier(column);
    const type = columnTypes.get(column);
    return type ? `CAST(${expression} AS ${type})` : expression;
  };
  const rebuild: DuckDbTableRebuild = {
    table: tableName,
    createSql: target,
    columns: [...copied, ...appended.map((column) => column.name)],
    sources: [
      ...copied.map(sourceOf),
      ...appended.map((column) => column.copy),
    ],
    allColumns: [
      ...table.columns.filter((column) => !dropColumns.has(column)),
      ...appended.map((column) => column.name),
    ],
    content: kept.map((column) => ({
      column,
      source: sourceOf(column),
      type: columnTypes.get(column) ?? table.types?.[column] ?? 'VARCHAR',
    })),
    upgraded: typeChanges.flatMap((change) => {
      const column = change.name as string;
      const from = table.types?.[column];
      return from ? [{ column, from }] : [];
    }),
    ...(views ? { views } : {}),
    indexes: table.indexes
      .filter(
        (index) => !index.columns.some((column) => dropColumns.has(column)),
      )
      .map((index) => index.sql),
    followUps,
    removedKeyColumns: [...removeForeignKeyColumns],
    addedKeys: foreignKeyOps.flatMap((change) =>
      change.type === 'add_foreign_key' && change.foreignKey
        ? [
            {
              column: change.foreignKey.column,
              parent: change.foreignKey.referencesTable,
            },
          ]
        : [],
    ),
  };
  const built = buildGroupRebuild(
    tables,
    new Map([[tableName, rebuild]]),
    references,
  );
  if ('blocked' in built) return block(built.blocked);
  const { statements } = built;

  // Fold the table's changes into the rebuild, which runs before the rest.
  const folded = [...alterClass, ...addsWithAlter];
  const primary = folded[0] ?? foreignKeyOps[0];
  const carry = (change: SchemaChange): SchemaChange => {
    const carried: SchemaChange = {
      ...change,
      sql: statements[0],
      sqlStatements: statements,
    };
    if (
      change.type === 'add_foreign_key' ||
      change.type === 'drop_foreign_key'
    ) {
      delete carried.engineUnsupported;
      delete carried.advisory;
    }
    return carried;
  };
  const rebuilt = changes.map((change): SchemaChange | null => {
    if (!folded.includes(change)) return change;
    if (change === primary) return carry(change);
    // An `add_column` is always executed, so a covered one is dropped.
    if (change.type === 'add_column') return null;
    const { sqlStatements: _dropped, ...rest } = change;
    return {
      ...rest,
      sql: `-- DuckDB: ${quoteIdentifier(change.name as string)} is rebuilt with ${quoteIdentifier(primary.name as string)} in one table rebuild (no change needed)`,
    };
  });
  // The rebuild runs before the table's other changes: it copies the live
  // table, so a change executed earlier would be lost.
  const positions = new Set(folded.map((change) => changes.indexOf(change)));
  const first = rebuilt.filter((_, index) => positions.has(index));
  const others = rebuilt.filter((_, index) => !positions.has(index));
  const ordered = [...first, ...others].filter(
    (change): change is SchemaChange => change !== null,
  );

  const planInConstraints = folded.length === 0;
  const carried = planInConstraints ? carry(primary) : undefined;
  const remaining = constraints
    .filter((change) => change === primary || !foreignKeyOps.includes(change))
    .map((change) => (change === primary && carried ? carried : change));
  const carrier =
    carried ??
    (ordered.find(
      (change) => change.sqlStatements === statements,
    ) as SchemaChange);
  return {
    changes: ordered,
    constraintChanges: carried
      ? [carried, ...remaining.filter((change) => change !== carried)]
      : remaining,
    planInConstraints,
    rebuild: { rebuild, tables, references, carrier },
  };
}

/** Whether two readings of one table describe the same table. */
function sameTableReading(left: TableInfo, right: TableInfo): boolean {
  return (
    left.createSql === right.createSql &&
    left.columns.join('\u0000') === right.columns.join('\u0000') &&
    JSON.stringify(left.indexes) === JSON.stringify(right.indexes) &&
    JSON.stringify(left.catalog ?? null) ===
      JSON.stringify(right.catalog ?? null)
  );
}

/**
 * Combine the DuckDB rebuilds of one migration into one plan per connected
 * group of tables (#4937).
 *
 * A rebuild drops and creates its table and every table that references it.
 * Planned one table at a time, a rebuild that ran after another change to one
 * of those tables would create that table again from its old definition and
 * lose the change. So the rebuilds whose groups share a table become one
 * rebuild, in which every table is copied once from its old rows into its final
 * shape, and every other change to a table of the group runs after it. The
 * result does not depend on the order of the changes in the diff.
 *
 * When the rebuilds cannot be combined, `blocked` names each rebuilt table with
 * the reason; the differ then plans those tables again as stops, so the whole
 * migration stops before anything is applied.
 */
export function combineDuckDbRebuilds(
  changes: SchemaChange[],
  plans: DuckDbRebuildPlan[],
  plannedReferences: Edge[] = [],
): { changes: SchemaChange[]; blocked: Map<string, string> } {
  const blocked = new Map<string, string>();
  if (plans.length === 0) return { changes, blocked };
  const references = plans[0].references;
  const edges: Edge[] = [
    ...references,
    ...plans.flatMap((plan) =>
      plan.rebuild.addedKeys.map((key) => ({
        child: plan.rebuild.table,
        parent: key.parent,
      })),
    ),
  ];
  const sets = plans.map((plan) => ({
    plans: [plan],
    tables: closeOverReferencing([plan.rebuild.table], edges),
  }));
  for (let merged = true; merged; ) {
    merged = false;
    for (let i = 0; i < sets.length && !merged; i++) {
      for (let j = i + 1; j < sets.length && !merged; j++) {
        if (!sets[j].tables.some((name) => sets[i].tables.includes(name)))
          continue;
        sets[i].plans.push(...sets[j].plans);
        for (const name of sets[j].tables)
          if (!sets[i].tables.includes(name)) sets[i].tables.push(name);
        sets.splice(j, 1);
        merged = true;
      }
    }
  }

  let result = [...changes];
  for (const set of sets) {
    const rebuilt = set.plans.map((plan) => plan.rebuild.table);
    const infos = new Map<string, TableInfo>();
    for (const plan of set.plans)
      for (const info of plan.tables) {
        // Two plans read this table at different moments. If it changed in
        // between (another connection added a column, an index), the earlier
        // plan's definition and copy list and the later catalog snapshot
        // disagree, and combining them would build the old shape and check
        // it against the new one. Stop; a rerun plans from one reading.
        const earlier = infos.get(info.name);
        if (earlier && !sameTableReading(earlier, info))
          throw new TableChangedSincePlanError(info.name);
        infos.set(info.name, info);
      }
    const unread = set.tables.find((name) => !infos.has(name));
    const carriers = set.plans
      .map((plan) => plan.carrier)
      .sort((left, right) => result.indexOf(left) - result.indexOf(right));
    const planned = plannedReferenceBlock(set.tables, plannedReferences);
    const built: { statements: string[] } | { blocked: string } = planned
      ? { blocked: planned }
      : unread
        ? { blocked: `table "${unread}" was not read with the rebuilds` }
        : carriers.some((carrier) => !result.includes(carrier))
          ? { blocked: 'a rebuild is missing from the plan' }
          : buildGroupRebuild(
              set.tables.map((name) => infos.get(name) as TableInfo),
              new Map(
                set.plans.map((plan) => [plan.rebuild.table, plan.rebuild]),
              ),
              references,
            );
    if ('blocked' in built) {
      const reason =
        set.plans.length > 1
          ? `the rebuilds of ${rebuilt.map((name) => `"${name}"`).join(', ')} overlap and cannot be combined into one: ${built.blocked}`
          : built.blocked;
      for (const name of rebuilt) blocked.set(name, reason);
      continue;
    }
    const [lead, ...covered] = carriers;
    const leadTable = lead.table;
    const combined: SchemaChange = {
      ...lead,
      sql: built.statements[0],
      sqlStatements: built.statements,
    };
    result = result.flatMap((change): SchemaChange[] => {
      if (change === lead) return [combined];
      if (!covered.includes(change)) return [change];
      // An `add_column` is always executed and a foreign-key change is
      // carried by the rebuild, so a covered one is dropped, as in the plan of
      // a single table.
      if (
        change.type === 'add_column' ||
        change.type === 'add_foreign_key' ||
        change.type === 'drop_foreign_key'
      )
        return [];
      const { sqlStatements: _dropped, ...rest } = change;
      return [
        {
          ...rest,
          sql: `-- DuckDB: ${quoteIdentifier(change.table)}.${quoteIdentifier(change.name as string)} is rebuilt with ${quoteIdentifier(leadTable)} in one table rebuild (no change needed)`,
        },
      ];
    });
    // Every other change to a table of the group runs after the rebuild: the
    // rebuild copies the tables as they were planned, so a change made to one
    // of them earlier would be lost. A table the rebuild starts to reference
    // takes its changes first: once referenced, DuckDB refuses to alter it.
    const inGroup = (change: SchemaChange) => set.tables.includes(change.table);
    const newParents = new Set(
      set.plans
        .flatMap((plan) => plan.rebuild.addedKeys.map((key) => key.parent))
        .filter((name) => !set.tables.includes(name)),
    );
    const ahead = (change: SchemaChange) => newParents.has(change.table);
    const first = result.findIndex(inGroup);
    const head = result.slice(0, first);
    const tail = result.slice(first);
    result = [
      ...head,
      ...tail.filter(ahead),
      combined,
      ...tail.filter((change) => inGroup(change) && change !== combined),
      ...tail.filter((change) => !inGroup(change) && !ahead(change)),
    ];
  }
  return { changes: result, blocked };
}

/**
 * Move every view bind probe of a migration's changes to the end of its last
 * executable change, once each (P5a, E3).
 *
 * A rebuild ends with the probes for its own column type change, but a later
 * change of the same migration (a column added to another table that a
 * `SELECT *` view reads) can also change a view's result columns. Checked
 * after the last changing statement, a probe covers the whole migration.
 */
export function moveViewProbesLast(changes: SchemaChange[]): SchemaChange[] {
  const probes: string[] = [];
  const stripped = changes.map((change) => {
    const statements = change.sqlStatements;
    if (!statements?.some((sql) => parseViewProbe(sql))) return change;
    for (const sql of statements)
      if (parseViewProbe(sql) && !probes.includes(sql)) probes.push(sql);
    const rest = statements.filter((sql) => !parseViewProbe(sql));
    return { ...change, sql: rest[0], sqlStatements: rest };
  });
  if (probes.length === 0) return changes;
  const executable = (change: SchemaChange) =>
    change.type !== 'type_mismatch' &&
    change.phase !== 'pre_foreign_key' &&
    statementsOf(change).some((sql) => !/^\s*--/.test(sql));
  let last = -1;
  stripped.forEach((change, index) => {
    if (executable(change)) last = index;
  });
  if (last === -1) return changes;
  const carrier = stripped[last];
  stripped[last] = {
    ...carrier,
    sqlStatements: [...statementsOf(carrier), ...probes],
  };
  return stripped;
}
