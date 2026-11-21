/**
 * #5325: `db:migrate` retrying a migration whose deferred `--postgres-safe`
 * phase partly committed. A retry in another mode follows another plan, so it
 * is refused: the batch-wide `--force` does not lift that, the targeted
 * `--force-migration` does, and the same mode retries normally.
 */
import { clearCache, setConfig } from '@happyvertical/smrt-config';
import {
  ObjectRegistry,
  type SchemaDefinition,
} from '@happyvertical/smrt-core';
import { MigrationTracker } from '@happyvertical/smrt-core/migrations';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requireCommandHandler } from '../../__tests__/command-handler.js';
import { utilityCommands } from '../utilities.js';

vi.mock('../../discovery/index.js', () => ({
  autoDiscoverAndLoad: vi.fn(async () => ({
    discovered: [
      { path: '/fake/.smrt/manifest.json', source: 'project', objectCount: 1 },
    ],
    totalObjects: 1,
  })),
}));
vi.mock('@happyvertical/sql', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happyvertical/sql')>();
  let sequence = 0;
  return {
    ...actual,
    getDatabase: (options: Parameters<typeof actual.getDatabase>[0]) =>
      actual.getDatabase({
        ...options,
        dbid: `5325-${process.pid}-${++sequence}`,
      }),
  };
});
const pgUrl = process.env.SMRT_TEST_POSTGRES_URL ?? process.env.DATABASE_URL;

describe.skipIf(!pgUrl)(
  'db:migrate retry of a partly committed deferred phase (#5325, PostgreSQL)',
  () => {
    const suffix = `${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
    const table = `retry5325_${suffix}`;
    const index = `${table}_title_unique`;
    let db: DatabaseInterface;
    let logs: ReturnType<typeof vi.spyOn>;
    let errors: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
      db = await getDatabase({ type: 'postgres', url: pgUrl });
      await db.query(
        `CREATE TABLE "${table}" (id TEXT PRIMARY KEY, title TEXT)`,
      );
      await new MigrationTracker({ db }).initialize();
      const schemas: Record<string, SchemaDefinition> = {
        [table]: {
          tableName: table,
          columns: {
            id: { type: 'TEXT', primaryKey: true },
            title: { type: 'TEXT' },
          },
          indexes: [{ name: index, columns: ['title'], unique: true }],
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: '5325',
        },
      };
      clearCache();
      setConfig({
        packages: { cli: { database: { type: 'postgres', url: pgUrl } } },
      });
      vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockImplementation(
        () => schemas,
      );
      vi.spyOn(ObjectRegistry, 'getInitializationOrder').mockReturnValue(
        Object.keys(schemas),
      );
      vi.spyOn(ObjectRegistry, 'getTableName').mockImplementation(
        (name: string) => name,
      );
      logs = vi.spyOn(console, 'log').mockImplementation(() => {});
      errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      process.exitCode = undefined;
    });
    afterEach(async () => {
      await db.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
      await db.query(
        'DELETE FROM _smrt_schema_migrations WHERE name LIKE ?',
        `%${table}%`,
      );
      await db.close?.();
      clearCache();
      vi.restoreAllMocks();
      process.exitCode = undefined;
    });

    async function run(options: Record<string, unknown>) {
      process.exitCode = undefined;
      logs.mockClear();
      errors.mockClear();
      await requireCommandHandler(utilityCommands['db:migrate'])([], options);
      const output = [...logs.mock.calls, ...errors.mock.calls]
        .map((c) => c.join(' '))
        .join('\n');
      return { output, exitCode: process.exitCode };
    }

    async function migrationName() {
      const rows = (
        await db.query(
          "SELECT name FROM _smrt_schema_migrations WHERE name LIKE ? AND status = 'failed'",
          `%${index}%`,
        )
      ).rows;
      expect(rows).toHaveLength(1);
      return String(rows[0]?.name);
    }

    const indexValidity = async () =>
      (
        await db.query(
          'SELECT indisvalid AS valid FROM pg_index JOIN pg_class ON pg_class.oid = indexrelid WHERE relname = ?',
          index,
        )
      ).rows.map((row) => row.valid);

    it('refuses a retry in another mode under --force, and runs it under --force-migration', async () => {
      await db.query(
        `INSERT INTO "${table}" VALUES ('a', 'same'), ('b', 'same')`,
      );
      const first = await run({ 'postgres-safe': true });
      expect(first.exitCode, first.output).toBe(1);
      const name = await migrationName();
      await db.query(
        `UPDATE "${table}" SET title = 'different' WHERE id = 'b'`,
      );

      const forced = await run({ force: true });

      expect(forced.exitCode, forced.output).toBe(1);
      expect(forced.output).toContain(name);
      expect(forced.output).toContain('plan');
      expect(forced.output).not.toMatch(/--force(?!-migration)/);
      expect(await indexValidity()).not.toContain(true);

      // Outside concurrent-index mode the build runs in the transaction; the
      // interrupted build's INVALID index goes first, as the docs direct.
      await db.query(`DROP INDEX IF EXISTS "${index}"`);
      const targeted = await run({ 'force-migration': name });

      expect(targeted.exitCode ?? 0, targeted.output).toBe(0);
      expect(await indexValidity()).toEqual([true]);
    }, 60_000);

    it('retries normally in the mode that recorded it', async () => {
      await db.query(
        `INSERT INTO "${table}" VALUES ('a', 'same'), ('b', 'same')`,
      );
      const first = await run({ 'postgres-safe': true });
      expect(first.exitCode, first.output).toBe(1);
      await db.query(
        `UPDATE "${table}" SET title = 'different' WHERE id = 'b'`,
      );

      const retry = await run({ 'postgres-safe': true });

      expect(retry.exitCode ?? 0, retry.output).toBe(0);
      expect(await indexValidity()).toEqual([true]);
    }, 60_000);
  },
);
