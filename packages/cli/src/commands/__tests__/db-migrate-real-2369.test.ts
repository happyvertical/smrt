import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearCache, setConfig } from '@happyvertical/smrt-config';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { autoDiscoverAndLoadMock } = vi.hoisted(() => ({
  autoDiscoverAndLoadMock: vi.fn(),
}));

vi.mock('../../discovery/index.js', () => ({
  autoDiscoverAndLoad: autoDiscoverAndLoadMock,
}));

import { utilityCommands } from '../utilities.js';

/**
 * db:migrate against a REAL SQLite database for the #2369 surface: orphan
 * NOT NULL columns are warned about every run (never silently "in sync"),
 * `--drop-columns` removes them, required-with-default columns are added
 * with executable DDL on a populated table, and a required column without a
 * default is added nullable with the NOT NULL reported as a manual step.
 * Only manifest discovery and the declared schema source are injected; the
 * SchemaComparer and MigrationTracker run for real.
 */
describe('db:migrate (real SQLite, #2369)', () => {
  let dbUrl: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let getSchemasSpy: ReturnType<typeof vi.spyOn>;

  async function withDb<T>(
    fn: (db: Awaited<ReturnType<typeof getDatabase>>) => Promise<T>,
  ): Promise<T> {
    const db = await getDatabase({ type: 'sqlite', url: dbUrl });
    try {
      return await fn(db);
    } finally {
      await db.close?.();
    }
  }

  function declareSchema(defs: Record<string, any>): void {
    getSchemasSpy.mockReturnValue(defs as any);
  }

  const postsSchema = (
    columns: Record<string, unknown>,
    indexes: unknown[] = [],
  ) => ({
    posts: {
      tableName: 'posts',
      ddl: '',
      columns,
      indexes,
      triggers: [],
      foreignKeys: [],
      dependencies: [],
      version: '1.0.0',
    },
  });

  beforeEach(() => {
    process.exitCode = undefined;
    dbUrl = join(
      tmpdir(),
      `migrate-2369-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    clearCache();
    setConfig({
      packages: { cli: { database: { type: 'sqlite', url: dbUrl } } },
    } as any);
    autoDiscoverAndLoadMock.mockResolvedValue({
      discovered: [
        {
          path: '/fake/.smrt/manifest.json',
          source: 'project',
          objectCount: 1,
          objectNames: ['@fake/app:Post'],
        },
      ],
      totalObjects: 1,
    });
    getSchemasSpy = vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearCache();
    process.exitCode = undefined;
    try {
      rmSync(dbUrl, { force: true });
    } catch {
      // ignore
    }
  });

  function output(): string {
    return logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
  }

  it('warns about a renamed required field every run and drops it only with --drop-columns', async () => {
    await withDb(async (db) => {
      await db.query(
        'CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT NOT NULL)',
      );
      await db.query("INSERT INTO posts (id, title) VALUES ('p1', 'old')");
    });
    declareSchema(
      postsSchema({
        id: { type: 'TEXT', primaryKey: true },
        headline: { type: 'TEXT', notNull: true, defaultValue: '' },
      }),
    );

    // Run 1: adds `headline`, warns about `title`, does not fail.
    // (Sub-millisecond SQLite migrations are logged as "already applied" by
    // the tracker's execution_time_ms === 0 heuristic, so the applied
    // column is asserted on the live schema rather than the log line.)
    await utilityCommands['db:migrate'].handler([], {});
    let out = output();
    await withDb(async (db) => {
      const cols = await db.getTableSchema?.('posts');
      expect(cols?.columns.headline).toMatchObject({ notNull: true });
    });
    expect(out).toContain('need an operator decision');
    expect(out).toContain('posts.title: orphan column (TEXT NOT NULL)');
    expect(out).toContain('--drop-columns');
    expect(process.exitCode).toBeUndefined();

    // The orphan still breaks an ORM-style insert that omits it.
    await withDb(async (db) => {
      await expect(
        db.query("INSERT INTO posts (id, headline) VALUES ('p2', 'new')"),
      ).rejects.toThrow();
    });

    // Run 2 (no flag): nothing to apply, the warning is repeated — never
    // reported as in sync.
    logSpy.mockClear();
    await utilityCommands['db:migrate'].handler([], {});
    out = output();
    expect(out).toContain('posts.title: orphan column (TEXT NOT NULL)');
    expect(out).toContain(
      'No migrations needed - see the live schema findings',
    );
    expect(out).not.toContain('Applying');

    // Run 3: --drop-columns removes the orphan; inserts work again.
    logSpy.mockClear();
    await utilityCommands['db:migrate'].handler([], { 'drop-columns': true });
    out = output();
    expect(out).toContain('Applying 1 schema change(s)');
    expect(process.exitCode).toBeUndefined();
    await withDb(async (db) => {
      await db.query("INSERT INTO posts (id, headline) VALUES ('p2', 'new')");
      const cols = await db.getTableSchema?.('posts');
      expect(Object.keys(cols?.columns ?? {})).toEqual(['id', 'headline']);
    });

    // Run 4: clean.
    logSpy.mockClear();
    await utilityCommands['db:migrate'].handler([], {});
    expect(output()).toContain('up to date');
    expect(output()).not.toContain('orphan column');
  });

  it('adds required (with default) and unique columns to a populated table with executable DDL', async () => {
    await withDb(async (db) => {
      await db.query('CREATE TABLE posts (id TEXT PRIMARY KEY)');
      await db.query("INSERT INTO posts (id) VALUES ('p1')");
    });
    declareSchema(
      postsSchema({
        id: { type: 'TEXT', primaryKey: true },
        status: { type: 'TEXT', notNull: true, defaultValue: 'draft' },
        email: { type: 'TEXT', unique: true },
      }),
    );

    await utilityCommands['db:migrate'].handler([], { 'dry-run': true });
    let out = output();
    expect(out).toContain(
      `ALTER TABLE "posts" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'draft';`,
    );
    expect(out).toContain('ALTER TABLE "posts" ADD COLUMN "email" TEXT;');
    expect(out).toContain(
      'CREATE UNIQUE INDEX "posts_email_key" ON "posts" ("email");',
    );
    expect(out).not.toContain('ADD COLUMN "email" TEXT UNIQUE');

    logSpy.mockClear();
    await utilityCommands['db:migrate'].handler([], {});
    out = output();
    expect(out).toContain('Applying 2 schema change(s)');
    expect(process.exitCode).toBeUndefined();

    await withDb(async (db) => {
      const row = (await db.query('SELECT status FROM posts')).rows as Array<
        Record<string, unknown>
      >;
      expect(row[0].status).toBe('draft');
      await db.query("INSERT INTO posts (id, email) VALUES ('p2', 'a@x')");
      await expect(
        db.query("INSERT INTO posts (id, email) VALUES ('p3', 'a@x')"),
      ).rejects.toThrow();
    });

    logSpy.mockClear();
    await utilityCommands['db:migrate'].handler([], {});
    expect(output()).toContain('up to date');
  });

  it('adds a required column without a default nullable on a populated table and reports the NOT NULL as manual (exit 1)', async () => {
    await withDb(async (db) => {
      await db.query('CREATE TABLE posts (id TEXT PRIMARY KEY)');
      await db.query("INSERT INTO posts (id) VALUES ('p1')");
    });
    declareSchema(
      postsSchema({
        id: { type: 'TEXT', primaryKey: true },
        owner_id: { type: 'TEXT', notNull: true },
      }),
    );

    await utilityCommands['db:migrate'].handler([], {});
    const out = output();
    expect(out).toContain('Applying 1 schema change(s)');
    expect(out).toContain('requires manual intervention');
    expect(out).toContain('posts.owner_id: expected NOT NULL, found NULL');
    expect(process.exitCode).toBe(1);

    await withDb(async (db) => {
      const cols = await db.getTableSchema?.('posts');
      expect(cols?.columns.owner_id).toMatchObject({ notNull: false });
      // Still insertable — the column was not rejected outright.
      await db.query("INSERT INTO posts (id) VALUES ('p2')");
    });
  });
});
