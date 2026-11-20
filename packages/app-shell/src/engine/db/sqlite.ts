// SQLite: the desktop database, and every SQLite-only construct of the engine
// (`VACUUM INTO` snapshots and copies, `sqlite_master`, PRAGMAs, rowid). Nothing
// outside `engine/db/` may contain SQLite SQL.

import { join } from 'node:path';
import { getDatabase } from '@happyvertical/sql';

/** Open app.db of a data directory. */
export function openSqlite(dataDir: string) {
  return getDatabase({ type: 'sqlite', url: join(dataDir, 'app.db') } as any);
}

const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** One consistent standalone copy of the database at `file` (`VACUUM INTO`). */
export async function copyDatabaseTo(db: any, file: string): Promise<void> {
  await db.query(`VACUUM INTO ${literal(file)}`);
}

// ---------- portable export (portable-export.ts), SQLite only ----------

type Handle = any;
const q = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** Real tables except `skip` and SQLite's own; a virtual table is returned apart. */
export async function listTables(h: Handle, skip: string) {
  return (
    await h.query(
      `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name <> ? ORDER BY name`,
      [skip],
    )
  ).rows as Array<{ name: string; sql: string | null }>;
}

/** Stored columns only (generated columns are recomputed by the database). */
export async function storedColumns(h: Handle, table: string) {
  return (
    (
      await h.query(
        `SELECT name FROM pragma_table_xinfo(?) WHERE hidden = 0 ORDER BY cid`,
        [table],
      )
    ).rows as Array<{ name: string }>
  ).map((r) => String(r.name));
}

export async function selectAllRows(h: Handle, table: string, cols: string[]) {
  return (
    await h.query(
      `SELECT ${cols.map(q).join(', ')} FROM ${q(table)} ORDER BY rowid`,
    )
  ).rows as Array<Record<string, unknown>>;
}

export async function tableCreateSql(h: Handle, table: string) {
  return String(
    (
      await h.query(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
        [table],
      )
    ).rows[0]?.sql ?? '',
  );
}

export async function tableIndexSql(h: Handle, table: string) {
  return (
    await h.query(
      `SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name`,
      [table],
    )
  ).rows.map((r: { sql: string }) => String(r.sql));
}

export async function hasObject(h: Handle, name: string) {
  return (
    (await h.query(`SELECT 1 AS x FROM sqlite_master WHERE name = ?`, [name]))
      .rows.length > 0
  );
}

export async function integrityCheck(h: Handle) {
  return (await h.query('PRAGMA integrity_check')).rows as Array<
    Record<string, unknown>
  >;
}

export async function checkpoint(h: Handle) {
  await h.query('PRAGMA wal_checkpoint(TRUNCATE)');
}

export async function foreignKeysOff(h: Handle) {
  await h.query('PRAGMA foreign_keys = OFF');
}
