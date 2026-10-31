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
          columns: { id: { type: 'UUID', primaryKey: true } },
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

    it('previews the system tenant columns without converting them', async () => {
      const output = await run({ 'dry-run': true });
      for (const table of [
        '_smrt_changes',
        '_smrt_changes_pending',
        '_smrt_dispatch_subscriptions',
      ]) {
        expect(output).toContain(
          `"${table}" ALTER COLUMN "tenant_id" TYPE uuid`,
        );
      }
      // A legacy non-UUID tenant value is reported, not coerced.
      expect(output).toContain(
        'SKIP _smrt_dispatch.tenant_id: 1 non-uuid value',
      );
      expect(await dataType('_smrt_changes')).toBe('text');
    }, 60_000);

    it('converts clean columns, skips the dirty one, keeps every row, and is then a no-op', async () => {
      const before = await query(
        'SELECT seq, tenant_id::text AS tenant_id FROM _smrt_changes ORDER BY seq',
      );
      const output = await run({});
      expect(output).toMatch(/_smrt_dispatch\.tenant_id/);

      expect(await dataType('_smrt_changes')).toBe('uuid');
      expect(await dataType('_smrt_changes_pending')).toBe('uuid');
      expect(await dataType('_smrt_dispatch_subscriptions')).toBe('uuid');
      expect(await dataType('_smrt_dispatch')).toBe('text');

      const after = await query(
        'SELECT seq, tenant_id::text AS tenant_id FROM _smrt_changes ORDER BY seq',
      );
      expect(after).toEqual(
        before.map((row) => ({
          ...row,
          tenant_id: row.tenant_id === '' ? null : row.tenant_id,
        })),
      );
      expect(
        await query(
          "SELECT tenant_id FROM _smrt_dispatch WHERE tenant_id = 'legacy-tenant-slug'",
        ),
      ).toHaveLength(1);

      // The change-feed helpers write into the converted columns.
      const [append] = await query(
        "SELECT * FROM _smrt_append_change('things', 'd', 'update', $1, now())",
        tenant,
      );
      expect(append).toMatchObject({ error_code: null });
      expect(
        String(
          (
            await query(
              "SELECT prosrc FROM pg_proc WHERE proname = '_smrt_append_change'",
            )
          )[0]?.prosrc,
        ),
      ).toContain('jsonb_populate_record');

      const again = await run({ 'dry-run': true });
      expect(again).not.toContain('"_smrt_changes" ALTER COLUMN');
      expect(await dataType('_smrt_dispatch')).toBe('text');
    }, 60_000);
  },
);
