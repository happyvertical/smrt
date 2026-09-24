/**
 * PostgreSQL fixtures for the #3098 lane: a disposable database per test
 * (the lane commits DDL and data) and a catalog helper to inspect foreign
 * keys. Mirrors smrt-ledgers' lane fixture.
 */
import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';

type Hook = (fn: () => Promise<void>, timeout?: number) => void;

/** Creating and dropping a database outlasts this package's hook default. */
const HOOK_TIMEOUT_MS = 60_000;

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
    databaseName = `smrt_messages_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    await admin.query(`CREATE DATABASE ${databaseName}`);
  }, HOOK_TIMEOUT_MS);

  afterEach(async () => {
    for (const db of connections.splice(0)) {
      await (db as { close?: () => Promise<void> }).close?.();
    }
    await admin?.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await (admin as { close?: () => Promise<void> } | undefined)?.close?.();
  }, HOOK_TIMEOUT_MS);

  const url = (): string => {
    const scratch = new URL(baseUrl);
    scratch.pathname = `/${databaseName}`;
    return String(scratch);
  };

  return {
    url,
    /** Track a connection so it is closed before the database is dropped. */
    track(db: DatabaseInterface): DatabaseInterface {
      connections.push(db);
      return db;
    },
    /** A connection to this test's database with every registered schema. */
    async database(): Promise<DatabaseInterface> {
      const db = await getTestDatabase({ type: 'postgres', url: url() });
      connections.push(db);
      return db;
    },
  };
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
