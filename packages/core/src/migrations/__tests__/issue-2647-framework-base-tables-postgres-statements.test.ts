/**
 * Offline (mocked) PostgreSQL coverage for the #2647 framework base-table
 * remediation's SQL generation and statement ordering.
 *
 * The real-server suite (`issue-2647-framework-base-tables-postgres.optional.test.ts`)
 * proves the actual lock/timeout *behavior* against a live PostgreSQL server,
 * but running it locally needs a reachable server. This file proves — with a
 * mocked `DatabaseInterface` and no server — the two things a code review
 * found missing from that gap:
 *
 * 1. Every PostgreSQL statement this module issues (`SELECT COUNT(*)`,
 *    `LOCK TABLE`, `DROP INDEX`, `DROP TABLE`) is schema-qualified with
 *    `"public".`, matching the `public`-scoped discovery in
 *    `getExistingTableNames()` / `getTableSchema()`. An unqualified
 *    statement would resolve through the session's `search_path` instead,
 *    which could point at a different, unrelated same-named object.
 * 2. `dropFrameworkBaseTables()` locks every target `IN ACCESS EXCLUSIVE
 *    MODE` *before* re-checking its row count, so the check-then-drop
 *    sequence cannot race a concurrent writer the way a plain
 *    `SELECT COUNT(*)` (which only takes an ACCESS SHARE lock) would.
 * 3. `dropFrameworkBaseTables()` never executes a `DROP INDEX` statement by
 *    name — only `DROP TABLE`, relying on its cascade to remove the
 *    table's own indexes. A later review found that re-issuing the
 *    planned `DROP INDEX` statements verbatim would not be identity-safe:
 *    an index name is unique per schema (PostgreSQL) / globally (SQLite),
 *    so if a concurrent session recreated that exact name on an unrelated
 *    table between planning and execution, a stale name-based `DROP INDEX`
 *    would delete the wrong object with no error.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { describe, expect, it } from 'vitest';
import {
  dropFrameworkBaseTables,
  planFrameworkBaseTableDrop,
} from '../framework-base-tables.js';

interface MockTableFixture {
  columns: Record<string, { type: string }>;
  indexes: Array<{ name: string; columns: string[] }>;
  foreignKeys: Array<{
    column: string;
    referencesTable: string;
    referencesColumn: string;
  }>;
}

function mockPostgresDb(options: {
  existingTables: string[];
  tables: Record<string, MockTableFixture>;
  rowCounts?: Record<string, number>;
}) {
  const queries: string[] = [];
  let db: DatabaseInterface;
  db = {
    url: 'postgres://localhost/test',
    query: async (sql: string, ...params: unknown[]) => {
      queries.push(sql);
      if (sql.includes('information_schema.tables')) {
        return {
          rows: options.existingTables.map((table_name) => ({ table_name })),
        };
      }
      if (sql.includes('information_schema.columns')) {
        const table = String(params[0] ?? '');
        const fixture = options.tables[table];
        if (!fixture) return { rows: [] };
        return {
          rows: Object.entries(fixture.columns).map(([column_name, def]) => ({
            column_name,
            data_type: def.type,
          })),
        };
      }
      if (sql.startsWith('SELECT COUNT(*)')) {
        const match = sql.match(/FROM\s+"public"\."([A-Za-z_][A-Za-z0-9_]*)"/);
        const table = match?.[1] ?? '';
        return { rows: [{ row_count: options.rowCounts?.[table] ?? 0 }] };
      }
      return { rows: [] };
    },
    getTableSchema: async (table: string) => {
      const fixture = options.tables[table];
      if (!fixture) return null;
      return {
        tableName: table,
        columns: fixture.columns,
        indexes: fixture.indexes,
        foreignKeys: fixture.foreignKeys,
      };
    },
    transaction: async <T>(
      callback: (transactionDb: DatabaseInterface) => Promise<T>,
    ) => callback(db),
  } as unknown as DatabaseInterface;
  return { db, queries };
}

function baselineTable(indexPrefix: string): MockTableFixture {
  return {
    columns: {
      id: { type: 'uuid' },
      slug: { type: 'text' },
      context: { type: 'text' },
      created_at: { type: 'timestamptz' },
      updated_at: { type: 'timestamptz' },
    },
    indexes: [
      { name: `${indexPrefix}_slug_context_idx`, columns: ['slug', 'context'] },
      { name: `${indexPrefix}_created_at_idx`, columns: ['created_at'] },
    ],
    foreignKeys: [],
  };
}

describe('framework base-table remediation (#2647) — PostgreSQL statement generation (mocked, no server needed)', () => {
  it('qualifies every planned DROP statement with the public schema', async () => {
    const { db } = mockPostgresDb({
      existingTables: ['smrt_classes'],
      tables: { smrt_classes: baselineTable('smrt_classes') },
    });

    const plan = await planFrameworkBaseTableDrop(db, {
      engineHint: 'postgres',
    });

    expect(plan.safe).toBe(true);
    expect(plan.statements).toEqual([
      'DROP INDEX IF EXISTS "public"."smrt_classes_slug_context_idx"',
      'DROP INDEX IF EXISTS "public"."smrt_classes_created_at_idx"',
      'DROP TABLE IF EXISTS "public"."smrt_classes"',
    ]);
  });

  it('locks every target IN ACCESS EXCLUSIVE MODE, schema-qualified, before re-checking emptiness or dropping anything', async () => {
    const { db, queries } = mockPostgresDb({
      existingTables: ['smrt_classes', 'smrt_objects'],
      tables: {
        smrt_classes: baselineTable('smrt_classes'),
        smrt_objects: baselineTable('smrt_objects'),
      },
    });

    const plan = await planFrameworkBaseTableDrop(db, {
      engineHint: 'postgres',
    });
    expect(plan.safe).toBe(true);

    queries.length = 0; // Only inspect statements issued by the drop itself.
    const result = await dropFrameworkBaseTables(db, plan, {
      lockTimeout: 5_000,
      statementTimeout: 5_000,
    });

    expect(result.droppedTables.sort()).toEqual([
      'smrt_classes',
      'smrt_objects',
    ]);

    const lockIndex = (table: string) =>
      queries.indexOf(
        `LOCK TABLE "public"."${table}" IN ACCESS EXCLUSIVE MODE`,
      );
    const countIndex = (table: string) =>
      queries.findIndex(
        (sql) =>
          sql.startsWith('SELECT COUNT(*)') &&
          sql.includes(`"public"."${table}"`),
      );
    const dropIndex = (table: string) =>
      queries.indexOf(`DROP TABLE IF EXISTS "public"."${table}"`);

    for (const table of ['smrt_classes', 'smrt_objects']) {
      expect(lockIndex(table)).toBeGreaterThanOrEqual(0);
      expect(countIndex(table)).toBeGreaterThan(lockIndex(table));
      expect(dropIndex(table)).toBeGreaterThan(countIndex(table));
    }

    // The lock timeout is set (bounding both the LOCK TABLE and DROP
    // acquisitions) before any lock is requested.
    const timeoutIndex = queries.findIndex((sql) =>
      sql.includes('SET LOCAL lock_timeout'),
    );
    expect(timeoutIndex).toBeGreaterThanOrEqual(0);
    expect(
      Math.min(lockIndex('smrt_classes'), lockIndex('smrt_objects')),
    ).toBeGreaterThan(timeoutIndex);

    // No `DROP INDEX` statement is ever executed — only `DROP TABLE`,
    // which cascades to the table's own indexes identity-safely. A stale
    // `DROP INDEX` by name could otherwise hit an unrelated index created
    // under that name between planning and execution (index names are
    // unique per schema on PostgreSQL, globally on SQLite).
    expect(queries.some((sql) => sql.startsWith('DROP INDEX'))).toBe(false);
    expect(result.droppedIndexes.sort()).toEqual([
      'smrt_classes_created_at_idx',
      'smrt_classes_slug_context_idx',
      'smrt_objects_created_at_idx',
      'smrt_objects_slug_context_idx',
    ]);
  });

  it('refuses via the qualified re-check when a row appears between planning and the transaction', async () => {
    const { db } = mockPostgresDb({
      existingTables: ['smrt_classes'],
      tables: { smrt_classes: baselineTable('smrt_classes') },
      rowCounts: { smrt_classes: 0 },
    });

    const plan = await planFrameworkBaseTableDrop(db, {
      engineHint: 'postgres',
    });
    expect(plan.safe).toBe(true);

    // Simulate a row landing after the plan but before execution — the
    // re-check inside the transaction (issued against the qualified name)
    // must still catch it. The shape re-check still needs to see the
    // genuine baseline columns so this test isolates the row-count path.
    (
      db as unknown as {
        query: (sql: string, ...params: unknown[]) => Promise<unknown>;
      }
    ).query = async (sql: string, ...params: unknown[]) => {
      if (sql.includes('information_schema.columns')) {
        const table = String(params[0] ?? '');
        const fixture = baselineTable(table);
        return {
          rows: Object.entries(fixture.columns).map(([column_name, def]) => ({
            column_name,
            data_type: def.type,
          })),
        };
      }
      if (sql.startsWith('SELECT COUNT(*)')) {
        return { rows: [{ row_count: 1 }] };
      }
      return { rows: [] };
    };

    await expect(dropFrameworkBaseTables(db, plan)).rejects.toThrow(
      /Refusing to drop "smrt_classes": it now has 1 row/,
    );
  });

  /**
   * Closes the gap an independent review found in the row-count-only
   * re-check: a table can be swapped for an unrelated same-named,
   * currently-empty table between the read-only plan and the locked
   * transaction (most concretely, on PostgreSQL, a concurrent session
   * dropping and recreating the name before this session's `LOCK TABLE`
   * request is granted). The row count alone would not catch that — this
   * proves the shape/type re-check, run from raw `information_schema.columns`
   * inside the transaction (since `getTableSchema()` is unavailable there;
   * see `dropFrameworkBaseTables`'s doc comment), does.
   */
  it('refuses via the re-check when the table shape itself changed between planning and the transaction, even though it is still empty', async () => {
    const { db } = mockPostgresDb({
      existingTables: ['smrt_classes'],
      tables: { smrt_classes: baselineTable('smrt_classes') },
      rowCounts: { smrt_classes: 0 },
    });

    const plan = await planFrameworkBaseTableDrop(db, {
      engineHint: 'postgres',
    });
    expect(plan.safe).toBe(true);

    // Simulate the object at this name having been replaced by an
    // unrelated, still-empty table with a missing baseline column, after
    // planning but before the transaction's re-check.
    (
      db as unknown as {
        query: (sql: string, ...params: unknown[]) => Promise<unknown>;
      }
    ).query = async (sql: string) => {
      if (sql.includes('information_schema.columns')) {
        return {
          rows: [
            { column_name: 'id', data_type: 'uuid' },
            { column_name: 'slug', data_type: 'text' },
            // `context` is missing entirely — not the same object anymore.
            { column_name: 'created_at', data_type: 'timestamptz' },
            { column_name: 'updated_at', data_type: 'timestamptz' },
          ],
        };
      }
      if (sql.startsWith('SELECT COUNT(*)')) {
        return { rows: [{ row_count: 0 }] };
      }
      return { rows: [] };
    };

    await expect(dropFrameworkBaseTables(db, plan)).rejects.toThrow(
      /Refusing to drop "smrt_classes": a fresh check inside the transaction found an unexpected column shape/,
    );
  });
});
