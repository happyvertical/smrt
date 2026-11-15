/**
 * #4937 review note (Q3): the SQLite rebuild is planned as if foreign keys were
 * suspended, and `PRAGMA foreign_keys = OFF` does nothing inside a transaction.
 * A caller that runs the statements itself, inside a transaction with foreign
 * keys on, must never lose the rows of a child table that cascades.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ObjectRegistry } from '../../registry.js';
import type { SchemaDefinition } from '../../schema/types.js';
import { getSQLFromDiff, SchemaComparer } from '../differ.js';
import { getPendingSchemaStatements } from '../orchestrate.js';
import {
  buildSqliteRebuildStatements,
  planSqliteTableRebuilds,
  sqliteRebuildPlaceholderSql,
} from '../sqlite-rebuild.js';
import { MigrationTracker } from '../tracker.js';

const manifest = (priceType: 'REAL' | 'INTEGER'): SchemaDefinition => ({
  tableName: 'products',
  ddl: '',
  columns: {
    id: { type: 'TEXT', primaryKey: true },
    name: { type: 'TEXT' },
    price: { type: priceType },
  },
  indexes: [],
  triggers: [],
  foreignKeys: [],
  dependencies: [],
  version: '4937',
});

const PRODUCTS =
  'CREATE TABLE "products" ("id" TEXT PRIMARY KEY, "name" TEXT, "price" INTEGER)';
const CHILD =
  'CREATE TABLE "order_lines" ("id" TEXT PRIMARY KEY, "product_id" TEXT REFERENCES "products"("id") ON DELETE CASCADE)';

describe('a caller that runs SQLite rebuild statements itself (#4937)', () => {
  let db: DatabaseInterface;
  beforeEach(async () => {
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    await db.query('PRAGMA foreign_keys = ON');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.close?.();
  });

  async function seed(withChild = true): Promise<void> {
    await db.query(PRODUCTS);
    await db.query(`INSERT INTO "products" VALUES ('p1', 'Widget', 3)`);
    if (withChild) {
      await db.query(CHILD);
      await db.query(`INSERT INTO "order_lines" VALUES ('l1', 'p1')`);
    }
  }
  const children = async () =>
    (await db.query('SELECT id FROM "order_lines"')).rows;

  /** Run the statements the way a caller with its own transaction would. */
  async function runInCallerTransaction(statements: string[]): Promise<void> {
    await db.transaction?.(async (tx) => {
      for (const sql of statements) await tx.query(sql);
    });
  }
  /** The caller's own transaction refuses the plan and rolls it back. */
  async function expectRefused(statements: string[]): Promise<void> {
    expect(statements.length).toBeGreaterThan(0);
    await expect(runInCallerTransaction(statements)).rejects.toThrow(
      /foreign keys are on/,
    );
    expect(await children()).toEqual([{ id: 'l1' }]);
    expect(
      (await db.query('SELECT typeof(price) AS t FROM "products"')).rows[0],
    ).toEqual({ t: 'integer' });
  }
  const executable = (statements: string[]) =>
    statements.filter((sql) => !sql.trim().startsWith('--'));

  it('getSQLFromDiff statements do not delete child rows', async () => {
    await seed();
    const diff = await new SchemaComparer(db, { engineHint: 'sqlite' }).compare(
      {
        products: manifest('REAL'),
      },
    );
    const statements = executable(getSQLFromDiff(diff));
    await expectRefused(statements);
  });

  it('getPendingSchemaStatements().statements do not delete child rows', async () => {
    await seed();
    vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockReturnValue({
      products: manifest('REAL'),
    });
    const pending = await getPendingSchemaStatements(db, {
      engineHint: 'sqlite',
    });
    const statements = executable(pending.statements);
    await expectRefused(statements);
  });

  it('planSqliteTableRebuilds gives no plan for a referenced table by default', async () => {
    await seed();
    const [change] = await planSqliteTableRebuilds({
      db,
      tableName: 'products',
      mapType: () => 'REAL',
      changes: [
        {
          type: 'type_upgrade',
          table: 'products',
          name: 'price',
          column: { type: 'REAL' },
          sql: sqliteRebuildPlaceholderSql('price'),
        },
      ],
    });
    expect(change.sqlStatements).toBeUndefined();
    expect(change.advisory?.message ?? change.sql).toMatch(
      /foreign key|ON DELETE/,
    );
    expect(change.kindHint).toBe('type.rebuild-data-loss');
  });

  it('the data-loss change kinds are still produced by a direct planner call, never by the differ', async () => {
    await seed();
    const [direct] = await planSqliteTableRebuilds({
      db,
      tableName: 'products',
      mapType: () => 'TEXT',
      changes: [
        {
          type: 'alter_column',
          table: 'products',
          name: 'name',
          alteration: 'set_not_null',
          column: { type: 'TEXT' },
          mismatch: { expected: 'NOT NULL', actual: 'NULL' },
          sql: '-- products.name requires table recreation to set NOT NULL',
        },
      ],
    });
    expect(direct.kindHint).toBe('column.rebuild-data-loss');
    // The differ plans for the tracker (foreign keys suspended), so a referenced
    // table is planned, not refused as a data loss.
    const diff = await new SchemaComparer(db, { engineHint: 'sqlite' }).compare(
      {
        products: manifest('REAL'),
      },
    );
    expect(
      diff.changes.map((change) => change.kindHint).filter(Boolean),
    ).toEqual([]);
  });

  it('planSqliteTableRebuilds relaxation statements do not delete child rows', async () => {
    await db.query(
      'CREATE TABLE "products" ("id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "price" INTEGER)',
    );
    await db.query(`INSERT INTO "products" VALUES ('p1', 'Widget', 3)`);
    await db.query(CHILD);
    await db.query(`INSERT INTO "order_lines" VALUES ('l1', 'p1')`);
    const planned = await planSqliteTableRebuilds({
      db,
      tableName: 'products',
      mapType: () => 'TEXT',
      changes: [
        {
          type: 'alter_column',
          table: 'products',
          name: 'name',
          alteration: 'drop_not_null',
          column: { type: 'TEXT' },
          mismatch: { expected: 'NULL', actual: 'NOT NULL' },
          sql: '-- products.name requires table recreation to drop NOT NULL',
        },
      ],
    });
    const statements = planned.flatMap((change) => change.sqlStatements ?? []);
    expect(statements.length).toBeGreaterThan(0);
    await expect(
      runInCallerTransaction(executable(statements)),
    ).rejects.toThrow(/foreign keys are on/);
    expect(await children()).toEqual([{ id: 'l1' }]);
    expect((await db.query('SELECT "name" FROM "products"')).rows).toEqual([
      { name: 'Widget' },
    ]);
  });

  it('buildSqliteRebuildStatements output does not delete child rows', async () => {
    await seed();
    const plan = buildSqliteRebuildStatements({
      tableName: 'products',
      createTableSql: PRODUCTS,
      columnTypes: new Map([['price', 'REAL']]),
      columns: ['id', 'name', 'price'],
      objects: [],
      legacyAlterTable: false,
    });
    expect(plan).not.toBeNull();
    await runInCallerTransaction(plan?.statements ?? []).catch(() => undefined);
    expect(await children()).toEqual([{ id: 'l1' }]);
  });

  it('a plan made while foreign keys were off still refuses where they are on', async () => {
    await seed();
    await db.query('PRAGMA foreign_keys = OFF');
    const diff = await new SchemaComparer(db, { engineHint: 'sqlite' }).compare(
      {
        products: manifest('REAL'),
      },
    );
    const statements = executable(getSQLFromDiff(diff));
    await db.query('PRAGMA foreign_keys = ON');
    await expectRefused(statements);
  });

  it('a caller that has checked nothing references the table may skip the guard', async () => {
    await seed(false);
    const plan = buildSqliteRebuildStatements({
      tableName: 'products',
      createTableSql: PRODUCTS,
      columnTypes: new Map([['price', 'REAL']]),
      columns: ['id', 'name', 'price'],
      objects: [],
      legacyAlterTable: false,
      inboundReferences: [],
    });
    await runInCallerTransaction(plan?.statements ?? []);
    expect(
      (await db.query('SELECT typeof(price) AS t FROM "products"')).rows[0],
    ).toEqual({ t: 'real' });
  });

  it('a table nothing references still rebuilds in a caller transaction', async () => {
    await seed(false);
    const diff = await new SchemaComparer(db, { engineHint: 'sqlite' }).compare(
      {
        products: manifest('REAL'),
      },
    );
    await runInCallerTransaction(executable(getSQLFromDiff(diff)));
    const row = (await db.query('SELECT typeof(price) AS t FROM "products"'))
      .rows[0];
    expect(row).toEqual({ t: 'real' });
  });

  it('the tracker still applies the same plan and keeps the child rows', async () => {
    await seed();
    const diff = await new SchemaComparer(db, { engineHint: 'sqlite' }).compare(
      {
        products: manifest('REAL'),
      },
    );
    const [result] = await new MigrationTracker({ db }).applyAll(
      [
        {
          id: 'rebuild_products_4937',
          description: 'rebuild',
          version: '1.0.0',
          up: executable(getSQLFromDiff(diff)),
          down: [],
        },
      ],
      { atomic: true },
    );
    expect(result.error).toBeUndefined();
    expect(await children()).toEqual([{ id: 'l1' }]);
    expect((await db.query('PRAGMA foreign_keys')).rows[0]).toEqual({
      foreign_keys: 1,
    });
  });
});
