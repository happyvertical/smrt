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
 * rows into a table whose foreign key points at itself in one statement.
 */
import { quoteIdentifier } from '../schema/sql-identifiers.js';
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
}

interface TableInfo {
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

/** Every foreign key in the schema: child table to the parent it references. */
async function readReferences(
  db: DatabaseInterface,
): Promise<Array<{ child: string; parent: string }>> {
  const { rows } = await db.query(
    `SELECT table_name, referenced_table FROM duckdb_constraints()
     WHERE database_name = current_database() AND schema_name = current_schema()
       AND constraint_type = 'FOREIGN KEY'`,
  );
  return rows.flatMap((row) => {
    const { table_name: child, referenced_table: parent } = row as {
      table_name?: unknown;
      referenced_table?: unknown;
    };
    return typeof child === 'string' && typeof parent === 'string'
      ? [{ child, parent }]
      : [];
  });
}

/** The table and every table that references it, directly or not, parents first. */
function referencingGroup(
  tableName: string,
  references: Array<{ child: string; parent: string }>,
): { order: string[]; cyclic: boolean } {
  const group = [tableName];
  for (let index = 0; index < group.length; index++) {
    for (const edge of references) {
      if (edge.parent === group[index] && !group.includes(edge.child))
        group.push(edge.child);
    }
  }
  const inGroup = references.filter(
    (edge) => group.includes(edge.child) && group.includes(edge.parent),
  );
  if (inGroup.some((edge) => edge.child === edge.parent))
    return { order: group, cyclic: true };
  const order: string[] = [];
  const remaining = [...group];
  while (remaining.length > 0) {
    const next = remaining.find(
      (name) =>
        !inGroup.some(
          (edge) => edge.child === name && remaining.includes(edge.parent),
        ),
    );
    if (!next) return { order: group, cyclic: true };
    order.push(next);
    remaining.splice(remaining.indexOf(next), 1);
  }
  return { order, cyclic: false };
}

export async function planDuckDbTableChanges(
  options: PlanDuckDbTableChangesOptions,
): Promise<SqliteRebuildPlanResult> {
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
  let references: Array<{ child: string; parent: string }> = [];
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
  const byName = new Map(tables.map((info) => [info.name, info]));
  const staging = (name: string) =>
    quoteIdentifier(`${DUCKDB_REBUILD_TABLE_PREFIX}${name}`);

  const statements: string[] = [];
  for (const name of group.order)
    statements.push(
      `CREATE TABLE ${staging(name)} AS SELECT * FROM ${quoteIdentifier(name)}`,
    );
  for (const name of [...group.order].reverse())
    statements.push(`DROP TABLE ${quoteIdentifier(name)}`);
  for (const name of group.order) {
    const info = byName.get(name) as TableInfo;
    if (name === tableName) {
      statements.push(target);
      const kept = info.columns.filter((column) => !dropColumns.has(column));
      const targetList = [...kept, ...appended.map((column) => column.name)]
        .map((column) => quoteIdentifier(column))
        .join(', ');
      const sourceList = [
        ...kept.map((column) => {
          const expression = tighten.get(column) ?? quoteIdentifier(column);
          const type = columnTypes.get(column);
          return type ? `CAST(${expression} AS ${type})` : expression;
        }),
        ...appended.map((column) => column.copy),
      ].join(', ');
      statements.push(
        `INSERT INTO ${quoteIdentifier(name)} (${targetList}) SELECT ${sourceList} FROM ${staging(name)}`,
      );
    } else {
      statements.push(info.createSql);
      const list = info.columns
        .map((column) => quoteIdentifier(column))
        .join(', ');
      statements.push(
        `INSERT INTO ${quoteIdentifier(name)} (${list}) SELECT ${list} FROM ${staging(name)}`,
      );
    }
  }
  for (const name of group.order) {
    for (const index of (byName.get(name) as TableInfo).indexes) {
      if (
        name === tableName &&
        index.columns.some((column) => dropColumns.has(column))
      )
        continue;
      statements.push(index.sql);
    }
  }
  statements.push(...followUps);
  for (const name of group.order)
    statements.push(`DROP TABLE ${staging(name)}`);

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
  return {
    changes: ordered,
    constraintChanges: carried
      ? [carried, ...remaining.filter((change) => change !== carried)]
      : remaining,
    planInConstraints,
  };
}
