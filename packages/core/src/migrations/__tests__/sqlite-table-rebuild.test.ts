/**
 * Issue #2370 — SQLite table-rebuild migration.
 *
 * SQLite has no `ALTER TABLE ... ALTER COLUMN ... TYPE`, so before this the
 * differ emitted an advisory comment for every type-bucket change and
 * `db:migrate` exited 1 with "manual intervention required" forever. These
 * tests run the rebuild against real in-memory SQLite and assert the two
 * things a rebuild must never get wrong: the rows survive, and the schema
 * objects that died with the dropped table come back.
 */

import type { DatabaseProvider } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SchemaDefinition } from '../../schema/types.js';
import { getSQLFromDiff, SchemaComparer } from '../differ.js';
import {
  isSqliteRebuildPlaceholder,
  parseCreateTableBody,
  readColumnDefinitionName,
  replaceColumnType,
  rewriteSqliteCreateTable,
} from '../sqlite-rebuild.js';
import { MigrationTracker } from '../tracker.js';

/**
 * The DDL a migration runner would actually execute: `getSQLFromDiff` still
 * carries the differ's advisory comments, which the orchestrator and the CLI
 * both filter out before handing statements to the tracker.
 */
function executableSql(diff: { changes: { sql?: string }[] }): string[] {
  return getSQLFromDiff(diff as Parameters<typeof getSQLFromDiff>[0]).filter(
    (sql) => !sql.trim().startsWith('--'),
  );
}

/** Manifest for `products` where `price` is declared REAL (`0.0`). */
function productsManifest(
  priceType: 'REAL' | 'INTEGER' = 'REAL',
  extra: Record<string, { type: 'TEXT' | 'INTEGER' | 'REAL' }> = {},
): Record<string, SchemaDefinition> {
  return {
    products: {
      tableName: 'products',
      ddl: '',
      columns: {
        id: { type: 'TEXT', primaryKey: true },
        name: { type: 'TEXT' },
        price: { type: priceType },
        ...extra,
      },
      indexes: [
        { name: 'products_name_idx', columns: ['name'] },
        { name: 'products_price_idx', columns: ['price'] },
      ],
      triggers: [],
      foreignKeys: [],
      dependencies: [],
      version: '1.0.0',
    },
  };
}

describe('#2370 SQLite table rebuild — pure DDL rewriting', () => {
  it('retypes only the requested column and preserves everything else', () => {
    const rewritten = rewriteSqliteCreateTable(
      `CREATE TABLE "products" (\n  "id" TEXT PRIMARY KEY,\n  "name" TEXT NOT NULL DEFAULT 'x, y',\n  "price" INTEGER DEFAULT 0 CHECK ("price" >= 0)\n)`,
      {
        tableName: '_smrt_rebuild_products',
        columnTypes: new Map([['price', 'REAL']]),
      },
    );

    expect(rewritten).toContain('CREATE TABLE "_smrt_rebuild_products"');
    expect(rewritten).toContain('"price" REAL DEFAULT 0 CHECK ("price" >= 0)');
    expect(rewritten).toContain(`"name" TEXT NOT NULL DEFAULT 'x, y'`);
    expect(rewritten).toContain('"id" TEXT PRIMARY KEY');
  });

  it('preserves table-level constraints and trailing table options', () => {
    const rewritten = rewriteSqliteCreateTable(
      `CREATE TABLE "t" ("a" TEXT, "b" INTEGER, UNIQUE ("a", "b"), CHECK ("b" > 0)) WITHOUT ROWID`,
      { tableName: 't_new', columnTypes: new Map([['b', 'REAL']]) },
    );

    expect(rewritten).toContain('"b" REAL');
    expect(rewritten).toContain('UNIQUE ("a", "b")');
    expect(rewritten).toContain('CHECK ("b" > 0)');
    expect(rewritten?.endsWith('WITHOUT ROWID')).toBe(true);
  });

  it('refuses to rewrite when the target column is absent', () => {
    expect(
      rewriteSqliteCreateTable(`CREATE TABLE "t" ("a" TEXT)`, {
        tableName: 't_new',
        columnTypes: new Map([['missing', 'REAL']]),
      }),
    ).toBeNull();
  });

  it('splits the body on top-level commas only', () => {
    const parsed = parseCreateTableBody(
      `CREATE TABLE "t" ("a" VARCHAR(10) DEFAULT 'a,b', "b" NUMERIC(10, 2), PRIMARY KEY ("a", "b"))`,
    );

    expect(parsed?.items).toHaveLength(3);
    expect(parsed?.items[1]).toBe('"b" NUMERIC(10, 2)');
  });

  it('classifies table constraints as non-column items', () => {
    expect(readColumnDefinitionName('"a" TEXT')).toBe('a');
    expect(readColumnDefinitionName('PRIMARY KEY ("a")')).toBeNull();
    expect(readColumnDefinitionName('CONSTRAINT c CHECK (1)')).toBeNull();
    // A quoted identifier that happens to spell a constraint keyword is still
    // a column.
    expect(readColumnDefinitionName('"check" TEXT')).toBe('check');
  });

  it('replaces sized types and adds one to an untyped column', () => {
    expect(replaceColumnType('"a" VARCHAR(255) NOT NULL', 'TEXT')).toBe(
      '"a" TEXT NOT NULL',
    );
    expect(replaceColumnType('"a" DOUBLE PRECISION', 'REAL')).toBe('"a" REAL');
    expect(replaceColumnType('"a" NOT NULL', 'REAL')).toBe('"a" REAL NOT NULL');
  });
});

describe('#2370 SQLite table rebuild — live database', () => {
  let db: DatabaseProvider;

  beforeEach(async () => {
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      try {
        await db.close();
      } catch {
        // ignore
      }
    }
  });

  async function seedProducts(): Promise<void> {
    await db.query(
      `CREATE TABLE "products" (
        "id" TEXT PRIMARY KEY,
        "name" TEXT NOT NULL DEFAULT '',
        "price" INTEGER DEFAULT 0
      )`,
    );
    await db.query(`CREATE INDEX "products_name_idx" ON "products" ("name")`);
    await db.query(
      `CREATE UNIQUE INDEX "products_premium_idx" ON "products" ("name") WHERE "price" > 100`,
    );
    await db.query(
      `CREATE TRIGGER "products_guard" BEFORE DELETE ON "products" BEGIN SELECT 1; END`,
    );
    await db.query(
      `INSERT INTO "products" ("id", "name", "price") VALUES ('p1', 'Widget', 3)`,
    );
    await db.query(
      `INSERT INTO "products" ("id", "name", "price") VALUES ('p2', 'Gadget', 0)`,
    );
  }

  it('emits an executable rebuild instead of a "requires table recreation" comment', async () => {
    await seedProducts();

    const diff = await new SchemaComparer(db).compare(productsManifest());
    const upgrades = diff.changes.filter((c) => c.type === 'type_upgrade');

    expect(upgrades).toHaveLength(1);
    expect(upgrades[0].name).toBe('price');
    expect(isSqliteRebuildPlaceholder(upgrades[0].sql)).toBe(false);

    const statements = upgrades[0].sqlStatements ?? [];
    expect(statements.some((s) => s.startsWith('--'))).toBe(false);
    expect(statements).toEqual(
      expect.arrayContaining([
        'PRAGMA defer_foreign_keys = ON',
        'DROP TABLE IF EXISTS "_smrt_rebuild_products"',
        'DROP TABLE "products"',
        'ALTER TABLE "_smrt_rebuild_products" RENAME TO "products"',
      ]),
    );
    expect(
      statements.some((s) => /^CREATE TABLE "_smrt_rebuild_products"/.test(s)),
    ).toBe(true);
    // The rebuild must be part of the executable statement stream now.
    expect(getSQLFromDiff(diff).length).toBeGreaterThan(0);
  });

  it('applies the rebuild through the tracker, preserving rows and recreating indexes/triggers', async () => {
    await seedProducts();

    const diff = await new SchemaComparer(db).compare(productsManifest());
    const statements = executableSql(diff);

    const tracker = new MigrationTracker({ db });
    const [result] = await tracker.applyAll(
      [
        {
          id: 'type_upgrade_products_price',
          description: 'rebuild products for price REAL',
          version: '1.0.0',
          up: statements,
          down: [],
        },
      ],
      { atomic: true },
    );

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);

    // Data preserved, and INTEGER values are now stored as REAL.
    const rows = (
      await db.query(
        `SELECT "id", "name", "price", typeof("price") AS price_type FROM "products" ORDER BY "id"`,
      )
    ).rows as {
      id: string;
      name: string;
      price: number;
      price_type: string;
    }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: 'p1', name: 'Widget', price: 3 });
    expect(rows[0].price_type).toBe('real');
    expect(rows[1]).toMatchObject({ id: 'p2', name: 'Gadget', price: 0 });

    // The declared column type changed.
    const columns = (await db.query(`PRAGMA table_info("products")`)).rows as {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }[];
    const price = columns.find((c) => c.name === 'price');
    expect(price?.type).toBe('REAL');
    expect(price?.dflt_value).toBe('0');
    // Untouched columns keep their constraints.
    const name = columns.find((c) => c.name === 'name');
    expect(name?.notnull).toBe(1);
    expect(columns.find((c) => c.name === 'id')?.pk).toBe(1);

    // Indexes (including the partial one) and the trigger are back.
    const objects = (
      await db.query(
        `SELECT name, type, sql FROM sqlite_master WHERE tbl_name = 'products' AND sql IS NOT NULL ORDER BY name`,
      )
    ).rows as { name: string; type: string; sql: string }[];
    const names = objects.map((o) => o.name);
    expect(names).toContain('products_name_idx');
    expect(names).toContain('products_premium_idx');
    expect(names).toContain('products_guard');
    expect(
      objects.find((o) => o.name === 'products_premium_idx')?.sql,
    ).toContain('WHERE "price" > 100');

    // The staging table is gone and the connection pragma was restored.
    const staging = (
      await db.query(
        `SELECT name FROM sqlite_master WHERE name = '_smrt_rebuild_products'`,
      )
    ).rows;
    expect(staging).toHaveLength(0);
    const legacy = (await db.query('PRAGMA legacy_alter_table')).rows[0] as {
      legacy_alter_table: number;
    };
    expect(legacy.legacy_alter_table).toBe(0);

    // And the drift is gone: a re-diff sees no type upgrade.
    const reDiff = await new SchemaComparer(db).compare(productsManifest());
    expect(
      reDiff.changes.filter((c) => c.type === 'type_upgrade'),
    ).toHaveLength(0);
  });

  it('rebuilds every drifted column of a table in one pass', async () => {
    await db.query(
      `CREATE TABLE "products" (
        "id" TEXT PRIMARY KEY,
        "name" TEXT,
        "price" INTEGER,
        "weight" INTEGER
      )`,
    );
    await db.query(
      `INSERT INTO "products" ("id", "name", "price", "weight") VALUES ('p1', 'Widget', 2, 5)`,
    );

    const manifest = productsManifest('REAL', { weight: { type: 'REAL' } });
    const diff = await new SchemaComparer(db).compare(manifest);
    const upgrades = diff.changes.filter((c) => c.type === 'type_upgrade');

    // Two drifted columns, one rebuild: the second is a no-op comment that
    // points at the first (the CLI classifies it `noop` and drops it).
    expect(upgrades).toHaveLength(2);
    expect(upgrades[0].sqlStatements?.length).toBeGreaterThan(0);
    expect(upgrades[1].sqlStatements).toBeUndefined();
    expect(upgrades[1].sql).toContain('no change needed');

    const tracker = new MigrationTracker({ db });
    const [result] = await tracker.applyAll(
      [
        {
          id: 'rebuild_products',
          description: 'rebuild',
          version: '1.0.0',
          up: executableSql(diff),
          down: [],
        },
      ],
      { atomic: true },
    );
    expect(result.success).toBe(true);

    const columns = (await db.query(`PRAGMA table_info("products")`)).rows as {
      name: string;
      type: string;
    }[];
    expect(columns.find((c) => c.name === 'price')?.type).toBe('REAL');
    expect(columns.find((c) => c.name === 'weight')?.type).toBe('REAL');
    expect(
      (await db.query(`SELECT COUNT(*) AS n FROM "products"`)).rows[0],
    ).toMatchObject({ n: 1 });
  });

  it('preserves columns the manifest no longer declares', async () => {
    await db.query(
      `CREATE TABLE "products" (
        "id" TEXT PRIMARY KEY,
        "name" TEXT,
        "price" INTEGER,
        "legacy_note" TEXT
      )`,
    );
    await db.query(
      `INSERT INTO "products" VALUES ('p1', 'Widget', 7, 'keep me')`,
    );

    const diff = await new SchemaComparer(db).compare(productsManifest());
    const tracker = new MigrationTracker({ db });
    const [result] = await tracker.applyAll(
      [
        {
          id: 'rebuild_products',
          description: 'rebuild',
          version: '1.0.0',
          up: executableSql(diff),
          down: [],
        },
      ],
      { atomic: true },
    );
    expect(result.success).toBe(true);

    const row = (await db.query(`SELECT * FROM "products"`)).rows[0] as {
      legacy_note: string;
      price: number;
    };
    expect(row.legacy_note).toBe('keep me');
    expect(row.price).toBe(7);
  });

  it('refuses the rebuild when another table has a foreign key onto it', async () => {
    await seedProducts();
    await db.query(
      `CREATE TABLE "order_lines" (
        "id" TEXT PRIMARY KEY,
        "product_id" TEXT REFERENCES "products"("id") ON DELETE CASCADE
      )`,
    );
    await db.query(`INSERT INTO "order_lines" VALUES ('l1', 'p1')`);

    // Guard the premise: this adapter enables foreign-key enforcement, which
    // makes DROP TABLE cascade-delete the child rows.
    const enforcement = (await db.query('PRAGMA foreign_keys')).rows[0] as {
      foreign_keys: number;
    };
    expect(enforcement.foreign_keys).toBe(1);

    const diff = await new SchemaComparer(db).compare(productsManifest());
    const upgrades = diff.changes.filter((c) => c.type === 'type_upgrade');

    expect(upgrades).toHaveLength(1);
    expect(upgrades[0].sqlStatements).toBeUndefined();
    expect(upgrades[0].sql?.startsWith('--')).toBe(true);
    expect(upgrades[0].sql).toContain('order_lines');
    // No rebuild DDL is emitted, so the child rows are never at risk.
    expect(
      getSQLFromDiff(diff).filter((sql) => sql.includes('_smrt_rebuild_')),
    ).toEqual([]);
    expect(
      (await db.query(`SELECT COUNT(*) AS n FROM "order_lines"`)).rows[0],
    ).toMatchObject({ n: 1 });
  });

  it('refuses the rebuild when the table references itself', async () => {
    // The staging table copies the self-reference verbatim, which makes it a
    // child of the live table — so `DROP TABLE` cascades the *staged* rows
    // away and the rebuild would silently lose data.
    await db.query(
      `CREATE TABLE "products" (
        "id" TEXT PRIMARY KEY,
        "name" TEXT,
        "price" INTEGER,
        "parent_id" TEXT REFERENCES "products"("id") ON DELETE CASCADE
      )`,
    );
    await db.query(`INSERT INTO "products" VALUES ('p1', 'Widget', 1, NULL)`);
    await db.query(`INSERT INTO "products" VALUES ('p2', 'Part', 2, 'p1')`);

    const diff = await new SchemaComparer(db).compare(productsManifest());
    const upgrades = diff.changes.filter((c) => c.type === 'type_upgrade');

    expect(upgrades).toHaveLength(1);
    expect(upgrades[0].sqlStatements).toBeUndefined();
    expect(upgrades[0].sql).toContain('products');
    expect(
      getSQLFromDiff(diff).filter((sql) => sql.includes('_smrt_rebuild_')),
    ).toEqual([]);
  });

  it('rolls the table back intact when a later statement in the batch fails', async () => {
    await seedProducts();

    const diff = await new SchemaComparer(db).compare(productsManifest());
    const tracker = new MigrationTracker({ db });
    const results = await tracker.applyAll(
      [
        {
          id: 'rebuild_products',
          description: 'rebuild',
          version: '1.0.0',
          up: [...executableSql(diff), 'SELECT this_is_not_valid_sql()'],
          down: [],
        },
      ],
      { atomic: true },
    );

    expect(results[0].success).toBe(false);

    // Original shape and data intact.
    const columns = (await db.query(`PRAGMA table_info("products")`)).rows as {
      name: string;
      type: string;
    }[];
    expect(columns.find((c) => c.name === 'price')?.type).toBe('INTEGER');
    expect(
      (await db.query(`SELECT COUNT(*) AS n FROM "products"`)).rows[0],
    ).toMatchObject({ n: 2 });
    expect(
      (
        await db.query(
          `SELECT COUNT(*) AS n FROM sqlite_master WHERE tbl_name = 'products' AND type = 'index' AND sql IS NOT NULL`,
        )
      ).rows[0],
    ).toMatchObject({ n: 2 });
  });
});
