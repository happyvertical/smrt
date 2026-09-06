/**
 * DuckDB coverage for the #2647 framework base-table remediation.
 *
 * SQLite carries the full refusal matrix (see
 * `issue-2647-framework-base-tables.test.ts`); this file exercises the same
 * `getTableSchema()`-driven plan/drop logic against a real in-memory DuckDB
 * database to confirm the engine-agnostic introspection path (columns,
 * indexes, foreign keys) and DDL statements are also correct there.
 */

import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  dropFrameworkBaseTables,
  FRAMEWORK_BASE_TABLE_NAMES,
  planFrameworkBaseTableDrop,
} from '../framework-base-tables.js';

function createFrameworkBaseTableDDL(table: string): string[] {
  return [
    `CREATE TABLE "${table}" (
      "id" TEXT PRIMARY KEY,
      "slug" TEXT NOT NULL,
      "context" TEXT NOT NULL DEFAULT '',
      "created_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
      "updated_at" TIMESTAMP NOT NULL DEFAULT current_timestamp
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

describe('framework base-table remediation (#2647) — DuckDB', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getDatabase({ type: 'duckdb', url: ':memory:' });
  });

  afterEach(async () => {
    await db.close?.();
  });

  it('drops all five tables and their companion indexes, leaving a real application table untouched', async () => {
    await createAllFrameworkBaseTables(db);
    await db.query(
      'CREATE TABLE "articles" (id TEXT PRIMARY KEY, title TEXT NOT NULL)',
    );
    await db.query(
      "INSERT INTO \"articles\" (id, title) VALUES ('a1', 'Hello')",
    );

    const plan = await planFrameworkBaseTableDrop(db, { engineHint: 'duckdb' });
    expect(plan.safe).toBe(true);
    expect(plan.tables.filter((t) => t.exists)).toHaveLength(5);

    const result = await dropFrameworkBaseTables(db, plan);
    expect(result.droppedTables.sort()).toEqual(
      [...FRAMEWORK_BASE_TABLE_NAMES].sort(),
    );

    for (const table of FRAMEWORK_BASE_TABLE_NAMES) {
      expect(await tableExists(db, table)).toBe(false);
    }
    expect(await tableExists(db, 'articles')).toBe(true);
    const rows = await db.query('SELECT * FROM "articles"');
    expect(rows.rows).toEqual([{ id: 'a1', title: 'Hello' }]);
  });

  it('refuses when a target table has rows', async () => {
    await createAllFrameworkBaseTables(db);
    await db.query(
      `INSERT INTO "smrt_classes" (id, slug, context) VALUES ('c1', 'thing', '')`,
    );

    const plan = await planFrameworkBaseTableDrop(db, { engineHint: 'duckdb' });
    expect(plan.safe).toBe(false);
    const report = plan.tables.find((t) => t.table === 'smrt_classes');
    expect(report?.refusals).toContainEqual({ kind: 'not-empty', rowCount: 1 });

    await expect(dropFrameworkBaseTables(db, plan)).rejects.toThrow();
    expect(await tableExists(db, 'smrt_classes')).toBe(true);
  });

  /**
   * `@happyvertical/sql`'s DuckDB adapter never populates `foreignKeys` from
   * `getTableSchema()` (verified directly against a live DuckDB v1.4.3: even
   * a table-level `FOREIGN KEY (...) REFERENCES ...` constraint comes back as
   * `foreignKeys: []`), so the pre-flight plan cannot see this reference and
   * reports `smrt_classes` as safe. DuckDB itself still refuses the DROP at
   * the database level ("Catalog Error: ... main key table of ...") inside
   * the bounded transaction, so nothing is actually dropped — the safety
   * outcome is identical to SQLite/PostgreSQL, just surfaced at execution
   * instead of at planning, with DuckDB's own error text rather than the
   * curated `referenced-by-foreign-key` refusal.
   */
  it('cannot see a live foreign key at plan time (adapter gap), but DuckDB itself still refuses the drop and nothing is lost', async () => {
    await createAllFrameworkBaseTables(db);
    await db.query(
      'CREATE TABLE "widgets" (id TEXT PRIMARY KEY, class_id TEXT REFERENCES "smrt_classes"(id))',
    );

    const plan = await planFrameworkBaseTableDrop(db, { engineHint: 'duckdb' });
    const report = plan.tables.find((t) => t.table === 'smrt_classes');
    expect(report?.refusals).toEqual([]);
    expect(plan.safe).toBe(true);

    await expect(dropFrameworkBaseTables(db, plan)).rejects.toThrow(
      /Catalog Error/,
    );
    expect(await tableExists(db, 'smrt_classes')).toBe(true);
    // The transaction rolled back completely — tables ordered before
    // smrt_classes in FRAMEWORK_BASE_TABLE_NAMES were not left dropped.
    expect(await tableExists(db, 'smrt_objects')).toBe(true);
  });
});
