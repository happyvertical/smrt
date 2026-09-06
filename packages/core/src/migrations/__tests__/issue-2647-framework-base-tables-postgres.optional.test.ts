/**
 * PostgreSQL integration coverage for the #2647 framework base-table
 * remediation.
 *
 * This suite runs only in the disposable PostgreSQL lane started by
 * `scripts/run-with-ci-postgres.mjs` (`SMRT_TEST_POSTGRES_URL`), which hands
 * every CI run its own fresh, disposable database — so, unlike a shared
 * database, creating tables under the real literal names
 * (`smrt_objects`, `smrt_classes`, ...) here is safe and is exactly what lets
 * this suite exercise `FRAMEWORK_BASE_TABLE_NAMES` for real rather than a
 * stand-in. It verifies the real bounded transaction
 * (`SET LOCAL lock_timeout` / `SET LOCAL statement_timeout`, #2362), native
 * PostgreSQL foreign-key and index introspection, and the happy-path drop
 * that SQLite/DuckDB cannot exercise identically.
 */

import { randomUUID } from 'node:crypto';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  dropFrameworkBaseTables,
  FRAMEWORK_BASE_TABLE_NAMES,
  planFrameworkBaseTableDrop,
} from '../framework-base-tables.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const postgresDescribe = pgUrl ? describe.sequential : describe.skip;

/**
 * Flatten an error and everything it wraps into one searchable string.
 *
 * `@happyvertical/sql` re-throws driver errors as `DatabaseError: Failed to
 * execute raw query` and keeps the PostgreSQL message on
 * `context.originalError` (#2366), so asserting on a caught error's own
 * `.message` alone would not see the SQLSTATE / "lock timeout" text at all.
 * Mirrors `describeError()` in
 * `issue-2362-postgres-migrate-timeouts.optional.test.ts`.
 */
function describeError(error: unknown, depth = 0): string {
  if (!error || depth > 5) return '';

  const parts = [String(error)];

  if (typeof error === 'object') {
    const context = (error as { context?: { originalError?: unknown } })
      .context;
    if (context?.originalError) {
      parts.push(describeError(context.originalError, depth + 1));
    }
    const cause = (error as { cause?: unknown }).cause;
    if (cause) parts.push(describeError(cause, depth + 1));
    const code = (error as { code?: unknown }).code;
    if (code) parts.push(String(code));
  }

  return parts.join(' | ');
}

/**
 * DDL matching the real generator's actual output per table — verified
 * directly against a genuine pre-#2644 `db:migrate` run (a real installed
 * multi-package consumer). `smrt_hierarchicals` and
 * `smrt_polymorphic_associations` carry their own real extra columns
 * (`SmrtHierarchical`/`SmrtPolymorphicAssociation`'s own fields) and no
 * `created_at` list-ordering index, both empirically confirmed.
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
      "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "slug" TEXT NOT NULL,
      "context" TEXT NOT NULL DEFAULT '',
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
      "updated_at" TIMESTAMPTZ NOT NULL DEFAULT current_timestamp${extraColumns[table] ?? ''}
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
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
    table,
  );
  return (result.rows as unknown[]).length > 0;
}

postgresDescribe(
  'framework base-table remediation (#2647) on real PostgreSQL',
  () => {
    let db: DatabaseInterface;
    let blockerDb: DatabaseInterface;

    beforeAll(async () => {
      db = await getDatabase({
        type: 'postgres',
        url: pgUrl,
        dbid: `smrt-test-2647-${randomUUID()}`,
      } as Parameters<typeof getDatabase>[0]);
      blockerDb = await getDatabase({
        type: 'postgres',
        url: pgUrl,
        dbid: `smrt-test-2647-blocker-${randomUUID()}`,
      } as Parameters<typeof getDatabase>[0]);
      await db.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    });

    afterEach(async () => {
      for (const table of [
        ...FRAMEWORK_BASE_TABLE_NAMES,
        'widgets',
        'articles',
      ]) {
        await db.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
      }
    });

    afterAll(async () => {
      await db.close?.();
      await blockerDb.close?.();
    });

    it('drops all five tables and companion indexes in one bounded transaction, leaving a real application table untouched', async () => {
      await createAllFrameworkBaseTables(db);
      await db.query(
        'CREATE TABLE "articles" (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), title TEXT NOT NULL)',
      );
      await db.query('INSERT INTO "articles" (title) VALUES (\'Hello\')');

      const plan = await planFrameworkBaseTableDrop(db, {
        engineHint: 'postgres',
      });
      expect(plan.engine).toBe('postgres');
      expect(plan.safe).toBe(true);
      expect(plan.tables.filter((t) => t.exists)).toHaveLength(5);
      // (2 indexes + 1 table) × 3 plain-baseline tables, (1 index + 1
      // table) × 2 tables without a created_at index (smrt_hierarchicals,
      // smrt_polymorphic_associations).
      expect(plan.statements).toHaveLength(3 * 3 + 2 * 2);

      const result = await dropFrameworkBaseTables(db, plan, {
        lockTimeout: 5_000,
        statementTimeout: 5_000,
      });
      expect(result.droppedTables.sort()).toEqual(
        [...FRAMEWORK_BASE_TABLE_NAMES].sort(),
      );
      expect(result.droppedIndexes).toHaveLength(3 * 2 + 2 * 1);

      for (const table of FRAMEWORK_BASE_TABLE_NAMES) {
        expect(await tableExists(db, table)).toBe(false);
      }
      expect(await tableExists(db, 'articles')).toBe(true);
      const rows = await db.query('SELECT title FROM "articles"');
      expect(rows.rows).toEqual([{ title: 'Hello' }]);
    });

    it('refuses when a target table has rows', async () => {
      await createAllFrameworkBaseTables(db);
      await db.query(
        `INSERT INTO "smrt_classes" (slug, context) VALUES ('thing', '')`,
      );

      const plan = await planFrameworkBaseTableDrop(db, {
        engineHint: 'postgres',
      });
      expect(plan.safe).toBe(false);
      const report = plan.tables.find((t) => t.table === 'smrt_classes');
      expect(report?.refusals).toContainEqual({
        kind: 'not-empty',
        rowCount: 1,
      });

      await expect(dropFrameworkBaseTables(db, plan)).rejects.toThrow();
      expect(await tableExists(db, 'smrt_classes')).toBe(true);
    });

    it('refuses when another live table has a foreign key onto a target table', async () => {
      await createAllFrameworkBaseTables(db);
      await db.query(
        'CREATE TABLE "widgets" (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), class_id UUID REFERENCES "smrt_classes"(id))',
      );

      const plan = await planFrameworkBaseTableDrop(db, {
        engineHint: 'postgres',
      });
      expect(plan.safe).toBe(false);
      const report = plan.tables.find((t) => t.table === 'smrt_classes');
      expect(report?.refusals).toContainEqual({
        kind: 'referenced-by-foreign-key',
        references: [{ table: 'widgets', column: 'class_id' }],
      });

      await expect(dropFrameworkBaseTables(db, plan)).rejects.toThrow();
      expect(await tableExists(db, 'smrt_classes')).toBe(true);
    });

    it('refuses when every baseline column name is present but has the wrong type', async () => {
      // Uses smrt_classes (one of the three plain-baseline tables) so this
      // isolates the type check from smrt_hierarchicals' own extra-column
      // shape requirement (covered separately below).
      await createAllFrameworkBaseTables(db);
      await db.query('DROP TABLE "smrt_classes"');
      await db.query(
        'CREATE TABLE "smrt_classes" (id INTEGER PRIMARY KEY, slug TEXT, context BOOLEAN, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ)',
      );

      const plan = await planFrameworkBaseTableDrop(db, {
        engineHint: 'postgres',
      });
      expect(plan.safe).toBe(false);
      const report = plan.tables.find((t) => t.table === 'smrt_classes');
      expect(report?.refusals).toContainEqual(
        expect.objectContaining({
          kind: 'unexpected-column-type',
          mismatches: expect.arrayContaining([
            expect.objectContaining({ column: 'id' }),
            expect.objectContaining({ column: 'context' }),
          ]),
        }),
      );

      await expect(dropFrameworkBaseTables(db, plan)).rejects.toThrow();
      expect(await tableExists(db, 'smrt_classes')).toBe(true);
    });

    it('refuses when smrt_hierarchicals is missing its own real parent_id field', async () => {
      await createAllFrameworkBaseTables(db);
      await db.query('DROP TABLE "smrt_hierarchicals"');
      await db.query(
        'CREATE TABLE "smrt_hierarchicals" (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), slug TEXT, context TEXT, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ)',
      );

      const plan = await planFrameworkBaseTableDrop(db, {
        engineHint: 'postgres',
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

    it('aborts on lock_timeout instead of waiting indefinitely for a blocking writer (#2362)', async () => {
      await createAllFrameworkBaseTables(db);

      const plan = await planFrameworkBaseTableDrop(db, {
        engineHint: 'postgres',
      });
      expect(plan.safe).toBe(true);

      // Hold ACCESS EXCLUSIVE on one target table from a *separate*
      // connection. Without a working `SET LOCAL lock_timeout` the drop
      // below would wait for as long as this session lives, while already
      // holding every lock its own batch had already taken — the app-wide
      // write stall #2362 exists to prevent.
      const held = await blockerDb.acquireSession?.();
      if (!held) throw new Error('PostgreSQL adapter must expose a session');

      await held.query('BEGIN');
      await held.query('LOCK TABLE "smrt_classes" IN ACCESS EXCLUSIVE MODE');

      try {
        const startedAt = Date.now();
        let caught: unknown;
        try {
          await dropFrameworkBaseTables(db, plan, {
            lockTimeout: 750,
            statementTimeout: 30_000,
          });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeDefined();
        expect(describeError(caught)).toMatch(
          /lock timeout|canceling statement|55P03/i,
        );
        const elapsed = Date.now() - startedAt;

        // Bounded, and bounded by *this* lock_timeout — not "eventually".
        expect(elapsed).toBeGreaterThanOrEqual(700);
        expect(elapsed).toBeLessThan(20_000);
      } finally {
        await held.query('ROLLBACK');
        await held.release?.();
      }

      // The whole batch rolled back: every table (not just the locked
      // one) is still present.
      for (const table of FRAMEWORK_BASE_TABLE_NAMES) {
        expect(await tableExists(db, table)).toBe(true);
      }
    }, 120_000);
  },
);
