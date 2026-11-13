/** #4927: actual concurrent index builds need PostgreSQL, not PGlite. */
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
      { path: '/fake/.smrt/manifest.json', source: 'project', objectCount: 2 },
    ],
    totalObjects: 2,
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
        dbid: `4927-${process.pid}-${++sequence}`,
      }),
  };
});
const pgUrl = process.env.SMRT_TEST_POSTGRES_URL ?? process.env.DATABASE_URL;

describe.skipIf(!pgUrl)(
  'db:migrate --postgres-safe (#4927, PostgreSQL)',
  () => {
    const suffix = `${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
    const existing = `safe4927_${suffix}`;
    const created = `new4927_${suffix}`;
    const index = `${existing}_title_unique`;
    let db: DatabaseInterface;
    let schemas: Record<string, SchemaDefinition>;
    let logs: ReturnType<typeof vi.spyOn>;
    let errors: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
      db = await getDatabase({ type: 'postgres', url: pgUrl });
      await db.query(
        `CREATE TABLE "${existing}" (id TEXT PRIMARY KEY, title TEXT)`,
      );
      await new MigrationTracker({ db }).initialize();
      schemas = {
        [existing]: {
          tableName: existing,
          columns: {
            id: { type: 'TEXT', primaryKey: true },
            title: { type: 'TEXT' },
            note: { type: 'TEXT' },
          },
          indexes: [{ name: index, columns: ['title'], unique: true }],
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: '4927',
        },
        [created]: {
          tableName: created,
          columns: { id: { type: 'TEXT', primaryKey: true } },
          indexes: [],
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: '4927',
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
      await db.query(`DROP TABLE IF EXISTS "${created}" CASCADE`);
      await db.query(`DROP TABLE IF EXISTS "${existing}" CASCADE`);
      await db.close?.();
      clearCache();
      vi.restoreAllMocks();
      process.exitCode = undefined;
    });
    async function run() {
      process.exitCode = undefined;
      logs.mockClear();
      errors.mockClear();
      await requireCommandHandler(utilityCommands['db:migrate'])([], {
        'postgres-safe': true,
      });
      return [...logs.mock.calls, ...errors.mock.calls]
        .map((c) => c.join(' '))
        .join('\n');
    }
    async function applicationSnapshot() {
      return JSON.stringify({
        columns: (
          await db.query(
            'SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name IN ($1, $2) ORDER BY table_name, ordinal_position',
            [existing, created],
          )
        ).rows,
        indexes: (
          await db.query(
            'SELECT indexname, indexdef FROM pg_indexes WHERE tablename IN ($1, $2) ORDER BY indexname',
            [existing, created],
          )
        ).rows,
        rows: (await db.query(`SELECT * FROM "${existing}" ORDER BY id`)).rows,
        tracking: (
          await db.query('SELECT * FROM _smrt_schema_migrations ORDER BY name')
        ).rows,
      });
    }
    it('commits table changes before a failed concurrent unique index, then reruns only the indexes', async () => {
      await db.query(
        `INSERT INTO "${existing}" VALUES ('a', 'same'), ('b', 'same')`,
      );
      const first = await run();
      expect(process.exitCode, first).toBe(1);
      expect(first).toContain('Non-index changes in this batch were committed');
      expect((await db.getTableSchema?.(existing))?.columns).toHaveProperty(
        'note',
      );
      expect(await db.tableExists(created)).toBe(true);
      expect(
        (
          await db.query(
            'SELECT indisvalid FROM pg_index JOIN pg_class ON pg_class.oid = indexrelid WHERE relname = $1',
            [index],
          )
        ).rows,
      ).not.toContainEqual({ indisvalid: true });
      await db.query(
        `UPDATE "${existing}" SET title = 'different' WHERE id = 'b'`,
      );
      const second = await run();
      expect(process.exitCode ?? 0, second).toBe(0);
      expect(second).not.toContain('Created table');
      expect(second).not.toContain('Added column');
      expect(
        (
          await db.query(
            'SELECT indisvalid FROM pg_index JOIN pg_class ON pg_class.oid = indexrelid WHERE relname = $1',
            [index],
          )
        ).rows,
      ).toEqual([{ indisvalid: true }]);
      expect(
        (await db.query(`SELECT title, note FROM "${existing}" ORDER BY id`))
          .rows,
      ).toEqual([
        { title: 'same', note: null },
        { title: 'different', note: null },
      ]);
    }, 60_000);
    it('a stop refuses before any table, index, data, or tracker changes in concurrent-index mode', async () => {
      schemas[existing].columns.title.notNull = true;
      await db.query(`INSERT INTO "${existing}" VALUES ('a', NULL)`);
      const before = await applicationSnapshot();
      const out = await run();
      expect(process.exitCode).toBe(1);
      expect(out).toContain('Migrate stopped:');
      expect(out).toContain(`${existing}.title`);
      expect(out).toContain(`Create table ${created}`);
      expect(out).toContain(`Add column ${existing}.note`);
      expect(out).toContain(`Add index ${existing}.${index}`);
      expect(await applicationSnapshot()).toBe(before);
    }, 60_000);
  },
);
