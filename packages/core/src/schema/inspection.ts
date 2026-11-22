/** Schema metadata read through the supplied executor, including uncommitted DDL. */
import type { DatabaseInterface, TableSchemaInfo } from '@happyvertical/sql';
import type { DatabaseEngine } from './ddl/types.js';
import { sqliteUserObjectName } from './sqlite-internal-names.js';

/**
 * A table the catalog lists could not be described through this handle.
 *
 * A comparison that cannot read a table has nothing to say about it, and
 * "nothing to say" must never be read as "nothing to change": the migrate
 * stops here, before anything is applied or recorded.
 */
export class TableSchemaUnreadableError extends Error {
  constructor(
    readonly table: string,
    readonly engine: string,
    options?: { cause?: unknown },
  ) {
    super(
      `Table "${table}" exists, but its schema could not be read through this ${engine} database handle, so it cannot be compared with the declared schema. Nothing was changed. Core reads PostgreSQL and SQLite through the handle itself; on any other engine the adapter must provide getTableSchema. Run the migrate on a database handle that can describe the table.`,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'TableSchemaUnreadableError';
  }
}

/**
 * A declared table name matches a catalog table only by case. SQLite and
 * DuckDB resolve the two spellings to one table, while the migrate plan
 * matches names exactly and would treat the declared one as missing.
 */
export class TableSpellingMismatchError extends Error {
  constructor(
    readonly table: string,
    readonly existingTable: string,
  ) {
    super(
      `Table "${table}" is declared, but the database holds it as "${existingTable}" (the engine treats the two spellings as one table, a migrate plan does not). Nothing was changed. Rename the table or the declaration so the spellings match exactly.`,
    );
    this.name = 'TableSpellingMismatchError';
  }
}

/**
 * A SQLite `temp` table has the name of a declared table. Unqualified DDL
 * resolves to the temporary table first, so a migrate would change it and
 * record success while the permanent table stays as it was.
 */
export class TemporaryTableShadowError extends Error {
  constructor(readonly table: string) {
    super(
      `A temporary table named "${table}" shadows the declared table of that name, so a migrate would change the temporary table. Nothing was changed. Drop the temporary table, or migrate on a connection that has not created it.`,
    );
    this.name = 'TemporaryTableShadowError';
  }
}

/** Whether {@link inspectTableSchema} has any way to describe a table here. */
export function canInspectTableSchema(
  db: DatabaseInterface,
  engine: DatabaseEngine,
): boolean {
  return (
    typeof db.getTableSchema === 'function' ||
    engine === 'postgres' ||
    engine === 'sqlite'
  );
}

/**
 * Use the adapter's public inspector when present. A handle without
 * getTableSchema() still exposes query(); its catalog reads must stay on that
 * handle (it sees the transaction's own uncommitted DDL) rather than checking
 * out another connection. PostgreSQL and SQLite are read from their catalogs
 * through the handle; the public schema matches the existing
 * SDK/SchemaComparer migration scope.
 */
export async function inspectTableSchema(
  db: DatabaseInterface,
  tableName: string,
  engine: DatabaseEngine,
): Promise<TableSchemaInfo | null> {
  if (db.getTableSchema) return (await db.getTableSchema(tableName)) ?? null;
  if (engine === 'sqlite') return inspectSqliteTableSchema(db, tableName);
  if (engine !== 'postgres')
    throw new Error(
      'Schema inspection requires an adapter inspector, PostgreSQL or SQLite',
    );
  const table = await db.query(
    `SELECT c.oid FROM pg_catalog.pg_class c
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = $1
       AND c.relkind IN ('r', 'p')`,
    [tableName],
  );
  if (!table.rows.length) return null;
  const oid = table.rows[0].oid;
  const columns = await db.query(
    `SELECT a.attname AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
       a.attnotnull AS not_null, pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default_value,
       EXISTS (SELECT 1 FROM pg_catalog.pg_index i
         WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey)) AS primary_key
     FROM pg_catalog.pg_attribute a
     LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
    [oid],
  );
  const indexes = await db.query(
    `SELECT ic.relname AS name, i.indisunique AS is_unique,
       pg_catalog.pg_get_expr(i.indpred, i.indrelid) AS predicate,
       (SELECT json_agg(COALESCE(a.attname, pg_catalog.pg_get_indexdef(i.indexrelid, k.ordinality::int, true))
          ORDER BY k.ordinality)
        FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ordinality)
        LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
        WHERE k.ordinality <= i.indnkeyatts) AS columns
     FROM pg_catalog.pg_index i
     JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
     WHERE i.indrelid = $1`,
    [oid],
  );
  const foreignKeys = await db.query(
    `SELECT ca.attname AS column, p.relname AS parent_table, pa.attname AS parent_column,
       c.confdeltype AS on_delete, c.confupdtype AS on_update
     FROM pg_catalog.pg_constraint c
     JOIN pg_catalog.pg_class p ON p.oid = c.confrelid
     CROSS JOIN LATERAL unnest(c.conkey, c.confkey) AS k(child, parent)
     JOIN pg_catalog.pg_attribute ca ON ca.attrelid = c.conrelid AND ca.attnum = k.child
     JOIN pg_catalog.pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = k.parent
     WHERE c.conrelid = $1 AND c.contype = 'f'`,
    [oid],
  );
  const actions: Record<string, string> = {
    a: 'NO ACTION',
    r: 'RESTRICT',
    c: 'CASCADE',
    n: 'SET NULL',
    d: 'SET DEFAULT',
  };
  return {
    tableName,
    columns: Object.fromEntries(
      columns.rows.map((row) => [
        String(row.name),
        {
          type: String(row.type),
          notNull: row.not_null === true,
          primaryKey: row.primary_key === true,
          defaultValue: row.default_value,
        },
      ]),
    ),
    indexes: indexes.rows.map((row) => ({
      name: String(row.name),
      unique: row.is_unique === true,
      columns:
        typeof row.columns === 'string'
          ? JSON.parse(row.columns)
          : (row.columns as string[]),
      ...(row.predicate ? { where: String(row.predicate) } : {}),
    })),
    foreignKeys: foreignKeys.rows.map((row) => ({
      column: String(row.column),
      referencesTable: String(row.parent_table),
      referencesColumn: String(row.parent_column),
      onDelete: actions[String(row.on_delete)],
      onUpdate: actions[String(row.on_update)],
    })),
  };
}

/**
 * SQLite through `query()` alone, for a handle without `getTableSchema()`. It
 * reads the same catalog the SQL adapter's own SQLite inspector reads, so a
 * comparison made through such a handle plans what the same comparison plans
 * through the adapter; `migrations/__tests__/unreadable-table.test.ts` holds
 * the two side by side. Two differences: the adapter's inspector skips every
 * index whose name matches `sqlite_%` with `_` as a wildcard (so
 * `sqliteX_unique` is hidden), while this reader skips only the literal
 * `sqlite_` prefix; and the adapter marks only the first column of a
 * composite primary key as a key column, while this reader marks all of them.
 *
 * The engine is confirmed first. An in-memory DuckDB handle can read as SQLite
 * by its URL, and DuckDB answers some of these catalog queries with different
 * content, so a handle that is not SQLite is unreadable, never "described".
 */
async function inspectSqliteTableSchema(
  db: DatabaseInterface,
  tableName: string,
): Promise<TableSchemaInfo | null> {
  try {
    await db.query('SELECT sqlite_version()');
  } catch (cause) {
    throw new TableSchemaUnreadableError(tableName, 'sqlite', { cause });
  }
  const exists = await db.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
    tableName,
  );
  if (!exists.rows.length) return null;
  // `main` is named in every pragma: unqualified, a temporary table of the same
  // name answers first, while the catalog read above and the migration DDL
  // address the permanent table.
  const columnRows = await db.query(
    "SELECT * FROM pragma_table_info(?, 'main')",
    tableName,
  );
  const columns: TableSchemaInfo['columns'] = {};
  for (const row of columnRows.rows) {
    columns[String(row.name)] = {
      type: row.type as string,
      // `pk` is the one-based position within the key: every positive
      // position is a key column, not only the first of a composite key.
      primaryKey: Number(row.pk) > 0,
      notNull: row.notnull === 1,
      defaultValue: row.dflt_value,
    };
  }
  const indexRows = await db.query(
    `SELECT name, sql FROM sqlite_master
      WHERE type = 'index' AND tbl_name = ? AND ${sqliteUserObjectName()}`,
    tableName,
  );
  const indexes: NonNullable<TableSchemaInfo['indexes']> = [];
  for (const row of indexRows.rows) {
    const indexName = String(row.name);
    const info = await db.query(
      "SELECT * FROM pragma_index_info(?, 'main')",
      indexName,
    );
    const listed = await db.query(
      "SELECT * FROM pragma_index_list(?, 'main') WHERE name = ?",
      tableName,
      indexName,
    );
    indexes.push({
      name: indexName,
      columns: info.rows.map((column) => column.name as string),
      unique: listed.rows[0]?.unique === 1,
    });
  }
  const foreignKeyRows = await db.query(
    "SELECT * FROM pragma_foreign_key_list(?, 'main')",
    tableName,
  );
  return {
    tableName,
    columns,
    indexes,
    foreignKeys: foreignKeyRows.rows.map((row) => ({
      column: row.from as string,
      referencesTable: row.table as string,
      referencesColumn: row.to as string,
      onDelete: row.on_delete as string,
      onUpdate: row.on_update as string,
    })),
  };
}
