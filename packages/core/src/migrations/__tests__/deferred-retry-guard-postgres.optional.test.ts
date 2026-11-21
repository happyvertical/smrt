/**
 * Retrying a `--postgres-safe` migration's deferred phase on a real PostgreSQL
 * server with a connection pool (#5325): one run at a time per migration,
 * across connections; deferred statements may not change session state, and
 * the tracker's own settings never reach the pool's next checkout.
 *
 * Runs only in the PostgreSQL lane (`DATABASE_URL` / `SMRT_TEST_POSTGRES_URL`).
 */

import { randomUUID } from 'node:crypto';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MigrationDefinition } from '../../schema/types.js';
import { MigrationTracker } from '../tracker.js';

const pgUrl = process.env.DATABASE_URL ?? process.env.SMRT_TEST_POSTGRES_URL;

describe.skipIf(!pgUrl)(
  'retrying a deferred phase on a pooled server (real PostgreSQL)',
  () => {
    let admin: DatabaseInterface;
    const databases: string[] = [];
    const handles: DatabaseInterface[] = [];

    async function freshDatabase(): Promise<DatabaseInterface> {
      const name = `smrt_retry_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      await admin.query(`CREATE DATABASE ${name}`);
      databases.push(name);
      await admin.query(
        `ALTER DATABASE ${name} SET search_path = app_ns, public`,
      );
      const url = new URL(pgUrl as string);
      url.pathname = `/${name}`;
      const db = (await getDatabase({
        type: 'postgres',
        url: String(url),
        dbid: `retry-${randomUUID()}`,
      } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
      handles.push(db);
      await db.query('CREATE SCHEMA app_ns');
      await db.query('CREATE SCHEMA other_ns');
      for (const schema of ['app_ns', 'other_ns'])
        await db.query(`CREATE TABLE ${schema}.items (id INT, v INT)`);
      return db;
    }

    const definition = (id: string, up: string[]): MigrationDefinition => ({
      id,
      description: id,
      version: '1.0.0',
      up,
      down: [],
    });

    const migrate = (db: DatabaseInterface, defs: MigrationDefinition[]) =>
      new MigrationTracker({ db, useConcurrentIndexes: true }).applyAll(defs, {
        atomic: true,
        postgresSafe: true,
        reconcile: true,
      });

    const errorOf = (result: { error?: unknown } | undefined) =>
      result?.error instanceof Error
        ? result.error.message
        : String(result?.error ?? '');

    const indexSchemas = async (db: DatabaseInterface, name: string) =>
      (
        await db.query(
          `SELECT n.nspname AS schema FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relname = ? ORDER BY 1`,
          name,
        )
      ).rows.map((row) => row.schema);

    const validated = (id: string, extra: string[] = []) =>
      definition(id, [
        'ALTER TABLE items ADD CONSTRAINT items_v_check CHECK (v >= 0) NOT VALID',
        'ALTER TABLE items VALIDATE CONSTRAINT items_v_check',
        ...extra,
      ]);

    beforeAll(async () => {
      admin = (await getDatabase({
        type: 'postgres',
        url: pgUrl as string,
      })) as DatabaseInterface;
    });

    afterAll(async () => {
      for (const handle of handles) await handle.close?.();
      for (const name of databases)
        await admin?.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin?.close?.();
    });

    it('refuses a retry while another connection runs the same migration', async () => {
      const db = await freshDatabase();
      await db.query('INSERT INTO app_ns.items VALUES (1, 1), (1, 2)');
      const def = definition('held_retry', [
        'ALTER TABLE items ADD CONSTRAINT items_v_check CHECK (v >= 0) NOT VALID',
        'ALTER TABLE items VALIDATE CONSTRAINT items_v_check',
        'CREATE UNIQUE INDEX IF NOT EXISTS items_id_uq ON items (id)',
      ]);
      const [first] = await migrate(db, [def]);
      expect(first?.success).toBe(false);
      await db.query('DELETE FROM app_ns.items WHERE v = 2');
      await db.query('DROP INDEX IF EXISTS app_ns.items_id_uq');
      const { id } = (
        await db.query(
          "SELECT id FROM _smrt_schema_migrations WHERE name = 'held_retry'",
        )
      ).rows[0] as { id: string };

      const holder = await db.acquireSession?.();
      if (!holder) throw new Error('the adapter must pin a session');
      try {
        await holder.query(
          'SELECT pg_advisory_lock(hashtextextended(?, 0))',
          `smrt:migration-deferred:${id}`,
        );

        const [blocked] = await migrate(db, [def]);

        expect(blocked?.success).toBe(false);
        expect(errorOf(blocked)).toContain('another run');
        expect(await indexSchemas(db, 'items_id_uq')).toEqual([]);
      } finally {
        await holder.release();
      }

      const [retry] = await migrate(db, [def]);
      expect(retry?.success, errorOf(retry)).toBe(true);
      expect(await indexSchemas(db, 'items_id_uq')).toEqual(['app_ns']);
    });

    it('refuses a deferred path change before anything runs', async () => {
      const db = await freshDatabase();

      await expect(
        migrate(db, [
          validated('path_switch', ['SET search_path TO other_ns, public']),
        ]),
      ).rejects.toThrow(/changes session state/);
      expect(
        (
          await db.query(
            "SELECT 1 FROM pg_constraint WHERE conname = 'items_v_check'",
          )
        ).rows,
      ).toEqual([]);
    });

    it('hands the pool no connection with the tracker settings', async () => {
      const db = await freshDatabase();
      const read = async () => {
        const found = (
          await db.query(
            "SELECT current_setting('search_path') AS p, current_setting('lock_timeout') AS l",
          )
        ).rows[0];
        return `${found?.p}|${found?.l}`;
      };
      const before = await read();

      const [result] = await migrate(db, [
        validated('path_pool', [
          'CREATE INDEX IF NOT EXISTS items_v_idx ON items (v)',
        ]),
      ]);

      expect(result?.success, errorOf(result)).toBe(true);
      const sessions = await Promise.all(Array.from({ length: 8 }, read));
      expect(before.startsWith('app_ns, public|')).toBe(true);
      expect(new Set(sessions)).toEqual(new Set([before]));
    });
  },
);
