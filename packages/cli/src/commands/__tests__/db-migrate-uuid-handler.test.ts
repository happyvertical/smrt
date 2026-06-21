import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearCache, setConfig } from '@happyvertical/smrt-config';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { autoDiscoverAndLoadMock } = vi.hoisted(() => ({
  autoDiscoverAndLoadMock: vi.fn(),
}));

vi.mock('../../discovery/index.js', () => ({
  autoDiscoverAndLoad: autoDiscoverAndLoadMock,
}));

import { dbMigrateUuidCommand } from '../db-migrate-uuid.js';

/**
 * db:migrate-uuid handler against a REAL SQLite database.
 *
 * The native TEXT→uuid conversion only runs on PostgreSQL; on SQLite the
 * command performs the R3 rename backfills and then reports the conversion is a
 * no-op. These tests exercise the non-Postgres handler branches (config
 * validation, rename parsing, real rename backfill, no-op conversion message,
 * --skip-convert, --dry-run, and error handling) end-to-end against a temp
 * SQLite file. The Postgres conversion gating itself is covered by the pure
 * unit tests and the DATABASE_URL-gated suite in db-migrate-uuid.test.ts.
 */
describe('db:migrate-uuid handler (real SQLite, non-Postgres branches)', () => {
  let dbUrl: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  async function freshDb(): Promise<any> {
    return getDatabase({ type: 'sqlite', url: dbUrl });
  }

  async function columns(table: string): Promise<string[]> {
    const db = await freshDb();
    const { rows } = await db.query(`PRAGMA table_info(${table})`);
    await db.close?.();
    return (rows as any[]).map((r) => r.name);
  }

  beforeEach(() => {
    process.exitCode = undefined;
    dbUrl = join(
      tmpdir(),
      `cov-uuid-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    clearCache();
    setConfig({
      packages: { cli: { database: { type: 'sqlite', url: dbUrl } } },
    } as any);
    autoDiscoverAndLoadMock.mockResolvedValue({
      discovered: [],
      totalObjects: 0,
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearCache();
    try {
      rmSync(dbUrl, { force: true });
    } catch {
      // ignore
    }
  });

  function output(): string {
    return logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
  }

  function errorOutput(): string {
    return errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
  }

  it('errors out when the database is configured as :memory:', async () => {
    clearCache();
    setConfig({
      packages: { cli: { database: { type: 'sqlite', url: ':memory:' } } },
    } as any);
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined as never) as any);

    await dbMigrateUuidCommand.handler([], {});

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorOutput()).toContain('Database configuration required');
    exitSpy.mockRestore();
  });

  it('fails with exit code 1 when a --rename entry is malformed', async () => {
    await dbMigrateUuidCommand.handler([], { rename: 'no_colon', table: 't' });

    expect(process.exitCode).toBe(1);
    expect(errorOutput()).toContain('uuid migration failed');
  });

  it('reports the conversion is a no-op on SQLite when no renames are given', async () => {
    const db = await freshDb();
    await db.query('CREATE TABLE things (id TEXT PRIMARY KEY)');
    await db.close?.();

    await dbMigrateUuidCommand.handler([], {});

    expect(output()).toContain('no native uuid column type');
  });

  it('backfills an R3 rename and drops the old column on SQLite', async () => {
    const db = await freshDb();
    await db.query(
      'CREATE TABLE tags (id TEXT PRIMARY KEY, parent_slug TEXT, parent_id TEXT)',
    );
    await db.query(
      "INSERT INTO tags (id, parent_slug, parent_id) VALUES ('a', 'p1', NULL)",
    );
    await db.close?.();

    await dbMigrateUuidCommand.handler([], {
      rename: 'parent_slug:parent_id',
      table: 'tags',
    });

    const cols = await columns('tags');
    expect(cols).toContain('parent_id');
    expect(cols).not.toContain('parent_slug');

    const after = await freshDb();
    const { rows } = await after.query('SELECT parent_id FROM tags');
    await after.close?.();
    expect((rows as any[])[0].parent_id).toBe('p1');
    expect(output()).toContain('no native uuid column type');
  });

  it('skips a rename whose source column is already gone (idempotent re-run)', async () => {
    const db = await freshDb();
    await db.query('CREATE TABLE tags (id TEXT PRIMARY KEY, parent_id TEXT)');
    await db.close?.();

    await dbMigrateUuidCommand.handler([], {
      rename: 'parent_slug:parent_id',
      table: 'tags',
    });

    expect(output()).toContain('already migrated');
    expect(process.exitCode).not.toBe(1);
  });

  it('fails when the rename destination column is missing', async () => {
    const db = await freshDb();
    await db.query('CREATE TABLE tags (id TEXT PRIMARY KEY, parent_slug TEXT)');
    await db.close?.();

    await dbMigrateUuidCommand.handler([], {
      rename: 'parent_slug:parent_id',
      table: 'tags',
    });

    expect(process.exitCode).toBe(1);
    expect(errorOutput()).toContain('uuid migration failed');
  });

  it('skips the conversion pass entirely with --skip-convert', async () => {
    const db = await freshDb();
    await db.query(
      'CREATE TABLE tags (id TEXT PRIMARY KEY, parent_slug TEXT, parent_id TEXT)',
    );
    await db.close?.();

    await dbMigrateUuidCommand.handler([], {
      rename: 'parent_slug:parent_id',
      table: 'tags',
      'skip-convert': true,
    });

    expect(output()).toContain('Skipping TEXT');
    const cols = await columns('tags');
    expect(cols).not.toContain('parent_slug');
  });

  it('previews the rename without mutating the table in --dry-run mode', async () => {
    const db = await freshDb();
    await db.query(
      'CREATE TABLE tags (id TEXT PRIMARY KEY, parent_slug TEXT, parent_id TEXT)',
    );
    await db.close?.();

    await dbMigrateUuidCommand.handler([], {
      rename: 'parent_slug:parent_id',
      table: 'tags',
      'dry-run': true,
    });

    expect(output()).toContain('DRY RUN');
    const cols = await columns('tags');
    // Nothing was actually applied.
    expect(cols).toContain('parent_slug');
  });
});
