/**
 * An existing table the comparison cannot read is an error.
 *
 * The catalog query that lists tables works on any handle; the adapter call
 * that describes one does not (a handle can lack `getTableSchema`, or answer
 * nothing for a table the catalog lists). A table that is listed but cannot be described must stop the migrate. It
 * used to compare as "no changes": the rest of the plan applied and the run
 * was recorded as a successful migrate of a schema it never looked at.
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { field } from '../../decorators/index.js';
import { SmrtObject } from '../../object.js';
import { ObjectRegistry } from '../../registry.js';
import {
  inspectTableSchema,
  TableSchemaUnreadableError,
  TableSpellingMismatchError,
  TemporaryTableShadowError,
} from '../../schema/inspection.js';
import { snapshotObjectRegistryState } from '../../test-utils.js';
import { SchemaComparer } from '../differ.js';
import { readLastMigrateRecord } from '../migrate-record.js';
import {
  getPendingSchemaStatements,
  migrateSmrtSchemas,
} from '../orchestrate.js';

const PACKAGE = '@test/unreadable-table';

/** v1: one table. v2: that table gains `note`, and a second table appears. */
function registerVersion(version: 1 | 2) {
  ObjectRegistry.clear();
  class UnreadableItemV1 extends SmrtObject {
    title = '';
  }
  class UnreadableItemV2 extends SmrtObject {
    title = '';
    note = '';
  }
  const Item = version === 1 ? UnreadableItemV1 : UnreadableItemV2;
  field({ type: 'text' })(Item.prototype, 'title');
  if (version === 2) field({ type: 'text' })(Item.prototype, 'note');
  ObjectRegistry.register(Item, {
    packageName: PACKAGE,
    tableName: 'unreadable_items',
  });
  if (version === 2) {
    class UnreadableFresh extends SmrtObject {
      code = '';
    }
    field({ type: 'text' })(UnreadableFresh.prototype, 'code');
    ObjectRegistry.register(UnreadableFresh, {
      packageName: PACKAGE,
      tableName: 'unreadable_fresh',
    });
  }
}

const migrate = (
  db: DatabaseInterface,
  engineHint: 'sqlite' | 'duckdb',
): ReturnType<typeof migrateSmrtSchemas> =>
  migrateSmrtSchemas({
    db,
    packageName: PACKAGE,
    name: `unreadable_${randomUUID()}`,
    engineHint,
  });

async function tableNames(db: DatabaseInterface): Promise<string[]> {
  const result = await db.query(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'unreadable_%'",
  );
  return result.rows.map((row) => String(row.name)).sort();
}

async function columnNames(
  db: DatabaseInterface,
  table: string,
): Promise<string[]> {
  const result = await db.query(`PRAGMA table_info("${table}")`);
  return result.rows.map((row) => String(row.name));
}

describe('an existing table that cannot be read stops the migrate', () => {
  let restore: () => void;
  const handles: DatabaseInterface[] = [];

  beforeEach(() => {
    restore = snapshotObjectRegistryState();
  });
  afterEach(async () => {
    restore?.();
    for (const handle of handles.splice(0)) await handle.close?.();
  });

  async function open(type: 'sqlite' | 'duckdb'): Promise<DatabaseInterface> {
    const db = (await getDatabase({
      type,
      url: ':memory:',
    })) as DatabaseInterface;
    handles.push(db);
    return db;
  }

  /** `db` without an inspector: only `query()` can describe its tables. */
  function queryOnly(db: DatabaseInterface): DatabaseInterface {
    return new Proxy(db, {
      get(target, key, receiver) {
        if (key === 'getTableSchema') return undefined;
        const value = Reflect.get(target, key, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  /** `db` with an inspector that says nothing about one listed table. */
  function withoutSchemaFor(
    db: DatabaseInterface,
    table: string,
  ): DatabaseInterface {
    return new Proxy(db, {
      get(target, key, receiver) {
        if (key === 'getTableSchema')
          return async (name: string) =>
            name === table ? null : target.getTableSchema?.(name);
        const value = Reflect.get(target, key, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  it('SQLite: refuses when the adapter describes nothing for a listed table, and applies and records nothing', async () => {
    const db = await open('sqlite');
    registerVersion(1);
    await migrate(db, 'sqlite');
    const recordBefore = await readLastMigrateRecord(db, {
      engineHint: 'sqlite',
    });
    registerVersion(2);

    await expect(
      migrate(withoutSchemaFor(db, 'unreadable_items'), 'sqlite'),
    ).rejects.toBeInstanceOf(TableSchemaUnreadableError);
    await expect(
      getPendingSchemaStatements(withoutSchemaFor(db, 'unreadable_items'), {
        engineHint: 'sqlite',
      }),
    ).rejects.toThrow(
      /"unreadable_items" exists, but its schema could not be read/,
    );

    // All or nothing: the new table was not created either, and the build was
    // not recorded as migrated.
    expect(await tableNames(db)).toEqual(['unreadable_items']);
    expect(await readLastMigrateRecord(db, { engineHint: 'sqlite' })).toEqual(
      recordBefore,
    );

    // The same run on a handle that can read the table applies both changes.
    const result = await migrate(db, 'sqlite');
    expect(result).toMatchObject({ applied: true, refused: false });
    expect(await columnNames(db, 'unreadable_items')).toContain('note');
    expect(await tableNames(db)).toEqual([
      'unreadable_fresh',
      'unreadable_items',
    ]);
  });

  it.each([
    'sqlite',
    'duckdb',
  ] as const)('%s: an inspector exception or empty column description fails with the named error before DDL', async (engine) => {
    const db = await open(engine);
    registerVersion(1);
    await migrate(db, engine);
    const before = await readLastMigrateRecord(db, { engineHint: engine });
    registerVersion(2);
    for (const broken of ['throw', 'empty'] as const) {
      const handle = new Proxy(db, {
        get(target, key) {
          if (key === 'getTableSchema')
            return async (name: string) => {
              if (name !== 'unreadable_items')
                return target.getTableSchema?.(name);
              if (broken === 'throw') throw new Error('catalog unavailable');
              return {
                tableName: name,
                columns: {},
                indexes: [],
                foreignKeys: [],
              };
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      await expect(migrate(handle, engine)).rejects.toMatchObject({
        name: 'TableSchemaUnreadableError',
        table: 'unreadable_items',
        engine,
      });
      expect(await tableNames(db)).toEqual(['unreadable_items']);
      expect(await readLastMigrateRecord(db, { engineHint: engine })).toEqual(
        before,
      );
    }
  });

  it('SQLite: a reused comparer checks for a newly introduced temporary shadow on every run', async () => {
    const db = await open('sqlite');
    registerVersion(1);
    await migrate(db, 'sqlite');
    const comparer = new SchemaComparer(db, { engineHint: 'sqlite' });
    const schemas = ObjectRegistry.getAllSchemasAsDefinitions();
    await comparer.compare(schemas);
    await db.query(
      'CREATE TEMP TABLE unreadable_items (id TEXT PRIMARY KEY, title TEXT)',
    );
    await expect(comparer.compare(schemas)).rejects.toBeInstanceOf(
      TemporaryTableShadowError,
    );
  });

  it.each([
    'sqlite',
    'duckdb',
  ] as const)('%s: an inspector exception is named and keeps the original cause without applying a plan', async (engine) => {
    const db = await open(engine);
    registerVersion(1);
    await migrate(db, engine);
    const record = await readLastMigrateRecord(db, { engineHint: engine });
    registerVersion(2);
    const cause = new Error('inspection unavailable');
    const broken = new Proxy(db, {
      get(target, key, receiver) {
        if (key === 'getTableSchema')
          return async () => {
            throw cause;
          };
        const value = Reflect.get(target, key, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(migrate(broken, engine)).rejects.toMatchObject({
      name: 'TableSchemaUnreadableError',
      table: 'unreadable_items',
      engine,
      cause,
    });
    expect(await tableNames(db)).toEqual(['unreadable_items']);
    expect(await readLastMigrateRecord(db, { engineHint: engine })).toEqual(
      record,
    );
  });

  it('SQLite: an unreadable temporary catalog cannot bypass the safety check', async () => {
    const db = await open('sqlite');
    registerVersion(1);
    await migrate(db, 'sqlite');
    registerVersion(2);
    const handle = new Proxy(db, {
      get(target, key, receiver) {
        if (key === 'query')
          return async (...args: Parameters<DatabaseInterface['query']>) => {
            if (String(args[0]).includes('sqlite_temp_master'))
              throw new Error('catalog unavailable');
            return target.query(...args);
          };
        const value = Reflect.get(target, key, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(migrate(handle, 'sqlite')).rejects.toMatchObject({
      name: 'TableSchemaUnreadableError',
      table: 'unreadable_items',
    });
    expect(await tableNames(db)).toEqual(['unreadable_items']);
  });

  it('SQLite: a caller-owned transaction handle without an inspector is read through the handle, so the existing table is compared', async () => {
    const db = await open('sqlite');
    registerVersion(1);
    await migrate(db, 'sqlite');
    registerVersion(2);

    let inspectorOnHandle: boolean | undefined;
    const result = await db.transaction?.(async (tx) => {
      const scoped = queryOnly(tx as unknown as DatabaseInterface);
      inspectorOnHandle = typeof scoped.getTableSchema === 'function';
      return migrate(scoped, 'sqlite');
    });

    expect(inspectorOnHandle).toBe(false);
    expect(result).toMatchObject({ applied: true, refused: false });
    expect(result?.statements).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /ALTER TABLE "unreadable_items" ADD COLUMN "note"/,
        ),
        expect.stringMatching(/CREATE TABLE IF NOT EXISTS "unreadable_fresh"/),
      ]),
    );
    expect(await columnNames(db, 'unreadable_items')).toContain('note');
    // The record now describes a database that really has this schema.
    expect(
      (await getPendingSchemaStatements(db, { engineHint: 'sqlite' }))
        .statements,
    ).toEqual([]);
  });

  it('SQLite: a caller-owned transaction handle that has an inspector compares the existing table', async () => {
    const db = await open('sqlite');
    registerVersion(1);
    await migrate(db, 'sqlite');
    registerVersion(2);

    const result = await db.transaction?.((tx) =>
      migrate(tx as unknown as DatabaseInterface, 'sqlite'),
    );

    expect(result).toMatchObject({ applied: true, refused: false });
    expect(await columnNames(db, 'unreadable_items')).toContain('note');
  });

  it('SQLite: a handle without an inspector describes a table exactly as the database handle does', async () => {
    const db = await open('sqlite');
    await db.query('CREATE TABLE unreadable_parents (id TEXT PRIMARY KEY)');
    await db.query(`CREATE TABLE unreadable_shapes (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL DEFAULT 'none',
      amount INTEGER DEFAULT 0,
      ratio REAL,
      parent_id TEXT REFERENCES unreadable_parents(id) ON DELETE CASCADE ON UPDATE NO ACTION,
      label TEXT GENERATED ALWAYS AS (slug || '!') VIRTUAL,
      UNIQUE (slug, amount)
    )`);
    await db.query(
      'CREATE UNIQUE INDEX unreadable_shapes_slug_key ON unreadable_shapes (slug)',
    );
    await db.query(
      'CREATE INDEX unreadable_shapes_partial ON unreadable_shapes (amount DESC, "ratio") WHERE ratio IS NOT NULL',
    );
    await db.query(
      'CREATE INDEX unreadable_shapes_expr ON unreadable_shapes (lower(slug))',
    );
    await db.query(`CREATE TABLE unreadable_pairs (
      left_id TEXT NOT NULL, right_id TEXT NOT NULL, PRIMARY KEY (left_id, right_id)
    ) WITHOUT ROWID`);

    for (const table of [
      'unreadable_parents',
      'unreadable_shapes',
      'unreadable_pairs',
      'unreadable_absent',
    ]) {
      const fromDatabase = (await db.getTableSchema?.(table)) ?? null;
      // The one difference: the adapter marks only the first column of a
      // composite primary key as a key column, the reader marks every one.
      if (table === 'unreadable_pairs' && fromDatabase)
        for (const column of Object.values(fromDatabase.columns))
          column.primaryKey = true;
      const fromTransaction = await db.transaction?.((tx) =>
        inspectTableSchema(
          queryOnly(tx as unknown as DatabaseInterface),
          table,
          'sqlite',
        ),
      );
      expect(fromTransaction, table).toEqual(fromDatabase);
    }
  });

  it('SQLite: prototype-like SQL column names remain own columns and compare as unchanged', async () => {
    const db = await open('sqlite');
    await db.query(
      'CREATE TABLE unreadable_reserved (id TEXT PRIMARY KEY, "__proto__" TEXT, constructor TEXT, "toString" TEXT)',
    );
    const scoped = queryOnly(db);
    const described = await inspectTableSchema(
      scoped,
      'unreadable_reserved',
      'sqlite',
    );
    expect(Object.keys(described?.columns ?? {})).toEqual([
      'id',
      '__proto__',
      'constructor',
      'toString',
    ]);
    expect(Object.hasOwn(described?.columns ?? {}, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(described?.columns)).toBe(Object.prototype);
    const diff = await new SchemaComparer(scoped, {
      engineHint: 'sqlite',
    }).compare({
      unreadable_reserved: {
        tableName: 'unreadable_reserved',
        columns: Object.fromEntries(
          ['id', '__proto__', 'constructor', 'toString'].map((name) => [
            name,
            { type: 'TEXT' as const, primaryKey: name === 'id' },
          ]),
        ),
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: 'reserved-column-test',
      },
    });
    expect(diff.has_changes).toBe(false);
  });

  it('SQLite: a handle without an inspector describes an index whose name only resembles the internal prefix', async () => {
    const db = await open('sqlite');
    await db.query(
      'CREATE TABLE unreadable_named (id TEXT PRIMARY KEY, code TEXT)',
    );
    await db.query(
      'CREATE UNIQUE INDEX sqliteX_unique ON unreadable_named (code)',
    );

    const fromTransaction = await db.transaction?.((tx) =>
      inspectTableSchema(
        queryOnly(tx as unknown as DatabaseInterface),
        'unreadable_named',
        'sqlite',
      ),
    );
    expect(
      (fromTransaction?.indexes ?? []).map((index) => index.name),
    ).toContain('sqliteX_unique');
  });

  it('SQLite: a handle without an inspector sees a table its own transaction created', async () => {
    const db = await open('sqlite');
    registerVersion(1);

    const second = await db.transaction?.(async (tx) => {
      const scoped = queryOnly(tx as unknown as DatabaseInterface);
      const first = await migrate(scoped, 'sqlite');
      expect(first.applied).toBe(true);
      // Same transaction, same declarations: the table it just created is
      // read back and found in sync.
      return migrate(scoped, 'sqlite');
    });

    expect(second).toMatchObject({ applied: false, refused: false });
    expect(second?.statements).toEqual([]);
  });

  it('DuckDB: a handle without an inspector cannot describe an existing table and is refused by name', async () => {
    const db = await open('duckdb');
    registerVersion(1);
    await migrate(db, 'duckdb');
    registerVersion(2);

    const attempt = migrate(queryOnly(db), 'duckdb');
    await expect(attempt).rejects.toBeInstanceOf(TableSchemaUnreadableError);
    await expect(attempt).rejects.toMatchObject({
      table: 'unreadable_items',
      engine: 'duckdb',
    });
    expect(await tableNames(db)).toEqual(['unreadable_items']);

    // The database handle reads the table and applies the same plan.
    expect(await migrate(db, 'duckdb')).toMatchObject({
      applied: true,
      refused: false,
    });
    expect(await tableNames(db)).toEqual([
      'unreadable_fresh',
      'unreadable_items',
    ]);
  });

  it('SQLite reader: a DuckDB in-memory handle is unreadable by name, whatever its URL reads as', async () => {
    const db = await open('duckdb');
    await db.query(
      'CREATE TABLE unreadable_duck (id TEXT PRIMARY KEY, n INTEGER NOT NULL)',
    );

    const attempt = inspectTableSchema(
      queryOnly(db),
      'unreadable_duck',
      'sqlite',
    );
    await expect(attempt).rejects.toBeInstanceOf(TableSchemaUnreadableError);
    await expect(attempt).rejects.toMatchObject({ table: 'unreadable_duck' });
  });

  /** One declared table of text fields, registered under the test package. */
  function registerTable(tableName: string, fields: string[]) {
    ObjectRegistry.clear();
    class Declared extends SmrtObject {}
    for (const name of fields)
      field({ type: 'text' })(Declared.prototype, name);
    ObjectRegistry.register(Declared, { packageName: PACKAGE, tableName });
  }

  it('an unhinted DuckDB handle that only forwards exportTable is not taken for the JSON adapter, and is refused', async () => {
    const db = await open('duckdb');
    await db.query(
      'CREATE TABLE unreadable_items (id TEXT PRIMARY KEY, title TEXT)',
    );
    registerVersion(2);
    const recordBefore = await readLastMigrateRecord(db, {
      engineHint: 'duckdb',
    });

    await expect(
      migrateSmrtSchemas({
        db: queryOnly(db),
        packageName: PACKAGE,
        name: `unreadable_${randomUUID()}`,
      }),
    ).rejects.toBeInstanceOf(TableSchemaUnreadableError);
    expect(await tableNames(db)).toEqual(['unreadable_items']);
    expect(await readLastMigrateRecord(db, { engineHint: 'duckdb' })).toEqual(
      recordBefore,
    );
  });

  it('SQLite: a temporary table of the same name does not answer for the permanent table', async () => {
    const db = await open('sqlite');
    await db.query(
      'CREATE TABLE unreadable_shadow (id TEXT PRIMARY KEY, a TEXT)',
    );
    await db.query('CREATE INDEX unreadable_shadow_a ON unreadable_shadow (a)');
    await db.query(
      'CREATE TEMP TABLE unreadable_shadow (id TEXT PRIMARY KEY, a TEXT, only_temp TEXT)',
    );

    const described = await inspectTableSchema(
      queryOnly(db),
      'unreadable_shadow',
      'sqlite',
    );
    expect(Object.keys(described?.columns ?? {})).toEqual(['id', 'a']);
    expect(described?.indexes?.map((index) => index.name)).toEqual([
      'unreadable_shadow_a',
    ]);
  });

  it.each([
    'sqlite',
    'duckdb',
  ] as const)('%s: a declared table that the catalog holds under another spelling stops the migrate, changing nothing', async (engine) => {
    const db = await open(engine);
    await db.query(
      'CREATE TABLE "Unreadable_Cased" (id TEXT PRIMARY KEY, title TEXT)',
    );
    registerTable('unreadable_cased', ['title', 'note']);
    const recordBefore = await readLastMigrateRecord(db, {
      engineHint: engine,
    });

    const attempt = migrate(db, engine);
    await expect(attempt).rejects.toBeInstanceOf(TableSpellingMismatchError);
    await expect(attempt).rejects.toMatchObject({
      table: 'unreadable_cased',
      existingTable: 'Unreadable_Cased',
    });
    await expect(
      getPendingSchemaStatements(db, { engineHint: engine }),
    ).rejects.toBeInstanceOf(TableSpellingMismatchError);
    const columns = await db.query(
      `SELECT name FROM pragma_table_info('Unreadable_Cased')`,
    );
    expect(columns.rows.map((row) => String(row.name))).not.toContain('note');
    expect(await readLastMigrateRecord(db, { engineHint: engine })).toEqual(
      recordBefore,
    );
  });

  it('SQLite: the spelling refusal also applies through a handle without an inspector', async () => {
    const db = await open('sqlite');
    await db.query(
      'CREATE TABLE "Unreadable_Cased" (id TEXT PRIMARY KEY, title TEXT)',
    );
    registerTable('unreadable_cased', ['title', 'note']);

    await expect(migrate(queryOnly(db), 'sqlite')).rejects.toBeInstanceOf(
      TableSpellingMismatchError,
    );
  });

  it('SQLite: only ASCII letters fold, so a table whose name differs by a non-ASCII case is a different table', async () => {
    const db = await open('sqlite');
    await db.query('CREATE TABLE "unreadable_\u00c9" (id TEXT PRIMARY KEY)');
    registerTable('unreadable_\u00e9', ['title']);

    const result = await migrate(db, 'sqlite');

    expect(result.applied).toBe(true);
    const tables = await db.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'unreadable_%'",
    );
    expect(tables.rows).toHaveLength(2);
  });

  it.each([
    'sqlite',
    'duckdb',
  ] as const)('%s: a table spelled exactly as declared is compared and changed', async (engine) => {
    const db = await open(engine);
    await db.query(
      'CREATE TABLE unreadable_exact (id TEXT PRIMARY KEY, title TEXT)',
    );
    registerTable('unreadable_exact', ['title', 'note']);

    const result = await migrate(db, engine);

    expect(result.applied).toBe(true);
    const columns = await db.query(
      `SELECT name FROM pragma_table_info('unreadable_exact')`,
    );
    expect(columns.rows.map((row) => String(row.name))).toContain('note');
  });

  it('SQLite: a temporary table that shares the name of a declared table stops the migrate, changing nothing', async () => {
    const db = await open('sqlite');
    await db.query(
      'CREATE TABLE unreadable_shadowed (id TEXT PRIMARY KEY, title TEXT)',
    );
    await db.query(
      'CREATE TEMP TABLE unreadable_shadowed (id TEXT PRIMARY KEY, title TEXT)',
    );
    registerTable('unreadable_shadowed', ['title', 'note']);

    const attempt = migrate(db, 'sqlite');
    await expect(attempt).rejects.toBeInstanceOf(TemporaryTableShadowError);
    await expect(attempt).rejects.toMatchObject({
      table: 'unreadable_shadowed',
    });
    const permanent = await db.query(
      "SELECT * FROM pragma_table_info('unreadable_shadowed', 'main')",
    );
    expect(permanent.rows.map((row) => String(row.name))).not.toContain('note');
    const temporary = await db.query(
      "SELECT * FROM pragma_table_info('unreadable_shadowed', 'temp')",
    );
    expect(temporary.rows.map((row) => String(row.name))).not.toContain('note');

    // Without the temporary table the same declaration migrates the permanent one.
    await db.query('DROP TABLE temp.unreadable_shadowed');
    expect(await migrate(db, 'sqlite')).toMatchObject({ applied: true });
    const after = await db.query(
      "SELECT * FROM pragma_table_info('unreadable_shadowed', 'main')",
    );
    expect(after.rows.map((row) => String(row.name))).toContain('note');
  });

  it('SQLite: every column of a composite primary key is a key column, so an index on one of them survives an ordinary migrate', async () => {
    const db = await open('sqlite');
    await db.query(
      'CREATE TABLE unreadable_pairs2 (a TEXT, b TEXT, id TEXT, title TEXT, PRIMARY KEY (a, b))',
    );
    await db.query('CREATE INDEX unreadable_pairs2_a ON unreadable_pairs2 (a)');
    registerTable('unreadable_pairs2', ['title']);

    const described = await inspectTableSchema(
      queryOnly(db),
      'unreadable_pairs2',
      'sqlite',
    );
    expect(described?.columns.a?.primaryKey).toBe(true);
    expect(described?.columns.b?.primaryKey).toBe(true);

    const pending = await getPendingSchemaStatements(queryOnly(db), {
      engineHint: 'sqlite',
    });
    expect(pending.statements.join('\n')).not.toMatch(
      /DROP INDEX[^;]*unreadable_pairs2_a/,
    );
  });

  it('JSON adapter: existing tables take their shape from their data and are still not compared', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'smrt-unreadable-json-'));
    const db = (await getDatabase({
      type: 'json',
      url: directory,
    })) as DatabaseInterface;
    try {
      await db.query('CREATE TABLE unreadable_items (id TEXT PRIMARY KEY)');
      registerVersion(2);
      expect(typeof db.getTableSchema).toBe('undefined');

      const diff = await new SchemaComparer(db, { engineHint: 'json' }).compare(
        ObjectRegistry.getAllSchemasAsDefinitions(),
      );

      expect(
        diff.changes.filter((change) => change.table === 'unreadable_items'),
      ).toEqual([]);
      expect(diff.added_tables.map((table) => table.tableName)).toEqual([
        'unreadable_fresh',
      ]);
    } finally {
      await db.close?.();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
