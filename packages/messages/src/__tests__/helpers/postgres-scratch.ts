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
  let cleanupAdmin: DatabaseInterface | undefined;
  let createdBy = '';
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
    createdBy = String(
      (await admin.query('SELECT current_user AS owner')).rows[0]?.owner ?? '',
    );
    if (!createdBy) throw new Error('Scratch database owner is unknown.');
    databaseName = `smrt_messages_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    await admin.query(`CREATE DATABASE ${databaseName}`);
  }, HOOK_TIMEOUT_MS);

  afterEach(async () => {
    // Settle every owned handle even if one close fails; never leave the rest open.
    const closed = await Promise.allSettled(
      connections
        .splice(0)
        .map((db) => (db as { close?: () => Promise<void> }).close?.()),
    );
    const failures: unknown[] = closed.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    try {
      const cleanupUrl = process.env.SMRT_TEST_POSTGRES_ADMIN_URL;
      if (cleanupUrl) {
        const runtime = new URL(baseUrl),
          control = new URL(cleanupUrl);
        if (
          runtime.protocol !== control.protocol ||
          runtime.host !== control.host
        )
          throw new Error(
            'Scratch cleanup administrator must belong to the test PostgreSQL cluster.',
          );
        cleanupAdmin = await getTestDatabase({
          type: 'postgres',
          url: cleanupUrl,
          classes: [],
          includeSystemTables: false,
        });
      }
      const owner = cleanupAdmin ?? admin;
      if (owner && databaseName) {
        if (!/^smrt_messages_[a-f0-9]{16}$/.test(databaseName))
          throw new Error('Unowned scratch database name.');
        const inventory = await owner.query(
          'SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=?',
          databaseName,
        );
        if (inventory.rows.length && inventory.rows[0]?.owner !== createdBy)
          throw new Error(
            'Scratch database ownership changed; cleanup refused.',
          );
        // The documented administrator is cleanup-only. Application/schema tests retain their test role.
        await owner.query(
          `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`,
        );
      }
    } catch (failure) {
      failures.push(failure);
    }
    const released = await Promise.allSettled(
      [
        ...new Set(
          [cleanupAdmin, admin].filter((db): db is DatabaseInterface =>
            Boolean(db),
          ),
        ),
      ].map((db) => (db as { close?: () => Promise<void> }).close?.()),
    );
    for (const result of released)
      if (result.status === 'rejected') failures.push(result.reason);
    admin = undefined;
    cleanupAdmin = undefined;
    if (failures.length)
      throw new AggregateError(failures, 'Scratch database cleanup failed.');
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
