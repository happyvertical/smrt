/**
 * App model journal ownership on real PostgreSQL (#5435): the journal lives
 * in `public`, and the ownership read finds it there whatever `search_path`
 * puts first; the public history store's transaction keeps the role's
 * isolation and never waits for a migrate run. Needs
 * `SMRT_TEST_POSTGRES_URL`; each case works in a database of its own.
 */
import { randomUUID } from 'node:crypto';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATION_ADVISORY_LOCK_KEYS } from '../../migrations/migration-lock.js';
import { journalListTables } from '../app-model-claims.js';
import { createAppModelHistory } from '../model-history.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const adminUrl =
  process.env.SMRT_TEST_POSTGRES_ADMIN_URL ??
  process.env.SMRT_TEST_POSTGRES_URL;
const TENANT = '44444444-4444-4444-8444-444444444444';

describe.skipIf(!pgUrl)('journal ownership on PostgreSQL', () => {
  let admin: DatabaseInterface;
  const databases: string[] = [];
  const handles: DatabaseInterface[] = [];

  const createDatabase = async () => {
    const name = `smrt_journal_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const parsed = new URL(pgUrl as string);
    const owner = `"${decodeURIComponent(parsed.username).replace(/"/g, '""')}"`;
    await admin.query(`CREATE DATABASE ${name} OWNER ${owner}`);
    databases.push(name);
    parsed.pathname = `/${name}`;
    return { name, url: String(parsed) };
  };
  const connect = async (url: string) => {
    const db = await getDatabase({
      type: 'postgres',
      url,
      dbid: randomUUID(),
    } as Parameters<typeof getDatabase>[0]);
    handles.push(db);
    return db;
  };

  beforeAll(async () => {
    admin = await getDatabase({ type: 'postgres', url: adminUrl as string });
  });
  afterAll(async () => {
    for (const handle of handles) await handle.close?.();
    for (const name of databases)
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.close?.();
  });

  it('finds a committed list claim in public with an application schema first in search_path', async () => {
    const { name, url } = await createDatabase();
    const setup = await connect(url);
    await createAppModelHistory({
      db: setup,
      application: 'journal-schema',
      tenantId: TENANT,
    });
    const doc = JSON.stringify({
      models: { packageName: '@journal/app', lists: { Desks: {} } },
    });
    await setup.query(
      `INSERT INTO public._smrt_app_model_changes (application, tenant_id, revision, request_id, actor, command, before_doc, after_doc, status) VALUES ('journal-schema', '${TENANT}', 1, 'r1', 'a', '{}', '{}', '${doc}', 'applied')`,
    );
    await setup.query('CREATE SCHEMA app');
    await setup.query(`ALTER DATABASE ${name} SET search_path = app, public`);

    const fresh = await connect(url);
    const schema = await fresh.query('SELECT current_schema() AS s');
    expect(schema.rows[0].s).toBe('app');
    const claims = await journalListTables(fresh, undefined, 'postgres');
    expect(claims.get('desks')).toBe('@journal/app:Desks');
    // Another journal's view excludes only its own claims.
    const elsewhere = await journalListTables(
      fresh,
      { application: 'other', tenantId: TENANT },
      'postgres',
    );
    expect(elsewhere.has('desks')).toBe(true);
  }, 60_000);

  it('runs a history store transaction at the role isolation without waiting for a migrate run', async () => {
    const { name, url } = await createDatabase();
    const setup = await connect(url);
    await setup.query(
      `ALTER DATABASE ${name} SET default_transaction_isolation = 'serializable'`,
    );
    const holder = await connect(url);
    const session = await holder.acquireSession!();
    await session.query(
      `SELECT pg_advisory_lock(${MIGRATION_ADVISORY_LOCK_KEYS})`,
    );
    try {
      const db = await connect(url);
      const store = await createAppModelHistory({
        db,
        application: 'journal-isolation',
        tenantId: TENANT,
      });
      const started = Date.now();
      const isolation = await store.transaction!(async (_scoped, tx) => {
        const { rows } = await tx.query('SHOW transaction_isolation');
        return rows[0].transaction_isolation;
      });
      expect(isolation).toBe('serializable');
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await session.release();
    }
  }, 60_000);
});
