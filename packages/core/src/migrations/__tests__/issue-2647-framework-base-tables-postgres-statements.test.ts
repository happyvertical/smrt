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
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes('information_schema.tables')) {
        return {
          rows: options.existingTables.map((table_name) => ({ table_name })),
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
    // must still catch it.
    (db as unknown as { query: (sql: string) => Promise<unknown> }).query =
      async (sql: string) => {
        if (sql.startsWith('SELECT COUNT(*)')) {
          return { rows: [{ row_count: 1 }] };
        }
        return { rows: [] };
      };

    await expect(dropFrameworkBaseTables(db, plan)).rejects.toThrow(
      /Refusing to drop "smrt_classes": it now has 1 row/,
    );
  });
});
