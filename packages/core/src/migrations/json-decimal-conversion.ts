/**
 * Convert the 4-byte decimal columns of existing JSON-adapter tables to DOUBLE
 * (P5a, E9).
 *
 * `db:migrate` reports, and never runs, DDL on an existing JSON-adapter table
 * (`json-adapter-ddl.ts`): the adapter keeps DDL run through `query()` in
 * memory until its next write. This helper does the conversion where it can
 * be made durable and checked, one table at a time, on the root handle:
 *
 * 1. refuse the table when its data file did not load (`getTableLoadErrors()`
 *    names it), when the live row count differs from the rows in
 *    `<table>.json`, or when the file holds a key that is not a column of the
 *    table: exporting then would overwrite data the table does not hold;
 * 2. widen its FLOAT columns with the DuckDB table rebuild plan, in one
 *    transaction;
 * 3. write `<table>.json` and `<table>.schema.sql` with `exportTable()`, after
 *    copying both files aside;
 * 4. open the directory again on a fresh handle without schemas and check the
 *    table reads back with DOUBLE columns and the same row count; when it does
 *    not, put the copied files back.
 *
 * A refused table is left byte for byte as it was.
 */
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  quoteIdentifier,
  quoteStringLiteral,
} from '../schema/sql-identifiers.js';
import { isCommentOnlySql } from './change-kinds.js';
import { planDuckDbTableChanges } from './duckdb-rebuild.js';

/** What the conversion did with one table. */
export interface JsonDecimalConversion {
  table: string;
  /** The 4-byte columns the table held. */
  columns: string[];
  /**
   * `converted` (or `would-convert` on a dry run), `refused` before anything
   * was written, or `failed` after a write, with the files put back.
   */
  outcome: 'converted' | 'would-convert' | 'refused' | 'failed';
  reason?: string;
}

export interface ConvertJsonDecimalColumnsOptions {
  /** Check and plan every table, write nothing. */
  dryRun?: boolean;
  /** Only these tables (default: every table with a FLOAT column). */
  tables?: string[];
  /** The adapter's data directory (default: the handle's `url`). */
  dataDir?: string;
}

interface JsonRootHandle extends DatabaseInterface {
  exportTable?: (table: string) => Promise<void>;
  getTableLoadErrors?: () => Array<{
    table?: string;
    tableName?: string;
    error?: unknown;
  }>;
}

const NARROW = new Set(['FLOAT', 'REAL', 'FLOAT4']);

/**
 * Convert the FLOAT columns of existing JSON-adapter tables to DOUBLE, durably
 * and checked; see the module comment. Throws when `db` is not a JSON-adapter
 * root handle.
 */
export async function convertJsonDecimalColumns(
  db: DatabaseInterface,
  options: ConvertJsonDecimalColumnsOptions = {},
): Promise<JsonDecimalConversion[]> {
  const root = db as JsonRootHandle;
  if (
    typeof root.exportTable !== 'function' ||
    typeof root.getTableLoadErrors !== 'function' ||
    typeof root.transaction !== 'function'
  )
    throw new Error(
      'convertJsonDecimalColumns() needs the JSON adapter root handle (not a transaction handle): it exports tables and reads their load errors.',
    );
  const dataDir = options.dataDir ?? root.url;
  if (!dataDir)
    throw new Error(
      'convertJsonDecimalColumns() could not find the data directory; pass dataDir.',
    );

  const { rows } = await db.query(
    `SELECT table_name, column_name, data_type FROM duckdb_columns()
      WHERE database_name = current_database() AND schema_name = current_schema()
      ORDER BY table_name, column_index`,
  );
  const narrow = new Map<string, string[]>();
  const columnsOf = new Map<string, string[]>();
  for (const row of rows) {
    const table = String(row.table_name);
    const column = String(row.column_name);
    columnsOf.set(table, [...(columnsOf.get(table) ?? []), column]);
    if (NARROW.has(String(row.data_type).toUpperCase()))
      narrow.set(table, [...(narrow.get(table) ?? []), column]);
  }

  const results: JsonDecimalConversion[] = [];
  for (const [table, columns] of narrow) {
    if (options.tables && !options.tables.includes(table)) continue;
    const refuse = (reason: string) =>
      results.push({ table, columns, outcome: 'refused', reason });
    const file = join(dataDir, `${table}.json`);
    const schemaFile = join(dataDir, `${table}.schema.sql`);

    // 1. Everything in the file must be in the table.
    const loadErrors = root
      .getTableLoadErrors()
      .filter((item) => (item.table ?? item.tableName) === table);
    if (loadErrors.length > 0) {
      const cause = (loadErrors[0] as { error?: unknown }).error;
      refuse(
        `its data file did not load (${cause instanceof Error ? cause.message : String(cause)})`,
      );
      continue;
    }
    if (!existsSync(file)) {
      refuse(`it has no data file ${file}; nothing durable to convert`);
      continue;
    }
    const source = `read_json(${quoteStringLiteral(file)})`;
    let fileRows: number;
    let fileKeys: string[];
    let liveRows: number;
    try {
      fileRows = Number(
        (await db.query(`SELECT count(*) AS n FROM ${source}`)).rows[0]?.n,
      );
      fileKeys = (await db.query(`DESCRIBE SELECT * FROM ${source}`)).rows.map(
        (row) => String(row.column_name),
      );
      liveRows = Number(
        (await db.query(`SELECT count(*) AS n FROM ${quoteIdentifier(table)}`))
          .rows[0]?.n,
      );
    } catch (error) {
      refuse(
        `its data file could not be read (${error instanceof Error ? error.message : String(error)})`,
      );
      continue;
    }
    if (fileRows !== liveRows) {
      refuse(
        `the table holds ${liveRows} rows and its data file ${fileRows}; exporting would overwrite rows the table does not hold`,
      );
      continue;
    }
    const known = new Set(
      (columnsOf.get(table) ?? []).map((name) => name.toLowerCase()),
    );
    const extra = fileKeys.filter((key) => !known.has(key.toLowerCase()));
    if (fileRows > 0 && extra.length > 0) {
      refuse(
        `its data file holds keys that are not columns of the table (${extra.join(', ')}); exporting would drop them`,
      );
      continue;
    }

    // 2. Plan the widening.
    const planned = await planDuckDbTableChanges({
      db,
      tableName: table,
      changes: columns.map((column) => ({
        type: 'type_upgrade' as const,
        table,
        name: column,
        column: { type: 'REAL' as const },
        sql: `ALTER TABLE ${quoteIdentifier(table)} ALTER COLUMN ${quoteIdentifier(column)} TYPE DOUBLE USING ${quoteIdentifier(column)}::DOUBLE`,
      })),
      mapType: () => 'DOUBLE',
    });
    const blocked = planned.changes.find(
      (change) =>
        change.kindHint === 'type.rebuild-unavailable' ||
        change.kindHint === 'column.rebuild-unavailable',
    );
    if (blocked) {
      refuse(String(blocked.sql).replace(/^\s*--\s*/, ''));
      continue;
    }
    if (options.dryRun) {
      results.push({ table, columns, outcome: 'would-convert' });
      continue;
    }
    const statements = planned.changes
      .flatMap(
        (change) => change.sqlStatements ?? (change.sql ? [change.sql] : []),
      )
      .filter((sql) => !isCommentOnlySql(sql));
    try {
      await root.transaction(async (tx) => {
        for (const sql of statements) await tx.query(sql);
      });
    } catch (error) {
      refuse(
        `the widening was rolled back (${error instanceof Error ? error.message : String(error)})`,
      );
      continue;
    }

    // 3. Persist, with the old files kept aside.
    const backup = (path: string) => `${path}.smrt-backup`;
    const saved = [file, schemaFile].filter((path) => existsSync(path));
    for (const path of saved) copyFileSync(path, backup(path));
    const restore = () => {
      for (const path of saved) copyFileSync(backup(path), path);
    };
    const discard = () => {
      for (const path of saved) rmSync(backup(path), { force: true });
    };
    try {
      await root.exportTable(table);
      // 4. A fresh handle without schemas reads what the files say.
      // Loaded here: the core root must not load the SQL adapters at boot.
      const { getDatabase } = await import('@happyvertical/sql');
      const reopened = await getDatabase({
        type: 'json',
        url: dataDir,
        writeStrategy: 'none',
        dbid: `smrt-decimal-conversion-${table}-${Date.now()}-${Math.random()}`,
      } as never);
      try {
        const schema = await reopened.getTableSchema?.(table);
        const widened = columns.every((column) =>
          /^DOUBLE$/i.test(String(schema?.columns?.[column]?.type ?? '')),
        );
        const count = Number(
          (
            await reopened.query(
              `SELECT count(*) AS n FROM ${quoteIdentifier(table)}`,
            )
          ).rows[0]?.n,
        );
        if (!widened || count !== liveRows) {
          restore();
          results.push({
            table,
            columns,
            outcome: 'failed',
            reason: `the exported table read back ${widened ? '' : 'without DOUBLE columns '}with ${count} rows (expected ${liveRows}); its files were put back`,
          });
          continue;
        }
      } finally {
        await reopened.close?.();
      }
    } catch (error) {
      restore();
      results.push({
        table,
        columns,
        outcome: 'failed',
        reason: `${error instanceof Error ? error.message : String(error)}; its files were put back`,
      });
      continue;
    } finally {
      discard();
    }
    results.push({ table, columns, outcome: 'converted' });
  }
  return results;
}
