import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearCache, setConfig } from '@happyvertical/smrt-config';
import {
  collectMigrateRecordInput,
  ObjectRegistry,
  readLastMigrateRecord,
  recordSuccessfulMigrate,
  type SchemaDefinition,
  SmrtObject,
} from '@happyvertical/smrt-core';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requireCommandHandler } from '../../__tests__/command-handler.js';
import { parseCliCommandArgs } from '../../cli-generator.js';
import { utilityCommands } from '../utilities.js';

vi.mock('../../discovery/index.js', () => ({
  autoDiscoverAndLoad: vi.fn(async () => ({
    discovered: [
      { path: '/fake/.smrt/manifest.json', source: 'project', objectCount: 2 },
    ],
    totalObjects: 2,
  })),
}));

// Include every catalog entry and every row, including all framework tables.
async function snapshot(db: DatabaseInterface): Promise<string> {
  const catalog = (
    await db.query(
      'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name',
    )
  ).rows;
  const tables = (
    await db.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
  ).rows;
  const rows: Record<string, unknown> = {};
  for (const table of tables) {
    const name = String(table.name);
    const records = (
      await db.query(`SELECT * FROM "${name.replaceAll('"', '""')}"`)
    ).rows;
    rows[name] = records.map((row) => JSON.stringify(row)).sort();
  }
  return JSON.stringify({ catalog, rows });
}

function schema(
  tableName: string,
  columns: SchemaDefinition['columns'],
  indexes: SchemaDefinition['indexes'] = [],
): SchemaDefinition {
  return {
    tableName,
    columns,
    indexes,
    triggers: [],
    foreignKeys: [],
    dependencies: [],
    version: '4927',
  };
}

describe('db:migrate missing packages (#4928, real SQLite)', () => {
  let directory: string;
  let dbUrl: string;
  let logs: ReturnType<typeof vi.spyOn>;
  let errors: ReturnType<typeof vi.spyOn>;
  let schemas: Record<string, SchemaDefinition>;

  async function withDb<T>(
    work: (db: DatabaseInterface) => Promise<T>,
  ): Promise<T> {
    const db = await getDatabase({ type: 'sqlite', url: dbUrl });
    try {
      return await work(db);
    } finally {
      await db.close?.();
    }
  }
  async function run(...flags: string[]) {
    process.exitCode = undefined;
    logs.mockClear();
    errors.mockClear();
    const command = utilityCommands['db:migrate'];
    const parsed = parseCliCommandArgs(['db:migrate', ...flags], [command]);
    await requireCommandHandler(command)(parsed.args, parsed.options);
    return [...logs.mock.calls, ...errors.mock.calls]
      .map((call) => call.join(' '))
      .join('\n');
  }
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'migrate-4927-'));
    dbUrl = join(directory, 'test.db');
    clearCache();
    setConfig({
      packages: { cli: { database: { type: 'sqlite', url: dbUrl } } },
    });
    schemas = {
      posts: schema('posts', {
        id: { type: 'TEXT', primaryKey: true, notNull: true },
        title: { type: 'TEXT' },
        note: { type: 'TEXT' },
      }),
      tags: schema('tags', {
        id: { type: 'TEXT', primaryKey: true, notNull: true },
      }),
    };
    vi.spyOn(ObjectRegistry, 'getAllClasses').mockReturnValue(
      new Map([
        [
          '@app/a:Post',
          {
            name: 'Post',
            constructor: SmrtObject,
            config: {},
            fields: new Map(),
            methods: new Map(),
          },
        ],
      ]),
    );
    vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockImplementation(
      () => schemas,
    );
    vi.spyOn(ObjectRegistry, 'getInitializationOrder').mockReturnValue([
      'posts',
      'tags',
    ]);
    vi.spyOn(ObjectRegistry, 'getTableName').mockImplementation(
      (name: string) => name,
    );
    logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.exitCode = undefined;
  });
  afterEach(() => {
    process.exitCode = undefined;
    clearCache();
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  async function seed(packages = ['@app/a', '@scope/b']) {
    await withDb(async (db) => {
      await db.query(
        'CREATE TABLE posts (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL)',
      );
      await db.query("INSERT INTO posts VALUES ('p1', 'required by B')");
      await recordSuccessfulMigrate(db, {
        input: { ...collectMigrateRecordInput(), packages },
      });
    });
  }

  it('holds the #2372 relaxation and all other changes when B is missing; confirming B applies and records A alone', async () => {
    await seed();
    const before = await withDb(snapshot);
    const out = await run('--relax-columns', '--repair-data');
    expect(process.exitCode).toBe(1);
    expect(out).toContain('@scope/b');
    expect(out).toContain('--confirm-removed-package @scope/b');
    expect(out).toContain('could loosen');
    expect(out).toContain('Held back (nothing was applied)');
    expect(out).toContain('Create table tags');
    expect(out).toContain('posts.title');
    expect(await withDb(snapshot)).toBe(before);
    await withDb(async (db) =>
      expect((await db.getTableSchema?.('posts'))?.columns.title.notNull).toBe(
        true,
      ),
    );

    await run('--relax-columns', '--confirm-removed-package', '@scope/b');
    expect(process.exitCode ?? 0).toBe(0);
    await withDb(async (db) => {
      expect((await db.getTableSchema?.('posts'))?.columns.title.notNull).toBe(
        false,
      );
      expect(await readLastMigrateRecord(db)).toMatchObject({
        state: 'recorded',
        record: { packages: ['@app/a'] },
      });
    });
    // The new record no longer requires a confirmation on the next run.
    await run('--relax-columns');
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('needs one flag for each missing package', async () => {
    await seed(['@app/a', '@scope/b', '@scope/c']);
    const before = await withDb(snapshot);
    const out = await run('--confirm-removed-package', '@scope/b');
    expect(process.exitCode).toBe(1);
    expect(out).toContain('--confirm-removed-package @scope/c');
    expect(out).not.toContain('--confirm-removed-package @scope/b to confirm');
    expect(await withDb(snapshot)).toBe(before);
    await run(
      '--relax-columns',
      '--confirm-removed-package',
      '@scope/b',
      '--confirm-removed-package',
      '@scope/c',
    );
    expect(process.exitCode ?? 0).toBe(0);
    expect(await withDb((db) => readLastMigrateRecord(db))).toMatchObject({
      state: 'recorded',
      record: { packages: ['@app/a'] },
    });
  });

  it('prints the no-record notice and writes the first record', async () => {
    const out = await run();
    expect(process.exitCode ?? 0).toBe(0);
    expect(out).toContain(
      'Package comparison skipped because no earlier migrate record exists',
    );
    expect(out).toContain('record will be written');
    expect(await withDb((db) => readLastMigrateRecord(db))).toMatchObject({
      state: 'recorded',
      record: { packages: ['@app/a'] },
    });
  });

  it('ignores confirmations for non-missing names with a notice; added packages are fine', async () => {
    await seed([]);
    const out = await run(
      '--relax-columns',
      '--confirm-removed-package',
      '@app/a',
      '--confirm-removed-package',
      '@scope/typo',
    );
    expect(process.exitCode ?? 0).toBe(0);
    for (const name of ['@app/a', '@scope/typo'])
      expect(out).toContain(
        `Ignoring --confirm-removed-package ${name}: this package is not missing`,
      );
  });

  it('dry-run shows the package stop and changes no catalog entry or row', async () => {
    await seed();
    const before = await withDb(snapshot);
    const out = await run('--dry-run', '--relax-columns');
    expect(process.exitCode).toBe(1);
    expect(out).toContain('@scope/b');
    expect(out).toContain('Dry-run: this migration would be refused');
    expect(out).toContain('Create table tags');
    expect(await withDb(snapshot)).toBe(before);
  });

  it('dry-run without a record prints the notice but writes no record', async () => {
    await withDb(async (db) => {
      await db.query('CREATE TABLE legacy (id TEXT)');
    });
    const before = await withDb(snapshot);
    const out = await run('--dry-run');
    expect(process.exitCode ?? 0).toBe(0);
    expect(out).toContain(
      'Package comparison skipped because no earlier migrate record exists',
    );
    expect(await withDb(snapshot)).toBe(before);
    expect(await withDb((db) => readLastMigrateRecord(db))).toEqual({
      state: 'none',
    });
  });
});
