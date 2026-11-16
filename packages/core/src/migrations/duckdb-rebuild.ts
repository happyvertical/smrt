/**
 * DuckDB table changes that `ALTER TABLE` cannot make (#4937).
 *
 * DuckDB refuses an `ALTER` in three situations that PostgreSQL accepts:
 *
 * - the table has an index: the index must be dropped around the `ALTER`, and
 *   a type change or column drop still fails when the index covers the column;
 * - another table has a foreign key onto it: nothing on it can be altered;
 * - the same transaction already ran an `UPDATE`: "outstanding updates".
 *
 * It also has no `ADD CONSTRAINT`, so a foreign key can only be added or
 * removed by building the table again.
 *
 * This module is the post-pass over one table's changes. When every change
 * works with `ALTER`, it only wraps the index-sensitive ones in `DROP INDEX` /
 * `CREATE INDEX`. Otherwise it folds the table's changes into one rebuild
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
 * foreign keys, row count) and fails the transaction when they differ.
 */
import {
  quoteIdentifier,
  quoteStringLiteral,
} from '../schema/sql-identifiers.js';
import type { SchemaChange, SQLDataType } from '../schema/types.js';
import {
  parseCreateTableBody,
  readColumnDefinitionName,
  rewriteSqliteCreateTable,
  type SqliteRebuildPlanResult,
} from './sqlite-rebuild.js';
import type { DatabaseInterface } from './types.js';

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
}

/** A live table as the rebuild reads it. */
export interface TableInfo {
  name: string;
  createSql: string;
  columns: string[];
  indexes: Array<{ name: string; sql: string; columns: string[] }>;
}

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
  return `-- DuckDB: ${quoteIdentifier(name)} requires a table rebuild, blocked: ${reason}`;
}

async function readTable(
  db: DatabaseInterface,
  name: string,
): Promise<TableInfo | undefined> {
  const where =
    'database_name = current_database() AND schema_name = current_schema() AND table_name = ?';
  const table = await db.query(
    `SELECT sql FROM duckdb_tables() WHERE ${where}`,
    name,
  );
  const createSql = String((table.rows[0] as { sql?: unknown })?.sql ?? '');
  if (!createSql) return undefined;
  const columns = (
    await db.query(`PRAGMA table_info(${quoteIdentifier(name)})`)
  ).rows.map((row) => String((row as { name?: unknown }).name));
  const indexes = (
    await db.query(
      `SELECT index_name, sql FROM duckdb_indexes() WHERE ${where} AND sql IS NOT NULL`,
      name,
    )
  ).rows.flatMap((row) => {
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
  return { name, createSql: createSql.replace(/;\s*$/, ''), columns, indexes };
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

const stagingName = (name: string) =>
  quoteIdentifier(`${DUCKDB_REBUILD_TABLE_PREFIX}${name}`);
/** The temporary table the rebuild check writes its findings to. */
const CHECK_TABLE = quoteIdentifier('_smrt_check_rebuild');
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
    columns: string[];
    indexes: string[];
    keys: string[];
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
        `(SELECT count(*) FROM ${quoteIdentifier(item.table)})`,
        `(SELECT count(*) FROM ${stagingName(item.table)})`,
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

  const statements: string[] = [];
  for (const name of dropOrder)
    statements.push(
      `CREATE TABLE ${stagingName(name)} AS SELECT * FROM ${quoteIdentifier(name)}`,
    );
  for (const name of [...dropOrder].reverse())
    statements.push(`DROP TABLE ${quoteIdentifier(name)}`);
  for (const name of createOrder) {
    const info = byName.get(name) as TableInfo;
    const rebuild = rebuilds.get(name);
    const columns = rebuild?.columns ?? info.columns;
    const sources =
      rebuild?.sources ?? info.columns.map((column) => quoteIdentifier(column));
    statements.push(rebuild?.createSql ?? info.createSql);
    statements.push(
      `INSERT INTO ${quoteIdentifier(name)} (${columns
        .map((column) => quoteIdentifier(column))
        .join(', ')}) SELECT ${sources.join(', ')} FROM ${stagingName(name)}`,
    );
  }
  const followUps = names.flatMap(
    (name) => rebuilds.get(name)?.followUps ?? [],
  );
  for (const name of createOrder)
    statements.push(
      ...(rebuilds.get(name)?.indexes ??
        (byName.get(name) as TableInfo).indexes.map((index) => index.sql)),
    );
  statements.push(...followUps);

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
      columns: rebuild?.columns ?? info.columns,
      indexes: indexes.map((index) => (index as { name: string }).name),
      keys: finalKeys(name).map(
        (reference) => `${reference.columns}->${reference.parent}`,
      ),
    });
  }
  statements.push(...checkStatements(expected));
  for (const name of dropOrder)
    statements.push(`DROP TABLE ${stagingName(name)}`);
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

  // These need a rebuild whatever the catalog says.
  const mustRebuild =
    foreignKeyOps.length > 0 ||
    addsWithAlter.some(hasUpdate) ||
    alterClass.some(hasUpdate);
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

  const coveredByIndex = (column: string): boolean =>
    table.indexes.some((index) => index.columns.includes(column));
  const rebuildNeeded =
    mustRebuild ||
    (inbound && (alterClass.length > 0 || addsWithAlter.length > 0)) ||
    alterClass.some(
      (change) =>
        (change.type === 'type_upgrade' || change.type === 'drop_column') &&
        coveredByIndex(change.name as string),
    );

  const planned = plannedReferenceBlock(
    rebuildNeeded ? group.order : alterClass.length > 0 ? [tableName] : [],
    options.plannedReferences ?? [],
  );
  if (planned) return block(planned);

  if (!rebuildNeeded) {
    // Every change works with ALTER once the indexes are out of the way.
    if (table.indexes.length === 0) return unplanned;
    const drop = table.indexes.map(
      (index) => `DROP INDEX ${quoteIdentifier(index.name)}`,
    );
    return {
      changes: changes.map((change) => {
        const statements = statementsOf(change);
        if (
          !alterClass.includes(change) ||
          statements.some((sql) => /^\s*DROP\s+INDEX\b/i.test(sql))
        )
          return change;
        const dropped = change.type === 'drop_column' ? change.name : undefined;
        const wrapped = [
          ...drop,
          ...statements,
          ...table.indexes
            .filter((index) => !dropped || !index.columns.includes(dropped))
            .map((index) => index.sql),
        ];
        return {
          ...change,
          sql: wrapped[wrapped.length - 1],
          sqlStatements: wrapped,
        };
      }),
      constraintChanges: constraints,
      planInConstraints: false,
    };
  }

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
  const kept = table.columns.filter((column) => !dropColumns.has(column));
  const rebuild: DuckDbTableRebuild = {
    table: tableName,
    createSql: target,
    columns: [...kept, ...appended.map((column) => column.name)],
    sources: [
      ...kept.map((column) => {
        const expression = tighten.get(column) ?? quoteIdentifier(column);
        const type = columnTypes.get(column);
        return type ? `CAST(${expression} AS ${type})` : expression;
      }),
      ...appended.map((column) => column.copy),
    ],
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
      for (const info of plan.tables) infos.set(info.name, info);
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
