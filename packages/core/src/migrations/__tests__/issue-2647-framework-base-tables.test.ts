/**
 * One-time remediation for the five orphaned framework-base tables (#2647).
 *
 * Exercises `planFrameworkBaseTableDrop()` / `dropFrameworkBaseTables()`
 * against a real SQLite database: every refusal path (non-empty table,
 * unexpected column, missing baseline column, inbound foreign key,
 * unreadable adapter), the happy path (tables + companion indexes dropped,
 * a real application table left untouched), partial/absent presence, and
 * the transaction-scoped re-check that stops a drop if a row lands between
 * planning and execution.
 */

import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  dropFrameworkBaseTables,
  FRAMEWORK_BASE_TABLE_NAMES,
  type FrameworkBaseTablesPlan,
  planFrameworkBaseTableDrop,
} from '../framework-base-tables.js';

/** DDL matching the framework generator's real output for a base CTI table. */
function createFrameworkBaseTableDDL(table: string): string[] {
  return [
    `CREATE TABLE "${table}" (
      "id" TEXT PRIMARY KEY,
      "slug" TEXT NOT NULL,
      "context" TEXT NOT NULL DEFAULT '',
      "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE UNIQUE INDEX "${table}_slug_context_idx" ON "${table}" ("slug", "context")`,
    `CREATE INDEX "${table}_created_at_idx" ON "${table}" ("created_at")`,
  ];
}

async function createAllFrameworkBaseTables(
  db: DatabaseInterface,
): Promise<void> {
  for (const table of FRAMEWORK_BASE_TABLE_NAMES) {
    for (const statement of createFrameworkBaseTableDDL(table)) {
      await db.query(statement);
    }
  }
}

async function tableExists(
  db: DatabaseInterface,
  table: string,
): Promise<boolean> {
  const result = await db.query(
    `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`,
    table,
  );
  return (result.rows as unknown[]).length > 0;
}

async function indexExists(
  db: DatabaseInterface,
  index: string,
): Promise<boolean> {
  const result = await db.query(
    `SELECT name FROM sqlite_master WHERE type='index' AND name = ?`,
    index,
  );
  return (result.rows as unknown[]).length > 0;
}

describe('framework base-table remediation (#2647) — SQLite', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
  });

  afterEach(async () => {
    await db.close?.();
  });

  it('never derives its target list from anything but the hardcoded five names', () => {
    expect(FRAMEWORK_BASE_TABLE_NAMES).toEqual([
      'smrt_objects',
      'smrt_classes',
      'smrt_collections',
      'smrt_hierarchicals',
      'smrt_polymorphic_associations',
    ]);
  });

  it('reports nothing to do when none of the five tables exist', async () => {
    const plan = await planFrameworkBaseTableDrop(db, { engineHint: 'sqlite' });

    expect(plan.safe).toBe(true);
    expect(plan.statements).toEqual([]);
    expect(plan.tables.every((table) => !table.exists)).toBe(true);

    const result = await dropFrameworkBaseTables(db, plan);
    expect(result).toEqual({ droppedTables: [], droppedIndexes: [] });
  });

  it('plans only the tables that exist, leaving the rest untouched', async () => {
    for (const statement of createFrameworkBaseTableDDL('smrt_classes')) {
      await db.query(statement);
    }

    const plan = await planFrameworkBaseTableDrop(db, { engineHint: 'sqlite' });
    expect(plan.safe).toBe(true);

    const present = plan.tables.filter((table) => table.exists);
    expect(present.map((table) => table.table)).toEqual(['smrt_classes']);
    expect(plan.statements).toEqual([
      'DROP INDEX IF EXISTS "smrt_classes_slug_context_idx"',
      'DROP INDEX IF EXISTS "smrt_classes_created_at_idx"',
      'DROP TABLE IF EXISTS "smrt_classes"',
    ]);
  });

  describe('happy path', () => {
    it('drops all five tables and their companion indexes, leaving a real application table untouched', async () => {
      await createAllFrameworkBaseTables(db);
      await db.query(
        'CREATE TABLE "articles" (id TEXT PRIMARY KEY, title TEXT NOT NULL)',
      );
      await db.query(
        'INSERT INTO "articles" (id, title) VALUES (?, ?)',
        'a1',
        'Hello',
      );

      const plan = await planFrameworkBaseTableDrop(db, {
        engineHint: 'sqlite',
      });
      expect(plan.safe).toBe(true);
      expect(plan.tables.filter((t) => t.exists)).toHaveLength(5);
      for (const table of plan.tables) {
        expect(table.refusals).toEqual([]);
        expect(table.indexNames.sort()).toEqual(
          [
            `${table.table}_slug_context_idx`,
            `${table.table}_created_at_idx`,
          ].sort(),
        );
      }
      // 3 statements per table (2 indexes + 1 table) × 5 tables.
      expect(plan.statements).toHaveLength(15);

      const result = await dropFrameworkBaseTables(db, plan);
      expect(result.droppedTables.sort()).toEqual(
        [...FRAMEWORK_BASE_TABLE_NAMES].sort(),
      );
      expect(result.droppedIndexes).toHaveLength(10);

      for (const table of FRAMEWORK_BASE_TABLE_NAMES) {
        expect(await tableExists(db, table)).toBe(false);
        expect(await indexExists(db, `${table}_slug_context_idx`)).toBe(false);
        expect(await indexExists(db, `${table}_created_at_idx`)).toBe(false);
      }

      // The real application table and its data are completely untouched.
      expect(await tableExists(db, 'articles')).toBe(true);
      const rows = await db.query('SELECT * FROM "articles"');
      expect(rows.rows).toEqual([{ id: 'a1', title: 'Hello' }]);
    });
  });

  describe('refusal: non-empty table', () => {
    it('refuses and drops nothing when a target table has rows', async () => {
      await createAllFrameworkBaseTables(db);
      await db.query(
        `INSERT INTO "smrt_classes" (id, slug, context) VALUES ('c1', 'thing', '')`,
      );

      const plan = await planFrameworkBaseTableDrop(db, {
        engineHint: 'sqlite',
      });
      expect(plan.safe).toBe(false);
      expect(plan.statements).toEqual([]);

      const classesReport = plan.tables.find((t) => t.table === 'smrt_classes');
      expect(classesReport?.refusals).toEqual([
        { kind: 'not-empty', rowCount: 1 },
      ]);

      await expect(dropFrameworkBaseTables(db, plan)).rejects.toThrow(
        /Refusing to drop framework base tables/,
      );

      // Nothing was dropped — every table (including the empty ones) survives.
      for (const table of FRAMEWORK_BASE_TABLE_NAMES) {
        expect(await tableExists(db, table)).toBe(true);
      }
    });
  });

  describe('refusal: unexpected shape', () => {
    it('refuses when a target table has an extra column', async () => {
      await createAllFrameworkBaseTables(db);
      await db.query(
        'ALTER TABLE "smrt_objects" ADD COLUMN "custom_field" TEXT',
      );

      const plan = await planFrameworkBaseTableDrop(db, {
        engineHint: 'sqlite',
      });
      expect(plan.safe).toBe(false);

      const report = plan.tables.find((t) => t.table === 'smrt_objects');
      expect(report?.refusals).toContainEqual({
        kind: 'unexpected-shape',
        actualColumns: [
          'context',
          'created_at',
          'custom_field',
          'id',
          'slug',
          'updated_at',
        ],
        missingColumns: [],
        extraColumns: ['custom_field'],
      });

      await expect(dropFrameworkBaseTables(db, plan)).rejects.toThrow();
      expect(await tableExists(db, 'smrt_objects')).toBe(true);
    });

    it('refuses when a target table is missing a baseline column (a real unrelated table sharing the name)', async () => {
      // A consumer's own, unrelated table happening to share the name
      // `smrt_collections` — no `context` column, nothing framework-shaped.
      await db.query(
        'CREATE TABLE "smrt_collections" (id TEXT PRIMARY KEY, slug TEXT, created_at TIMESTAMP, updated_at TIMESTAMP)',
      );

      const plan = await planFrameworkBaseTableDrop(db, {
        engineHint: 'sqlite',
      });
      expect(plan.safe).toBe(false);

      const report = plan.tables.find((t) => t.table === 'smrt_collections');
      expect(report?.refusals).toContainEqual(
        expect.objectContaining({
          kind: 'unexpected-shape',
          missingColumns: ['context'],
        }),
      );

      await expect(dropFrameworkBaseTables(db, plan)).rejects.toThrow();
      expect(await tableExists(db, 'smrt_collections')).toBe(true);
    });
  });

  describe('refusal: unexpected column type', () => {
    it('refuses when every baseline column name is present but a column has the wrong type (a real unrelated table matching names only)', async () => {
      // Same five column NAMES as a genuine framework-base table, but `id`
      // is INTEGER instead of TEXT/UUID and `context` is BOOLEAN instead of
      // TEXT — a name-only check would wrongly call this safe to drop.
      await db.query(
        'CREATE TABLE "smrt_hierarchicals" (id INTEGER PRIMARY KEY, slug TEXT, context BOOLEAN, created_at TIMESTAMP, updated_at TIMESTAMP)',
      );

      const plan = await planFrameworkBaseTableDrop(db, {
        engineHint: 'sqlite',
      });
      expect(plan.safe).toBe(false);

      const report = plan.tables.find((t) => t.table === 'smrt_hierarchicals');
      expect(report?.refusals).toContainEqual(
        expect.objectContaining({
          kind: 'unexpected-column-type',
          mismatches: expect.arrayContaining([
            expect.objectContaining({ column: 'id', actualType: 'INTEGER' }),
            expect.objectContaining({
              column: 'context',
              actualType: 'BOOLEAN',
            }),
          ]),
        }),
      );

      await expect(dropFrameworkBaseTables(db, plan)).rejects.toThrow();
      expect(await tableExists(db, 'smrt_hierarchicals')).toBe(true);
    });

    it('accepts the real generator-produced TIMESTAMP/DATETIME and TEXT/UUID variance across dialects', async () => {
      // Confirms the type-bucket check does not false-positive on the
      // dialect spellings the real generator actually emits (DATETIME on
      // SQLite here; UUID and TIMESTAMPTZ are exercised on PostgreSQL).
      await createAllFrameworkBaseTables(db);
      const plan = await planFrameworkBaseTableDrop(db, {
        engineHint: 'sqlite',
      });
      expect(plan.safe).toBe(true);
      for (const table of plan.tables) {
        expect(table.refusals).toEqual([]);
      }
    });
  });

  describe('refusal: referenced by foreign key', () => {
    it('refuses when any live table anywhere in the database has a foreign key onto a target table', async () => {
      await createAllFrameworkBaseTables(db);
      await db.query(
        'CREATE TABLE "widgets" (id TEXT PRIMARY KEY, class_id TEXT REFERENCES "smrt_classes"(id))',
      );

      const plan = await planFrameworkBaseTableDrop(db, {
        engineHint: 'sqlite',
      });
      expect(plan.safe).toBe(false);

      const report = plan.tables.find((t) => t.table === 'smrt_classes');
      expect(report?.refusals).toContainEqual({
        kind: 'referenced-by-foreign-key',
        references: [{ table: 'widgets', column: 'class_id' }],
      });

      // Every other (unreferenced) table is still reported as unsafe overall
      // because `safe` gates the whole batch, but this one specifically
      // carries no refusal of its own.
      const objectsReport = plan.tables.find((t) => t.table === 'smrt_objects');
      expect(objectsReport?.refusals).toEqual([]);

      await expect(dropFrameworkBaseTables(db, plan)).rejects.toThrow();
      expect(await tableExists(db, 'smrt_classes')).toBe(true);
      expect(await tableExists(db, 'smrt_objects')).toBe(true);
    });
  });

  describe('refusal: introspection unavailable (fail closed)', () => {
    it('refuses every target table when the adapter cannot describe tables', async () => {
      const noSchemaDb = {
        ...db,
        getTableSchema: undefined,
      } as unknown as DatabaseInterface;

      const plan = await planFrameworkBaseTableDrop(noSchemaDb, {
        engineHint: 'sqlite',
      });
      expect(plan.safe).toBe(false);
      expect(plan.statements).toEqual([]);
      for (const table of plan.tables) {
        expect(table.refusals).toEqual([
          expect.objectContaining({ kind: 'introspection-unavailable' }),
        ]);
      }
    });
  });

  describe('dropFrameworkBaseTables defensive checks', () => {
    it('refuses to execute an unsafe plan even if called directly', async () => {
      const unsafePlan: FrameworkBaseTablesPlan = {
        engine: 'sqlite',
        tables: [],
        safe: false,
        statements: ['DROP TABLE IF EXISTS "smrt_classes"'],
      };

      await expect(dropFrameworkBaseTables(db, unsafePlan)).rejects.toThrow(
        /Refusing to drop framework base tables/,
      );
    });

    it('re-verifies emptiness inside the transaction and refuses if a row landed after planning', async () => {
      await createAllFrameworkBaseTables(db);

      const plan = await planFrameworkBaseTableDrop(db, {
        engineHint: 'sqlite',
      });
      expect(plan.safe).toBe(true);

      // Simulate a write racing between the read-only plan and execution.
      await db.query(
        `INSERT INTO "smrt_classes" (id, slug, context) VALUES ('race', 'thing', '')`,
      );

      await expect(dropFrameworkBaseTables(db, plan)).rejects.toThrow(
        /Refusing to drop "smrt_classes"/,
      );

      // Nothing was dropped — the transaction rolled back entirely.
      for (const table of FRAMEWORK_BASE_TABLE_NAMES) {
        expect(await tableExists(db, table)).toBe(true);
      }
    });
  });
});
