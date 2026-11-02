/**
 * PostgreSQL system-table tenant ids (#3297), against a real server.
 *
 * Fresh databases create the change-feed and dispatch tenant columns as native
 * uuid. The change-feed helpers coerce each tenant id to the LIVE column type,
 * so one body serves a legacy TEXT install, a converted uuid install, and the
 * mixed state in between (a TEXT staging row drained into a uuid feed). A
 * helper body that predates the coercion is replaced by the current one, and
 * the current body still carries the previous marker so an older process
 * keeps it during a rolling upgrade.
 *
 * Runs only when `SMRT_TEST_POSTGRES_URL` is set; it creates and drops its own
 * database.
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  drainChangeFeed,
  ensurePostgresChangeFeedAppendFunction,
  getChangesSince,
} from '../change-feed';
import { ensureSystemTables } from '../system/bootstrap';
import {
  POSTGRES_CHANGE_FEED_HELPER_COMPAT_MARKER,
  POSTGRES_CHANGE_FEED_HELPER_MARKER,
} from '../system/schema';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;

type Row = Record<string, unknown>;
const rows = (result: unknown): Row[] =>
  ((result as { rows?: Row[] }).rows ?? []) as Row[];

describe.skipIf(!pgUrl)(
  'system-table tenant uuid on PostgreSQL (optional, #3297)',
  () => {
    let admin: DatabaseInterface;
    let db: DatabaseInterface;
    let databaseName = '';
    const tenant = randomUUID();

    const dataType = async (table: string, column: string) =>
      rows(
        await db.query(
          `SELECT data_type FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
          table,
          column,
        ),
      )[0]?.data_type;

    const appendInline = async (tenantId: string | null) =>
      rows(
        await db.query(
          'SELECT * FROM _smrt_append_change($1, $2, $3, $4, now())',
          'things',
          randomUUID(),
          'update',
          tenantId,
        ),
      )[0];

    /** Append inside a write transaction: the helper stages, a drain sequences. */
    const appendStaged = async (tenantId: string | null) => {
      let result: Row | undefined;
      const transaction = db.transaction;
      if (typeof transaction !== 'function') {
        throw new Error(
          'This spec requires a transactional PostgreSQL handle.',
        );
      }
      await transaction.call(db, (async (tx: DatabaseInterface) => {
        await tx.query('SELECT pg_current_xact_id()');
        result = rows(
          await tx.query(
            'SELECT * FROM _smrt_append_change($1, $2, $3, $4, now())',
            'things',
            randomUUID(),
            'update',
            tenantId,
          ),
        )[0];
      }) as never);
      return result;
    };

    const appendBatch = async (tenantId: string | null) =>
      rows(
        await db.query(
          'SELECT * FROM _smrt_append_changes($1::jsonb)',
          JSON.stringify([
            {
              table: 'things',
              rowId: randomUUID(),
              operation: 'create',
              tenantId,
              timestamp: new Date().toISOString(),
            },
          ]),
        ),
      )[0];

    const feedTenants = async () =>
      (await getChangesSince(db, { since: 0, limit: 1000 })).changes.map(
        (entry) => entry.tenantId ?? null,
      );

    beforeAll(async () => {
      admin = await getDatabase({ type: 'postgres', url: pgUrl as string });
      databaseName = `smrt_3297_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      await admin.query(`CREATE DATABASE ${databaseName}`);
      const url = new URL(pgUrl as string);
      url.pathname = `/${databaseName}`;
      db = await getDatabase({
        type: 'postgres',
        url: String(url),
        dbid: `issue-3297-${databaseName}`,
      } as Parameters<typeof getDatabase>[0]);
      await ensureSystemTables(db, 'postgres');
    });

    afterAll(async () => {
      await (db as { close?: () => Promise<void> } | undefined)?.close?.();
      if (databaseName) {
        await admin?.query(
          `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`,
        );
      }
      await (admin as { close?: () => Promise<void> } | undefined)?.close?.();
    });

    it('creates the change-feed and dispatch tenant columns as native uuid', async () => {
      for (const table of [
        '_smrt_changes',
        '_smrt_changes_pending',
        '_smrt_dispatch',
        '_smrt_dispatch_subscriptions',
      ]) {
        expect(await dataType(table, 'tenant_id'), table).toBe('uuid');
      }
      // Scope keys and caller-supplied tenant strings stay text.
      expect(await dataType('_smrt_run_once_claims', 'tenant_id')).toBe('text');
      expect(await dataType('_smrt_ai_usage', 'tenant_id')).toBe('text');
      expect(await dataType('_smrt_contexts', 'owner_id')).toBe('text');
    });

    it('appends, stages, batches and drains tenant ids into uuid columns', async () => {
      expect(await appendInline(tenant)).toMatchObject({ error_code: null });
      expect(await appendInline('')).toMatchObject({ error_code: null });
      expect(await appendStaged(tenant)).toMatchObject({
        allocated_seq: null,
        error_code: null,
      });
      expect(await appendBatch(tenant)).toMatchObject({ error_code: null });
      expect(await drainChangeFeed(db)).toBe(1);

      const tenants = await feedTenants();
      expect(tenants.filter((value) => value === tenant)).toHaveLength(3);
      // An empty-string tenant is stored as NULL, as the TypeScript writers do.
      expect(tenants).toContain(null);
      const scoped = await getChangesSince(db, {
        since: 0,
        limit: 1000,
        tenantId: tenant,
      });
      expect(scoped.changes.length).toBeGreaterThanOrEqual(3);
      expect(
        rows(
          await db.query(
            'SELECT count(*)::int AS n FROM _smrt_changes WHERE tenant_id = $1::uuid',
            tenant,
          ),
        )[0]?.n,
      ).toBe(3);
    });

    it('serves a legacy TEXT install and the mixed state while it converts', async () => {
      // Back to the pre-#3297 shape, with the same (current) helper bodies.
      for (const table of ['_smrt_changes', '_smrt_changes_pending']) {
        await db.query(
          `ALTER TABLE ${table} ALTER COLUMN tenant_id TYPE text USING tenant_id::text`,
        );
      }
      expect(await appendInline(tenant)).toMatchObject({ error_code: null });
      expect(await appendStaged(tenant)).toMatchObject({ error_code: null });

      // Feed converted first, staging still TEXT: the staged row drains.
      await db.query(
        `ALTER TABLE _smrt_changes ALTER COLUMN tenant_id TYPE uuid USING NULLIF(btrim(tenant_id), '')::uuid`,
      );
      expect(await drainChangeFeed(db)).toBe(1);
      expect(await appendStaged(tenant)).toMatchObject({ error_code: null });
      await db.query(
        `ALTER TABLE _smrt_changes_pending ALTER COLUMN tenant_id TYPE uuid USING NULLIF(btrim(tenant_id), '')::uuid`,
      );
      expect(await drainChangeFeed(db)).toBe(1);
      expect(await appendBatch(tenant)).toMatchObject({ error_code: null });
      expect(
        (await feedTenants()).filter((value) => value === tenant),
      ).toHaveLength(7);
    });

    it('replaces a helper body that predates the coercion and keeps the previous marker', async () => {
      // A pre-#3297 style body inserts the text argument as-is.
      await db.query(`
        CREATE OR REPLACE FUNCTION _smrt_append_change(
          p_table_name TEXT, p_row_id TEXT, p_operation TEXT,
          p_tenant_id TEXT, p_created_at TIMESTAMPTZ
        ) RETURNS TABLE(allocated_seq BIGINT, error_code TEXT, error_message TEXT)
        LANGUAGE plpgsql AS $stale$
        DECLARE v_seq BIGINT;
        BEGIN
          BEGIN
            INSERT INTO _smrt_changes (seq, table_name, row_id, operation, tenant_id, created_at)
            SELECT COALESCE(MAX(seq), 0) + 1, p_table_name, p_row_id, p_operation, p_tenant_id, p_created_at
            FROM _smrt_changes RETURNING _smrt_changes.seq INTO v_seq;
            RETURN QUERY SELECT v_seq, NULL::TEXT, NULL::TEXT;
          EXCEPTION WHEN OTHERS THEN
            RETURN QUERY SELECT NULL::BIGINT, SQLSTATE::TEXT, SQLERRM::TEXT;
          END;
        END;
        $stale$`);
      expect((await appendInline(tenant))?.error_code).toBe('42804');

      await ensurePostgresChangeFeedAppendFunction(db, {
        typeHint: 'postgres',
      });
      expect(await appendInline(tenant)).toMatchObject({ error_code: null });
      const source = String(
        rows(
          await db.query(
            "SELECT prosrc FROM pg_proc WHERE proname = '_smrt_append_change'",
          ),
        )[0]?.prosrc,
      );
      expect(source).toContain(POSTGRES_CHANGE_FEED_HELPER_MARKER);
      // An older process probes for the previous marker and keeps this body.
      expect(source).toContain(POSTGRES_CHANGE_FEED_HELPER_COMPAT_MARKER);
    });
  },
);
