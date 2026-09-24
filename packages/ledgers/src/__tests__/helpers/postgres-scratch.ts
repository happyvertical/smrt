/**
 * PostgreSQL fixtures for the #3098 lanes: a disposable database per test
 * (the lanes commit DDL and data) and catalog helpers to build and inspect the
 * pre-#3098 legacy state.
 */
import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';

type Hook = (fn: () => Promise<void>) => void;

export function withScratchDatabase(beforeEach: Hook, afterEach: Hook) {
  const connections: DatabaseInterface[] = [];
  let admin: DatabaseInterface | undefined;
  let baseUrl = '';
  let databaseName = '';

  beforeEach(async () => {
    baseUrl = process.env.DATABASE_URL ?? '';
    admin = await getTestDatabase({
      type: 'postgres',
      url: baseUrl,
      classes: [],
      includeSystemTables: false,
    });
    databaseName = `smrt_ledgers_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    await admin.query(`CREATE DATABASE ${databaseName}`);
  });

  afterEach(async () => {
    for (const db of connections.splice(0)) {
      await (db as { close?: () => Promise<void> }).close?.();
    }
    await admin?.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await (admin as { close?: () => Promise<void> } | undefined)?.close?.();
  });

  return {
    /** A connection to this test's database with every registered schema. */
    async database(): Promise<DatabaseInterface> {
      const url = new URL(baseUrl);
      url.pathname = `/${databaseName}`;
      const db = await getTestDatabase({ type: 'postgres', url: String(url) });
      connections.push(db);
      return db;
    },
  };
}

/** Rename a table and the indexes named after it, as a legacy build named them. */
export async function renameTableWithIndexes(
  db: DatabaseInterface,
  from: string,
  to: string,
): Promise<void> {
  await db.query(`ALTER TABLE "${from}" RENAME TO "${to}"`);
  const indexes = await db.query(
    `SELECT indexname FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename = ?`,
    to,
  );
  for (const { indexname } of indexes.rows as Array<{ indexname: string }>) {
    if (!indexname.startsWith(`${from}_`)) continue;
    await db.query(
      `ALTER INDEX "${indexname}" RENAME TO "${to}_${indexname.slice(from.length + 1)}"`,
    );
  }
}

/** The tables a column's foreign-key constraints reference. */
export async function foreignKeyTargets(
  db: DatabaseInterface,
  table: string,
  column: string,
): Promise<string[]> {
  const result = await db.query(
    `SELECT target.relname AS target
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_class target ON target.oid = con.confrelid
       JOIN pg_attribute att
         ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
      WHERE con.contype = 'f' AND rel.relname = ? AND att.attname = ?
      ORDER BY target.relname`,
    table,
    column,
  );
  return (result.rows as Array<{ target: string }>).map((row) => row.target);
}
