import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearCache, setConfig } from '@happyvertical/smrt-config';
import {
  collectMigrateRecordInput,
  ObjectRegistry,
  OLDEST_SUPPORTED_RELEASE,
  OLDEST_SUPPORTED_SYSTEM_SCHEMA,
  readLastMigrateRecord,
  recordSuccessfulMigrate,
  type SchemaDefinition,
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

describe('db:migrate release floor (#4933, real SQLite)', () => {
  let directory: string;
  let dbUrl: string;
  let logs: ReturnType<typeof vi.spyOn>;
  let errors: ReturnType<typeof vi.spyOn>;
  let warns: ReturnType<typeof vi.spyOn>;
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
    warns.mockClear();
    const command = utilityCommands['db:migrate'];
    const parsed = parseCliCommandArgs(['db:migrate', ...flags], [command]);
    await requireCommandHandler(command)(parsed.args, parsed.options);
    return [...logs.mock.calls, ...errors.mock.calls, ...warns.mock.calls]
      .map((call) => call.join(' '))
      .join('\n');
  }
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'migrate-4933-'));
    dbUrl = join(directory, 'test.db');
    clearCache();
    setConfig({
      packages: { cli: { database: { type: 'sqlite', url: dbUrl } } },
    });
    schemas = {
      posts: schema(
        'posts',
        {
          id: { type: 'TEXT', primaryKey: true },
          title: { type: 'TEXT' },
          required_value: { type: 'TEXT', notNull: true, backfill: 'title' },
          note: { type: 'TEXT' },
        },
        [{ name: 'posts_title_idx', columns: ['title'] }],
      ),
      tags: schema('tags', { id: { type: 'TEXT', primaryKey: true } }),
    };
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
    warns = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.exitCode = undefined;
  });
  afterEach(() => {
    process.exitCode = undefined;
    clearCache();
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  it('an older last record exits 1 and leaves every table and row unchanged', async () => {
    delete schemas.posts.columns.required_value;
    await withDb(async (db) => {
      await db.query('CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT)');
      await db.query("INSERT INTO posts VALUES ('p1', 'old')");
      await recordSuccessfulMigrate(db, {
        input: { ...collectMigrateRecordInput(), release: '0.0.1' },
      });
    });
    const before = await withDb(snapshot);
    const out = await run();
    expect(process.exitCode).toBe(1);
    expect(out).toContain('This database was last migrated by smrt 0.0.1');
    expect(out).toContain(`supports upgrades from ${OLDEST_SUPPORTED_RELEASE}`);
    expect(out).toContain('First upgrade the database with smrt');
    expect(out).toContain('Held back (nothing was applied)');
    expect(out).toContain('Add column posts.note');
    expect(await withDb(snapshot)).toBe(before);
    expect(await withDb(readLastMigrateRecord)).toMatchObject({
      state: 'recorded',
      record: { release: '0.0.1' },
    });
  });
  it.each([
    null,
    OLDEST_SUPPORTED_RELEASE,
    '999.0.0',
  ])('equal/newer/no record %s proceeds', async (release) => {
    delete schemas.posts.columns.required_value;
    await withDb(async (db) => {
      await db.query('CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT)');
      await db.query("INSERT INTO posts VALUES ('p1', 'old')");
      if (release)
        await recordSuccessfulMigrate(db, {
          input: { ...collectMigrateRecordInput(), release },
        });
    });
    await run();
    expect(process.exitCode ?? 0).toBe(0);
    await withDb(async (db) => {
      expect((await db.getTableSchema?.('posts'))?.columns).toHaveProperty(
        'note',
      );
      expect((await db.query('SELECT title FROM posts')).rows).toEqual([
        { title: 'old' },
      ]);
    });
  });
  /** `_smrt_migrations` as an earlier release left it, with no migrate record. */
  async function stampSystemSchema(db: DatabaseInterface, version: string) {
    await db.query(`CREATE TABLE _smrt_migrations (
      id TEXT PRIMARY KEY, version TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, description TEXT, checksum TEXT)`);
    await db.query(
      "INSERT INTO _smrt_migrations (id, version, description) VALUES ('stamp', ?, 'earlier release')",
      version,
    );
  }
  it('no record and system tables older than the floor warns and proceeds', async () => {
    delete schemas.posts.columns.required_value;
    const [major, minor] = (OLDEST_SUPPORTED_SYSTEM_SCHEMA as string)
      .split('.')
      .map(Number);
    const older = `${major}.${minor - 1}.0`;
    await withDb(async (db) => {
      await db.query('CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT)');
      await db.query("INSERT INTO posts VALUES ('p1', 'old')");
      await stampSystemSchema(db, older);
    });
    const out = await run();
    expect(process.exitCode ?? 0).toBe(0);
    expect(out).toContain('This database has no migrate record');
    expect(out).toContain(
      `last prepared by a smrt release older than ${OLDEST_SUPPORTED_RELEASE} (system schema ${older}`,
    );
    await withDb(async (db) => {
      expect((await db.getTableSchema?.('posts'))?.columns).toHaveProperty(
        'note',
      );
    });
  });
  it('no record and system tables at the floor proceeds', async () => {
    delete schemas.posts.columns.required_value;
    await withDb(async (db) => {
      await db.query('CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT)');
      await db.query("INSERT INTO posts VALUES ('p1', 'old')");
      await stampSystemSchema(db, OLDEST_SUPPORTED_SYSTEM_SCHEMA as string);
    });
    await run();
    expect(process.exitCode ?? 0).toBe(0);
    await withDb(async (db) => {
      expect((await db.getTableSchema?.('posts'))?.columns).toHaveProperty(
        'note',
      );
    });
  });
});
