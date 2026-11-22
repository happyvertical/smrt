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

// ---------- portable export: the pragmas (the tables: sqlite-portable.ts) ----------

type Handle = any;

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
