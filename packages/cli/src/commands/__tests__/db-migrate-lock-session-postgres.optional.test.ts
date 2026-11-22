/**
 * `smrt db:migrate` runs the whole migration on the connection that holds
 * the migration lock (#5435): it finishes on a pool of one connection in
 * concurrent-index mode, and when the lock's backend is terminated at a
 * writing statement the run exits non-zero naming the lost lock and commits
 * nothing. Same harness pattern as `db-migrate-concurrent-postgres.test.ts`.
 */
import { clearCache, setConfig } from '@happyvertical/smrt-config';
import {
  ObjectRegistry,
  type SchemaDefinition,
} from '@happyvertical/smrt-core';
import { MigrationTracker } from '@happyvertical/smrt-core/migrations';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requireCommandHandler } from '../../__tests__/command-handler.js';
import { parseCliCommandArgs } from '../../cli-generator.js';
import { utilityCommands } from '../utilities.js';

const pool = vi.hoisted(() => ({ max: undefined as number | undefined }));
vi.mock('@happyvertical/sql', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happyvertical/sql')>();
  let sequence = 0;
  return {
    ...actual,
    getDatabase: (options: { type: string; url: string }) =>
      actual.getDatabase({
        ...options,
        dbid: `lock5435-pool-${process.pid}-${++sequence}`,
        ...(pool.max ? { max: pool.max } : {}),
      } as Parameters<typeof actual.getDatabase>[0]),
  };
});

vi.mock('../../discovery/index.js', () => ({
  autoDiscoverAndLoad: vi.fn(async () => ({
    discovered: [
      {
        path: '/tmp/lock-session-5435/.smrt/manifest.json',
        source: 'project',
        objectCount: 2,
      },
    ],
    totalObjects: 2,
  })),
}));

const url = process.env.DATABASE_URL;
const adminUrl = process.env.SMRT_TEST_POSTGRES_ADMIN_URL ?? url;

describe.skipIf(!url)(
  'db:migrate on the lock session (real PostgreSQL, #5435)',
  () => {
    const suffix = `${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
    const existing = `ls5435_existing_${suffix}`;
    const created = `ls5435_created_${suffix}`;
    const spies: Array<ReturnType<typeof vi.spyOn>> = [];
    const handles: any[] = [];

    async function connect(target = url as string): Promise<any> {
      pool.max = undefined;
      const db = await getDatabase({ type: 'postgres', url: target });
      handles.push(db);
      return db;
    }

    function schemas(): Record<string, SchemaDefinition> {
      return {
        [existing]: {
          tableName: existing,
          columns: {
            id: { type: 'UUID', primaryKey: true },
            note: { type: 'TEXT' },
          },
          indexes: [],
          triggers: [],
          foreignKeys: [],
          version: '5435-test',
          dependencies: [],
        },
        [created]: {
          tableName: created,
          columns: {
            id: { type: 'UUID', primaryKey: true },
            label: { type: 'TEXT' },
          },
          indexes: [{ name: `${created}_label_idx`, columns: ['label'] }],
          triggers: [],
          foreignKeys: [],
          version: '5435-test',
          dependencies: [],
        },
      } as Record<string, SchemaDefinition>;
    }

    function installManifest(): void {
      const all = schemas();
      const tableNames = Object.keys(all);
      const classNames = tableNames.map((tableName) => `Test_${tableName}`);
      const tableByClass = new Map(
        classNames.map((className, index) => [className, tableNames[index]]),
      );
      spies.push(
        vi
          .spyOn(ObjectRegistry, 'getInitializationOrder')
          .mockReturnValue(classNames),
        vi
          .spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions')
          .mockReturnValue(all),
        vi
          .spyOn(ObjectRegistry, 'getTableName')
          .mockImplementation(
            (className: string) => tableByClass.get(className) ?? className,
          ),
      );
    }

    async function run(flags: string[] = []) {
      const command = utilityCommands['db:migrate'];
      const parsed = parseCliCommandArgs(['db:migrate', ...flags], [command]);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      process.exitCode = undefined;
      try {
        await requireCommandHandler(command)(parsed.args, parsed.options);
        return {
          stderr: errorSpy.mock.calls.map((call) => call.join(' ')).join('\n'),
          exitCode: process.exitCode,
        };
      } finally {
        process.exitCode = undefined;
        logSpy.mockRestore();
        errorSpy.mockRestore();
        warnSpy.mockRestore();
      }
    }

    async function columns(table: string): Promise<string[]> {
      const db = await connect();
      const result = await db.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
        table,
      );
      return result.rows.map((row: { column_name: string }) => row.column_name);
    }

    beforeEach(async () => {
      clearCache();
      setConfig({
        packages: { cli: { database: { type: 'postgres', url } } },
      } as any);
      const db = await connect();
      for (const table of [existing, created])
        await db.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
      await db.query(`CREATE TABLE "${existing}" (id UUID PRIMARY KEY)`);
      await new MigrationTracker({ db }).initialize();
      installManifest();
    });

    afterEach(async () => {
      for (const spy of spies.splice(0)) spy.mockRestore();
      try {
        const db = await connect();
        for (const table of [existing, created])
          await db.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
      } finally {
        for (const handle of handles.splice(0)) await handle.close?.();
        pool.max = undefined;
        clearCache();
        vi.restoreAllMocks();
      }
    });

    it('finishes a concurrent-index run on a pool of one connection (A43)', async () => {
      pool.max = 1;
      const result = await run(['--postgres-safe']);
      pool.max = undefined;
      expect(result.stderr).not.toContain('Migration failed');
      expect(result.exitCode).toBeUndefined();
      expect(await columns(existing)).toContain('note');
      const db = await connect();
      const index = await db.query(
        `SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = $1`,
        `${created}_label_idx`,
      );
      expect(
        index.rows.map((row: { indisvalid: boolean }) => row.indisvalid),
      ).toEqual([true]);
    }, 60_000);

    it('exits non-zero naming the lost lock, and commits nothing, when the lock backend ends at a writing statement (A44)', async () => {
      const admin = await connect(adminUrl as string);
      const barrier = await admin.beginTransaction();
      await barrier.query(`LOCK TABLE "${existing}" IN ACCESS SHARE MODE`);
      const running = run();
      let pid: number | undefined;
      for (let attempt = 0; attempt < 400 && pid === undefined; attempt++) {
        const waiting = await admin.query(
          `SELECT pid, query FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE $1`,
          `%ALTER TABLE%${existing}%ADD COLUMN%`,
        );
        if (waiting.rows.length) {
          const holder = await admin.query(
            `SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted AND objsubid = 2 AND classid = (hashtext('smrt'))::oid AND objid = (hashtext('db:migrate'))::oid`,
          );
          pid = holder.rows[0]?.pid;
        }
        if (pid === undefined) await new Promise((r) => setTimeout(r, 50));
      }
      expect(pid).toBeDefined();
      await admin.query(`SELECT pg_terminate_backend($1)`, pid);
      const result = await running;
      await barrier.commit();
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/migration lock was lost/i);
      expect(await columns(existing)).not.toContain('note');
    }, 60_000);
  },
);
