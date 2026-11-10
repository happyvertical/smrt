/**
 * `smrt db:migrate-uuid` converts the system-table tenant columns (#3297).
 *
 * System tables never enter the manifest, so the command's declared-UUID gate
 * used to skip their TEXT `tenant_id` columns forever. It now treats the
 * change-feed and dispatch tenant columns as declared uuid (alongside a real
 * manifest), converts them in its single transaction with the same dirty-data
 * and duplicate guards as application columns, installs the tenant-type
 * agnostic change-feed helpers in that transaction, and is a no-op on rerun.
 *
 * Real PostgreSQL only (`DATABASE_URL`); the test owns a fresh database.
 */

import { randomUUID } from 'node:crypto';
import { clearCache, setConfig } from '@happyvertical/smrt-config';
import { ensureSystemTables, ObjectRegistry } from '@happyvertical/smrt-core';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { requireCommandHandler } from '../../__tests__/command-handler.js';

const { autoDiscoverAndLoadMock } = vi.hoisted(() => ({
  autoDiscoverAndLoadMock: vi.fn(),
}));

vi.mock('../../discovery/index.js', () => ({
  autoDiscoverAndLoad: autoDiscoverAndLoadMock,
}));

import { dbMigrateUuidCommand } from '../db-migrate-uuid.js';

const baseUrl = process.env.DATABASE_URL;
const describePostgres = baseUrl ? describe : describe.skip;

type Row = Record<string, unknown>;

describePostgres(
  'db:migrate-uuid system-table tenant ids (real Postgres, #3297)',
  () => {
    let databaseName = '';
    let url = '';
    const tenant = randomUUID();

    const open = () => getDatabase({ type: 'postgres', url }) as Promise<any>;
    const query = async (sql: string, ...params: unknown[]): Promise<Row[]> => {
      const db = await open();
      return ((await db.query(sql, ...params)).rows ?? []) as Row[];
    };
    const dataType = async (table: string) =>
      (
        await query(
          `SELECT data_type FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'tenant_id'`,
          table,
        )
      )[0]?.data_type;

    async function run(options: Record<string, unknown>): Promise<string> {
      const logs: string[] = [];
      const log = vi
        .spyOn(console, 'log')
        .mockImplementation((...args) => logs.push(args.join(' ')));
      const warn = vi
        .spyOn(console, 'warn')
        .mockImplementation((...args) => logs.push(args.join(' ')));
      const error = vi
        .spyOn(console, 'error')
        .mockImplementation((...args) => logs.push(args.join(' ')));
      try {
        await requireCommandHandler(dbMigrateUuidCommand)([], options);
      } finally {
        log.mockRestore();
        warn.mockRestore();
        error.mockRestore();
      }
      return logs.join('\n');
    }

    beforeAll(async () => {
      const admin = (await getDatabase({
        type: 'postgres',
        url: baseUrl as string,
      })) as any;
      databaseName = `smrt_uuid_sys_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      await admin.query(`CREATE DATABASE ${databaseName}`);
      const parsed = new URL(baseUrl as string);
      parsed.pathname = `/${databaseName}`;
      url = String(parsed);

      // A database created before #3297: system tables with TEXT tenant ids.
      const db = await open();
      await ensureSystemTables(db, 'postgres');
      for (const table of [
        '_smrt_changes',
        '_smrt_changes_pending',
        '_smrt_dispatch',
        '_smrt_dispatch_subscriptions',
      ]) {
        await db.query(
          `ALTER TABLE ${table} ALTER COLUMN tenant_id TYPE text USING tenant_id::text`,
        );
      }
      await db.query(
        `INSERT INTO _smrt_changes (seq, table_name, row_id, operation, tenant_id, created_at)
       VALUES (1, 'things', 'a', 'create', $1, now()),
              (2, 'things', 'b', 'create', NULL, now()),
              (3, 'things', 'c', 'create', '', now())`,
        tenant,
      );
      await db.query(
        `INSERT INTO _smrt_dispatch_subscriptions (id, signal_type, subscriber, tenant_id)
       VALUES ($1, 'thing.created', 'mailer', $2), ($3, 'thing.created', 'mailer', NULL)`,
        randomUUID(),
        tenant,
        randomUUID(),
      );
      // An application table whose tenants are still slugs.
      await db.query(
        'CREATE TABLE unrelated_things (id text PRIMARY KEY, tenant_id text)',
      );
      await db.query(
        "INSERT INTO unrelated_things (id, tenant_id) VALUES ($1, 'legacy-tenant-slug')",
        randomUUID(),
      );
      // A legacy non-UUID value: the column is skipped, never coerced.
      await db.query(
        `INSERT INTO _smrt_dispatch (id, type, source, tenant_id)
       VALUES ($1, 'thing.created', 'test', 'legacy-tenant-slug')`,
        randomUUID(),
      );

      clearCache();
      setConfig({
        packages: { cli: { database: { type: 'postgres', url } } },
      } as any);
      autoDiscoverAndLoadMock.mockResolvedValue({
        discovered: [],
        totalObjects: 0,
      });
      // A real manifest declares at least one UUID column; without one the
      // command fails closed and converts nothing (system columns included).
      vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockReturnValue({
        unrelated_things: {
          tableName: 'unrelated_things',
          ddl: '',
          columns: {
            id: { type: 'UUID', primaryKey: true },
            tenant_id: { type: 'UUID', referenceKind: 'tenantId' },
          },
          indexes: [],
          triggers: [],
          foreignKeys: [],
          version: '',
          dependencies: [],
        },
      } as any);
    });

    afterAll(async () => {
      vi.restoreAllMocks();
      clearCache();
      const admin = (await getDatabase({
        type: 'postgres',
        url: baseUrl as string,
      })) as any;
      if (databaseName) {
        await admin.query(
          `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`,
        );
      }
    });

    const SYSTEM = [
      '_smrt_changes',
      '_smrt_changes_pending',
      '_smrt_dispatch',
      '_smrt_dispatch_subscriptions',
    ];

    it('holds every system tenant column back while any sibling or tenant column is dirty', async () => {
      let output = await run({ 'dry-run': true });
      expect(output).toContain(
        'SKIP _smrt_dispatch.tenant_id: 1 non-uuid value',
      );
      for (const table of SYSTEM.filter((name) => name !== '_smrt_dispatch')) {
        expect(output).toMatch(
          new RegExp(
            `SKIP ${table}\\.tenant_id: system tenant columns convert together; _smrt_dispatch\\.tenant_id is not convertible`,
          ),
        );
      }

      // Resolve the dirty dispatch row the only allowed way: a proven tenant
      // or NULL (global). The application tenant column still holds a slug.
      await query(
        "UPDATE _smrt_dispatch SET tenant_id = NULL WHERE tenant_id = 'legacy-tenant-slug'",
      );
      output = await run({ 'dry-run': true });
      expect(output).toMatch(
        /system tenant columns convert together; application tenant column unrelated_things\.tenant_id is not convertible/,
      );
      // A real (non-dry) run converts nothing in this state.
      await run({});
      for (const table of SYSTEM) {
        expect(await dataType(table), table).toBe('text');
      }
    }, 60_000);

    it('converts all system tenant columns together once clean, keeps every row, and is then a no-op', async () => {
      await query(
        'UPDATE unrelated_things SET tenant_id = $1 WHERE tenant_id = $2',
        tenant,
        'legacy-tenant-slug',
      );
      // An install whose helper predates #3297 inserts the text argument
      // as-is, which a uuid column rejects; the run must replace it.
      await query(`
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
      const before = await query(
        'SELECT seq, tenant_id::text AS tenant_id FROM _smrt_changes ORDER BY seq',
      );

      const preview = await run({ 'dry-run': true });
      for (const table of SYSTEM) {
        expect(preview).toContain(
          `"${table}" ALTER COLUMN "tenant_id" TYPE uuid`,
        );
      }
      await run({});
      for (const table of SYSTEM) {
        expect(await dataType(table), table).toBe('uuid');
      }
      const after = await query(
        'SELECT seq, tenant_id::text AS tenant_id FROM _smrt_changes ORDER BY seq',
      );
      expect(after).toEqual(
        before.map((row) => ({
          ...row,
          tenant_id: row.tenant_id === '' ? null : row.tenant_id,
        })),
      );

      // The run replaced the stale helper, so appends write uuid tenants.
      const [append] = await query(
        "SELECT * FROM _smrt_append_change('things', 'd', 'update', $1, now())",
        tenant,
      );
      expect(append).toMatchObject({ error_code: null });

      const again = await run({ 'dry-run': true });
      expect(again).not.toContain('ALTER COLUMN "tenant_id"');
    }, 60_000);
  },
);
