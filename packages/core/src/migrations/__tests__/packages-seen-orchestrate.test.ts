import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmrtObject } from '../../object.js';
import { ObjectRegistry } from '../../registry.js';
import type { SchemaDefinition } from '../../schema/types.js';
import {
  collectMigrateRecordInput,
  readLastMigrateRecord,
  recordSuccessfulMigrate,
} from '../migrate-record.js';
import { migrateSmrtSchemas } from '../orchestrate.js';

// Every catalog entry and row, including framework tables and the prior record.
async function snapshot(db: DatabaseInterface): Promise<string> {
  const catalog = (
    await db.query(
      'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name',
    )
  ).rows;
  const rows: Record<string, unknown> = {};
  for (const table of catalog.filter((row) => row.type === 'table')) {
    const name = String(table.name);
    rows[name] = (
      await db.query(`SELECT * FROM "${name.replaceAll('"', '""')}"`)
    ).rows
      .map((row) => JSON.stringify(row))
      .sort();
  }
  return JSON.stringify({ catalog, rows });
}
const definition: SchemaDefinition = {
  tableName: 'posts',
  columns: {
    id: { type: 'TEXT', primaryKey: true, notNull: true },
    title: { type: 'TEXT' },
    note: { type: 'TEXT' },
  },
  indexes: [],
  foreignKeys: [],
  triggers: [],
  dependencies: [],
  version: '',
};

describe('migrateSmrtSchemas missing packages (#4928, SQLite)', () => {
  let db: DatabaseInterface;
  beforeEach(async () => {
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockReturnValue({
      posts: structuredClone(definition),
    });
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
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.close?.();
  });

  async function seed(packages = ['@app/a', '@scope/b']) {
    await db.query(
      'CREATE TABLE posts (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL)',
    );
    await db.query("INSERT INTO posts VALUES ('p1', 'required by B')");
    await recordSuccessfulMigrate(db, {
      input: { ...collectMigrateRecordInput(), packages },
    });
  }

  it('refuses before any write, holds the relaxation and add-column, then confirmation applies and updates the record', async () => {
    await seed();
    const before = await snapshot(db);
    const refused = await migrateSmrtSchemas({
      db,
      packageName: '@app/a',
      relaxColumns: true,
    });
    expect(refused).toMatchObject({
      applied: false,
      refused: true,
      results: [],
      relaxedColumns: [],
    });
    expect(refused.packageStops).toEqual([
      {
        packageName: '@scope/b',
        kind: 'removed',
        message: expect.stringContaining('--confirm-removed-package @scope/b'),
      },
    ]);
    expect(refused.heldBack.map((item) => item.description)).toContain(
      'Add column posts.note',
    );
    expect(await snapshot(db)).toBe(before);
    expect((await db.getTableSchema?.('posts'))?.columns.title.notNull).toBe(
      true,
    );

    const applied = await migrateSmrtSchemas({
      db,
      packageName: '@app/a',
      relaxColumns: true,
      confirmRemovedPackages: ['@scope/b'],
    });
    expect(applied).toMatchObject({
      applied: true,
      refused: false,
      packageStops: [],
    });
    expect((await db.getTableSchema?.('posts'))?.columns.title.notNull).toBe(
      false,
    );
    expect(await readLastMigrateRecord(db)).toMatchObject({
      state: 'recorded',
      record: { packages: ['@app/a'] },
    });
    expect(
      (await migrateSmrtSchemas({ db, packageName: '@app/a' })).refused,
    ).toBe(false);
  });

  it('partial confirmation still refuses the whole batch', async () => {
    await seed(['@app/a', '@scope/b', '@scope/c']);
    const before = await snapshot(db);
    expect(
      (await migrateSmrtSchemas({ db, packageName: '@app/a' })).refused,
    ).toBe(true);
    expect(await snapshot(db)).toBe(before);
    const result = await migrateSmrtSchemas({
      db,
      packageName: '@app/a',
      confirmRemovedPackages: ['@scope/b'],
    });
    expect(result.refused).toBe(true);
    expect(result.packageStops.map((stop) => stop.packageName)).toEqual([
      '@scope/c',
    ]);
    expect(await snapshot(db)).toBe(before);
  });

  it('no record proceeds with an explicit notice and writes the first record', async () => {
    const result = await migrateSmrtSchemas({ db, packageName: '@app/a' });
    expect(result).toMatchObject({ applied: true, refused: false });
    expect(result.notices).toEqual([
      expect.stringContaining(
        'Package comparison skipped because no earlier migrate record exists',
      ),
    ]);
    expect(await readLastMigrateRecord(db)).toMatchObject({
      state: 'recorded',
      record: { packages: ['@app/a'] },
    });
  });

  it('added packages proceed and non-missing confirmations produce notices', async () => {
    await seed([]);
    const result = await migrateSmrtSchemas({
      db,
      packageName: '@app/a',
      confirmRemovedPackages: ['@app/a', '@scope/typo'],
    });
    expect(result.refused).toBe(false);
    expect(result.notices).toEqual([
      'Ignoring --confirm-removed-package @app/a: this package is not missing.',
      'Ignoring --confirm-removed-package @scope/typo: this package is not missing.',
    ]);
  });

  it('confirmed removal updates the record even when the schema is already current', async () => {
    await migrateSmrtSchemas({ db, packageName: '@app/a' });
    await recordSuccessfulMigrate(db, {
      input: {
        ...collectMigrateRecordInput(),
        packages: ['@app/a', '@scope/b'],
      },
    });
    const before = await snapshot(db);
    expect(
      (await migrateSmrtSchemas({ db, packageName: '@app/a' })).refused,
    ).toBe(true);
    expect(await snapshot(db)).toBe(before);
    const result = await migrateSmrtSchemas({
      db,
      packageName: '@app/a',
      confirmRemovedPackages: ['@scope/b'],
    });
    expect(result).toMatchObject({ applied: false, refused: false });
    expect(await readLastMigrateRecord(db)).toMatchObject({
      state: 'recorded',
      record: { packages: ['@app/a'] },
    });
  });

  // Lazy activation and run-time model edits (#4954) migrate a table subset.
  // Such a run is not a migrate of the build: it must not stop on a package it
  // never loads, and must not write a record that vouches for the build.
  it('a run limited to tables skips the package comparison and leaves the record as it was', async () => {
    await seed();
    const recordBefore = await readLastMigrateRecord(db);
    const runsBefore = (await db.query('SELECT * FROM _smrt_migrate_runs')).rows
      .length;
    expect(
      (await migrateSmrtSchemas({ db, packageName: '@app/a' })).refused,
    ).toBe(true);
    const result = await migrateSmrtSchemas({
      db,
      packageName: '@app/a',
      tables: ['posts'],
    });
    expect(result).toMatchObject({
      applied: true,
      refused: false,
      packageStops: [],
    });
    expect((await db.getTableSchema?.('posts'))?.columns).toHaveProperty(
      'note',
    );
    expect(await readLastMigrateRecord(db)).toEqual(recordBefore);
    expect(
      (await db.query('SELECT * FROM _smrt_migrate_runs')).rows,
    ).toHaveLength(runsBefore);
  });

  it('a run limited to tables writes no first record, so it cannot vouch for an unmigrated build', async () => {
    const result = await migrateSmrtSchemas({
      db,
      packageName: '@app/a',
      tables: ['posts'],
    });
    expect(result).toMatchObject({ applied: true, refused: false });
    expect(result.notices).toEqual([]);
    expect(await readLastMigrateRecord(db)).toEqual({ state: 'none' });
  });

  it('a run limited to tables is still all or nothing for its own changes', async () => {
    await db.query(
      'CREATE TABLE posts (id TEXT PRIMARY KEY NOT NULL, title BLOB, note TEXT)',
    );
    vi.mocked(ObjectRegistry.getAllSchemasAsDefinitions).mockReturnValue({
      posts: {
        ...structuredClone(definition),
        columns: {
          ...structuredClone(definition.columns),
          title: { type: 'INTEGER' },
        },
      },
      comments: { ...structuredClone(definition), tableName: 'comments' },
    });
    const before = await snapshot(db);
    const result = await migrateSmrtSchemas({
      db,
      packageName: '@app/a',
      tables: ['posts', 'comments'],
    });
    expect(result).toMatchObject({ applied: false, refused: true });
    expect(await snapshot(db)).toBe(before);
  });
});
