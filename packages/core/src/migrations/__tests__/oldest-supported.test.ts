import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ObjectRegistry } from '../../registry.js';
import {
  collectMigrateRecordInput,
  readLastMigrateRecord,
  recordSuccessfulMigrate,
} from '../migrate-record.js';
import { decideMigrationRun } from '../migration-run-decision.js';
import {
  checkOldestSupportedRelease,
  compareReleases,
  OLDEST_SUPPORTED_RELEASE,
} from '../oldest-supported.js';
import { migrateSmrtSchemas } from '../orchestrate.js';

describe('release floor (#4933)', () => {
  it('orders numeric releases, prereleases and build tags', () => {
    expect(compareReleases('0.60.9', '0.60.17')).toBe(-1);
    expect(compareReleases('v0.60.17', '0.60.17+build.1')).toBe(0);
    expect(compareReleases('0.61.0-rc.2', '0.61.0-rc.10')).toBe(-1);
    expect(compareReleases('0.61.0-rc.1', '0.61.0')).toBe(-1);
    expect(compareReleases('0.61.0-beta', '0.61.0-alpha')).toBe(1);
    expect(compareReleases('0.61.0-1', '0.61.0-alpha')).toBe(-1);
    expect(compareReleases('0.61.0-alpha', '0.61.0-alpha.1')).toBe(-1);
    expect(() => compareReleases('unknown', '0.60.17')).toThrow(
      'Invalid smrt release',
    );
  });
  it.each([
    null,
    OLDEST_SUPPORTED_RELEASE,
    '999.0.0',
  ])('permits %s', (release) => {
    expect(checkOldestSupportedRelease(release)).toEqual({ ok: true });
    expect(
      decideMigrationRun({
        changes: [],
        engine: 'postgres',
        recordedRelease: release,
      }),
    ).toMatchObject({ proceed: true, releaseStop: null });
  });
  it('refuses old releases, holds back the full plan and names the first hop', () => {
    const decision = decideMigrationRun({
      changes: [],
      addedTables: [{ tableName: 'posts' }],
      engine: 'postgres',
      recordedRelease: '0.0.1',
    });
    expect(decision).toMatchObject({
      proceed: false,
      releaseStop: { message: expect.stringContaining('smrt 0.0.1') },
      heldBack: [{ table: 'posts' }],
    });
    expect(decision.releaseStop?.message).toContain(
      `supports upgrades from ${OLDEST_SUPPORTED_RELEASE}`,
    );
    expect(decision.releaseStop?.message).toContain(
      'First upgrade the database with smrt',
    );
  });
  it('does not silently trust a malformed release record', () => {
    expect(checkOldestSupportedRelease('unknown')).toMatchObject({
      ok: false,
      message: expect.stringContaining('unreadable'),
    });
  });
});

describe('migrate release refusal (real SQLite)', () => {
  let db: DatabaseInterface;
  beforeEach(async () => {
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockReturnValue({
      posts: {
        tableName: 'posts',
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          note: { type: 'TEXT' },
        },
        indexes: [],
        foreignKeys: [],
        triggers: [],
        dependencies: [],
        version: '',
      },
    });
    await db.query('CREATE TABLE posts (id TEXT PRIMARY KEY)');
    await db.query("INSERT INTO posts VALUES ('old-row')");
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.close?.();
  });
  it('older last record refuses without applying a column or updating the record', async () => {
    await recordSuccessfulMigrate(db, {
      input: { ...collectMigrateRecordInput(), release: '0.0.1' },
    });
    const before = await readLastMigrateRecord(db);
    const result = await migrateSmrtSchemas({ db, packageName: '@test/gate' });
    expect(result).toMatchObject({
      refused: true,
      applied: false,
      releaseStop: { message: expect.stringContaining('smrt 0.0.1') },
      results: [],
    });
    expect((await db.getTableSchema?.('posts'))?.columns).not.toHaveProperty(
      'note',
    );
    expect(await readLastMigrateRecord(db)).toEqual(before);
  });
  it.each([
    null,
    OLDEST_SUPPORTED_RELEASE,
    '999.0.0',
  ])('equal/newer/no record %s proceeds', async (release) => {
    if (release)
      await recordSuccessfulMigrate(db, {
        input: { ...collectMigrateRecordInput(), release },
      });
    const result = await migrateSmrtSchemas({ db, packageName: '@test/gate' });
    expect(result).toMatchObject({
      refused: false,
      releaseStop: null,
      applied: true,
    });
    expect((await db.getTableSchema?.('posts'))?.columns).toHaveProperty(
      'note',
    );
    expect((await db.query('SELECT * FROM posts')).rows).toEqual([
      { id: 'old-row', note: null },
    ]);
  });
});
