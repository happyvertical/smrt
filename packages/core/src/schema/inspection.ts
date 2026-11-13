/** Schema metadata read through the supplied executor, including uncommitted DDL. */
import type { DatabaseInterface, TableSchemaInfo } from '@happyvertical/sql';
import type { DatabaseEngine } from './ddl/types.js';

/**
 * Use the adapter's public inspector when present. PostgreSQL transaction
 * handles expose query(), but not getTableSchema(); their catalog reads must
 * stay on that handle rather than checking out another pooled connection.
 * The public schema matches the existing SDK/SchemaComparer migration scope.
 */
export async function inspectTableSchema(
  db: DatabaseInterface,
  tableName: string,
  engine: DatabaseEngine,
): Promise<TableSchemaInfo | null> {
  if (db.getTableSchema) return (await db.getTableSchema(tableName)) ?? null;
  if (engine !== 'postgres')
    throw new Error(
      'Schema inspection requires an adapter inspector or PostgreSQL',
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
