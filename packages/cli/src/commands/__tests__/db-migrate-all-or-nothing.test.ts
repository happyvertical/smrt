import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearCache, setConfig } from '@happyvertical/smrt-config';
import {
  ObjectRegistry,
  type SchemaDefinition,
} from '@happyvertical/smrt-core';
import { MigrationTracker } from '@happyvertical/smrt-core/migrations';
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

describe('db:migrate all or nothing (#4927, real SQLite)', () => {
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
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.exitCode = undefined;
  });
  afterEach(() => {
    process.exitCode = undefined;
    clearCache();
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  it('refuses the full plan without changing any table, index, or row; fixing data allows the full rerun', async () => {
    await withDb(async (db) => {
      await new MigrationTracker({ db }).initialize();
      await db.query('CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT)');
      await db.query("INSERT INTO posts VALUES ('p1', NULL)");
    });
    const before = await withDb(snapshot);
    const out = await run('--repair-data');
    expect(process.exitCode).toBe(1);
    expect(out).toContain(
      'Migrate stopped: 1 change(s) would lose or invent data',
    );
    expect(out).toContain('posts.required_value');
    expect(out).toContain('would invent data');
    expect(out).toContain('Held back (nothing was applied)');
    for (const description of [
      'Create table tags',
      'Add column posts.note',
      'Add index posts.posts_title_idx',
    ])
      expect(out).toContain(description);
    expect(out).toContain('--repair-data was skipped');
    expect(await withDb(snapshot)).toBe(before);

    await withDb(async (db) => {
      await db.query("UPDATE posts SET title = 'fixed'");
    });
    await run();
    expect(process.exitCode ?? 0).toBe(0);
    await withDb(async (db) => {
      expect((await db.getTableSchema?.('posts'))?.columns).toHaveProperty(
        'note',
      );
      expect(
        (
          await db.query(
            "SELECT name FROM sqlite_master WHERE name IN ('tags', 'posts_title_idx')",
          )
        ).rows,
      ).toHaveLength(2);
      expect(
        (await db.getTableSchema?.('posts'))?.columns.required_value,
      ).toMatchObject({ notNull: true });
      expect(
        (await db.query('SELECT title, required_value, note FROM posts')).rows,
      ).toEqual([{ title: 'fixed', required_value: 'fixed', note: null }]);
    });
  });

  it('dry-run prints the same refusal and held-back plan without writes or tracker bootstrap', async () => {
    await withDb(async (db) => {
      await db.query('CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT)');
      await db.query("INSERT INTO posts VALUES ('p1', NULL)");
    });
    const before = await withDb(snapshot);
    const out = await run('--dry-run', '--repair-data');
    expect(process.exitCode).toBe(1);
    expect(out).toContain('Dry-run: this migration would be refused');
    expect(out).toContain('Create table tags');
    expect(out).toContain('Add column posts.note');
    expect(out).toContain('Add index posts.posts_title_idx');
    expect(await withDb(snapshot)).toBe(before);
  });

  it('does not bootstrap tracker tables on a refused real run', async () => {
    await withDb(async (db) => {
      await db.query('CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT)');
      await db.query("INSERT INTO posts VALUES ('p1', NULL)");
    });
    const before = await withDb(snapshot);
    await run();
    expect(process.exitCode).toBe(1);
    expect(await withDb(snapshot)).toBe(before);
  });

  it('rolls back an earlier add-column and new table when a later unique index fails', async () => {
    delete schemas.posts.columns.required_value;
    schemas.posts.indexes[0].unique = true;
    await withDb(async (db) => {
      await new MigrationTracker({ db }).initialize();
      await db.query('CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT)');
      await db.query(
        "INSERT INTO posts VALUES ('p1', 'duplicate'), ('p2', 'duplicate')",
      );
    });
    const before = await withDb(snapshot);
    const out = await run();
    expect(process.exitCode).toBe(1);
    expect(out).toContain('Rolled back all schema changes');
    expect(await withDb(snapshot)).toBe(before);
  });

  it('rejects --apply-unblocked before opening a database or taking a lock', async () => {
    const out = await run('--apply-unblocked');
    expect(process.exitCode).toBe(1);
    expect(out).toContain('--apply-unblocked');
    expect(out).toContain('migrate is all or nothing now');
    expect(out).toContain('partial apply is gone');
    expect(out).toContain('packages/cli/agents/db-migrate-all-or-nothing.md');
    expect(out).not.toContain('Connecting');
    expect(existsSync(dbUrl)).toBe(false);
  });
});
