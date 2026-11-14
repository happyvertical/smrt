import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearCache, setConfig } from '@happyvertical/smrt-config';
import {
  ObjectRegistry,
  readLastMigrateRecord,
  recordSuccessfulMigrate,
} from '@happyvertical/smrt-core';
import type { SchemaDefinition } from '@happyvertical/smrt-core/schema';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requireCommandHandler } from '../../__tests__/command-handler.js';

const { autoDiscoverAndLoadMock } = vi.hoisted(() => ({
  autoDiscoverAndLoadMock: vi.fn(),
}));
vi.mock('../../discovery/index.js', () => ({
  autoDiscoverAndLoad: autoDiscoverAndLoadMock,
}));

import { utilityCommands } from '../utilities.js';

const schema: SchemaDefinition = {
  tableName: 'record_entries',
  columns: {
    id: { type: 'TEXT', primaryKey: true, notNull: true },
    title: { type: 'TEXT' },
  },
  indexes: [],
  triggers: [],
  foreignKeys: [],
  dependencies: [],
  version: '',
};

describe('db:migrate records only complete success (#4926)', () => {
  let dbUrl: string;
  const run = (
    options: Parameters<ReturnType<typeof requireCommandHandler>>[1] = {},
  ) => requireCommandHandler(utilityCommands['db:migrate'])([], options);
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
  beforeEach(() => {
    process.exitCode = undefined;
    dbUrl = join(tmpdir(), `migrate-record-${crypto.randomUUID()}.db`);
    clearCache();
    setConfig({
      packages: { cli: { database: { type: 'sqlite', url: dbUrl } } },
    });
    autoDiscoverAndLoadMock.mockResolvedValue({
      discovered: [
        {
          path: '/fixture/.smrt/manifest.json',
          source: 'project',
          objectCount: 1,
          objectNames: ['@fixture/app:Entry'],
        },
      ],
      totalObjects: 1,
    });
    vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockReturnValue({
      [schema.tableName]: structuredClone(schema),
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    clearCache();
    process.exitCode = undefined;
    rmSync(dbUrl, { force: true });
  });

  it('records successful apply, then skips identical in-sync runs', async () => {
    await run();
    expect(process.exitCode).toBeUndefined();
    const previous = await withDb((db) => readLastMigrateRecord(db));
    expect(previous.state).toBe('recorded');
    await run();
    expect(process.exitCode).toBeUndefined();
    expect(await withDb((db) => readLastMigrateRecord(db))).toEqual(previous);
  });

  it('stamps the first in-sync run on an older database', async () => {
    await withDb((db) =>
      db.query(
        'CREATE TABLE record_entries (id TEXT PRIMARY KEY NOT NULL, title TEXT)',
      ),
    );
    await run();
    expect(process.exitCode).toBeUndefined();
    expect((await withDb((db) => readLastMigrateRecord(db))).state).toBe(
      'recorded',
    );
  });

  it('keeps an existing record untouched in a dry run', async () => {
    await withDb((db) =>
      recordSuccessfulMigrate(db, {
        input: { release: 'old', packages: [], fingerprint: 'old' },
      }),
    );
    const previous = await withDb((db) => readLastMigrateRecord(db));
    await run({ 'dry-run': true });
    expect(await withDb((db) => readLastMigrateRecord(db))).toEqual(previous);
  });

  it('keeps an existing record when a manual stop remains alongside an applicable change', async () => {
    await withDb(async (db) => {
      await recordSuccessfulMigrate(db, {
        input: { release: 'old', packages: [], fingerprint: 'old' },
      });
      await db.query(
        'CREATE TABLE record_entries (id TEXT PRIMARY KEY NOT NULL)',
      );
    });
    const previous = await withDb((db) => readLastMigrateRecord(db));
    await withDb((db) =>
      db.query("INSERT INTO record_entries VALUES ('existing')"),
    );
    const changed = structuredClone(schema);
    changed.columns.score = { type: 'INTEGER', notNull: true };
    vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockReturnValue({
      [changed.tableName]: changed,
    });
    await run();
    expect(process.exitCode).toBe(1);
    expect(await withDb((db) => readLastMigrateRecord(db))).toEqual(previous);
  });

  it('keeps an existing record when executable DDL fails', async () => {
    await withDb(async (db) => {
      await recordSuccessfulMigrate(db, {
        input: { release: 'old', packages: [], fingerprint: 'old' },
      });
      await db.query(
        'CREATE TABLE record_entries (id TEXT PRIMARY KEY NOT NULL)',
      );
    });
    const previous = await withDb((db) => readLastMigrateRecord(db));
    const changed = structuredClone(schema);
    changed.indexes = [{ name: 'broken_index', columns: ['missing_column'] }];
    vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockReturnValue({
      [changed.tableName]: changed,
    });
    await run();
    expect(process.exitCode).toBe(1);
    expect(await withDb((db) => readLastMigrateRecord(db))).toEqual(previous);
  });
});
