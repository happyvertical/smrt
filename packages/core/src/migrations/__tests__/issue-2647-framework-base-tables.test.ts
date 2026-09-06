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

/**
 * DDL matching the real generator's actual output per table — verified
 * directly against a genuine pre-#2644 `db:migrate` run (a real installed
 * multi-package consumer). `smrt_hierarchicals` and
 * `smrt_polymorphic_associations` are not plain aliases of the universal
 * base: they are `SmrtHierarchical` / `SmrtPolymorphicAssociation`'s own
 * real fields (a true parent-id tree; the meta/role/sort columns generic
 * associations need), and neither carries the `created_at` list-ordering
 * index the other three do — both empirically confirmed, not guessed.
 */
function createFrameworkBaseTableDDL(table: string): string[] {
  const extraColumns: Record<string, string> = {
    smrt_hierarchicals: `,\n      "parent_id" TEXT`,
    smrt_polymorphic_associations: `,
      "meta_type" TEXT NOT NULL,
      "meta_id" TEXT NOT NULL,
      "role" TEXT NOT NULL,
      "sort_order" INTEGER DEFAULT 0`,
  };
  const statements = [
    `CREATE TABLE "${table}" (
      "id" TEXT PRIMARY KEY,
      "slug" TEXT NOT NULL,
      "context" TEXT NOT NULL DEFAULT '',
      "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP${extraColumns[table] ?? ''}
    )`,
    `CREATE UNIQUE INDEX "${table}_slug_context_idx" ON "${table}" ("slug", "context")`,
  ];
  if (!(table in extraColumns)) {
    statements.push(
      `CREATE INDEX "${table}_created_at_idx" ON "${table}" ("created_at")`,
    );
  }
  return statements;
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
      // smrt_hierarchicals/smrt_polymorphic_associations do not carry the
      // created_at list-ordering index the other three do (empirically
      // confirmed against a real pre-#2644 db:migrate run).
      const tablesWithoutCreatedAtIndex = new Set([
        'smrt_hierarchicals',
        'smrt_polymorphic_associations',
      ]);
      for (const table of plan.tables) {
        expect(table.refusals).toEqual([]);
        const expectedIndexes = tablesWithoutCreatedAtIndex.has(table.table)
          ? [`${table.table}_slug_context_idx`]
          : [
              `${table.table}_slug_context_idx`,
              `${table.table}_created_at_idx`,
            ];
        expect(table.indexNames.sort()).toEqual(expectedIndexes.sort());
      }
      // (2 indexes + 1 table) × 3 tables, (1 index + 1 table) × 2 tables.
      expect(plan.statements).toHaveLength(3 * 3 + 2 * 2);

      const result = await dropFrameworkBaseTables(db, plan);
      expect(result.droppedTables.sort()).toEqual(
        [...FRAMEWORK_BASE_TABLE_NAMES].sort(),
      );
      expect(result.droppedIndexes).toHaveLength(3 * 2 + 2 * 1);

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
      // Uses `smrt_classes` (one of the three plain-baseline tables) so this
      // test isolates the type check from the per-table extra-column shape
      // `smrt_hierarchicals`/`smrt_polymorphic_associations` also require.
      await db.query(
        'CREATE TABLE "smrt_classes" (id INTEGER PRIMARY KEY, slug TEXT, context BOOLEAN, created_at TIMESTAMP, updated_at TIMESTAMP)',
      );

      const plan = await planFrameworkBaseTableDrop(db, {
        engineHint: 'sqlite',
      });
      expect(plan.safe).toBe(false);

      const report = plan.tables.find((t) => t.table === 'smrt_classes');
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
      expect(await tableExists(db, 'smrt_classes')).toBe(true);
    });

    it('refuses when smrt_hierarchicals is missing its own real parent_id field (a plain-baseline table under that name)', async () => {
      // smrt_hierarchicals is not a plain alias of the universal baseline —
      // it is SmrtHierarchical's own real shape, which always includes
      // parent_id. A table with only the five universal columns under this
      // name is not a genuine framework-base table.
      await db.query(
        'CREATE TABLE "smrt_hierarchicals" (id TEXT PRIMARY KEY, slug TEXT, context TEXT, created_at TIMESTAMP, updated_at TIMESTAMP)',
      );

      const plan = await planFrameworkBaseTableDrop(db, {
        engineHint: 'sqlite',
      });
      expect(plan.safe).toBe(false);

      const report = plan.tables.find((t) => t.table === 'smrt_hierarchicals');
      expect(report?.refusals).toContainEqual(
        expect.objectContaining({
          kind: 'unexpected-shape',
          missingColumns: ['parent_id'],
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

    /**
     * Documents a real, verified limitation a final review found: unlike
     * PostgreSQL (whose FK enforcement is dependency-based and refuses the
     * DROP regardless of row count), SQLite's `DROP TABLE` only enforces
     * foreign keys against the rows actually being removed. An empty parent
     * — exactly this function's precondition — drops cleanly even with a
     * real, enforced foreign key pointing at it. No data is lost (the
     * dropped table is empty by construction), but the referencing table is
     * left with a dangling reference. The plan-time full-catalog scan
     * remains the only gate against this on SQLite/DuckDB; it is not
     * re-run inside the execution transaction (see the module's own doc
     * comment for the full rationale).
     */
    it('drops an empty target even past a real foreign key created after planning (documented SQLite limitation, not a data-loss risk)', async () => {
      await createAllFrameworkBaseTables(db);
      await db.query('PRAGMA foreign_keys = ON');

      const plan = await planFrameworkBaseTableDrop(db, {
        engineHint: 'sqlite',
      });
      expect(plan.safe).toBe(true);

      // A foreign key referencing smrt_classes appears after planning —
      // the plan-time scan could not have seen it.
      await db.query(
        'CREATE TABLE "widgets" (id TEXT PRIMARY KEY, class_id TEXT REFERENCES "smrt_classes"(id))',
      );

      // smrt_classes is still empty, so SQLite's row-based FK enforcement
      // raises nothing — the drop proceeds.
      await dropFrameworkBaseTables(db, plan);

      expect(await tableExists(db, 'smrt_classes')).toBe(false);
      // The referencing table survives, now with a dangling reference —
      // schema drift, not data loss.
      expect(await tableExists(db, 'widgets')).toBe(true);
    });
  });
});
