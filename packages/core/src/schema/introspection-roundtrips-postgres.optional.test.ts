/**
 * Introspection round trips for `smrt db:status` on PostgreSQL.
 *
 * `db:status` runs `SchemaComparer.compare()` and then the foreign-key orphan
 * report. Each `getTableSchema()` is five catalog round trips, and both used
 * to run strictly one table at a time: the orphan report re-read the child
 * and parent schema for every uuid relationship (no cache), and the comparer
 * issued one `pg_indexes` query per table. On a ~280-table schema that was
 * ~5,100 sequential round trips, so wall time scaled with network latency
 * (~30 s next to the database, 11 min over a ~120 ms RTT link).
 *
 * These tests pin the reduced shape against a real database (spying on, not
 * mocking, the adapter): each table is introspected at most once per
 * command, the orphan report can reuse the comparer's reads, partial-index
 * predicates come from one batched catalog query with the same verdicts as
 * the per-table path, and introspection/probes run with bounded concurrency.
 */

import { randomUUID } from 'node:crypto';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SchemaComparer } from '../migrations/differ.js';
import {
  POSTGRES_INTROSPECTION_CONCURRENCY,
  POSTGRES_PROBE_CONCURRENCY,
} from './bounded-concurrency.js';
import { collectForeignKeyOrphanCounts } from './foreign-key-orphan-report.js';
import type { SchemaDefinition } from './types.js';

const pgUrl = process.env.DATABASE_URL ?? process.env.SMRT_TEST_POSTGRES_URL;
const suffix = `${process.pid}_${Math.random().toString(36).slice(2, 7)}`;
const parent = `rt_parents_${suffix}`;
const CHILD_COUNT = 12;
const children = Array.from(
  { length: CHILD_COUNT },
  (_, i) => `rt_child_${i}_${suffix}`,
);
const partialIndex = `rt_partial_${suffix}`;

type Db = Awaited<ReturnType<typeof getDatabase>>;

interface Spy {
  db: Db;
  schemaReads: Map<string, number>;
  pgIndexQueries: number;
  orphanProbes: number;
  maxSchemaInFlight: number;
  maxProbesInFlight: number;
}

/** Wrap the real adapter to count (not fake) introspection and probes. */
function spyOn(db: Db): Spy {
  const spy: Spy = {
    db,
    schemaReads: new Map(),
    pgIndexQueries: 0,
    orphanProbes: 0,
    maxSchemaInFlight: 0,
    maxProbesInFlight: 0,
  };
  let schemaInFlight = 0;
  let probesInFlight = 0;
  spy.db = {
    ...db,
    getTableSchema: async (table: string) => {
      spy.schemaReads.set(table, (spy.schemaReads.get(table) ?? 0) + 1);
      schemaInFlight++;
      spy.maxSchemaInFlight = Math.max(spy.maxSchemaInFlight, schemaInFlight);
      try {
        return await db.getTableSchema?.(table);
      } finally {
        schemaInFlight--;
      }
    },
    query: async (...args: Parameters<Db['query']>) => {
      const sql = String(args[0]);
      if (/FROM pg_indexes/i.test(sql)) spy.pgIndexQueries++;
      const isProbe = /orphan_count/.test(sql);
      if (isProbe) {
        spy.orphanProbes++;
        probesInFlight++;
        spy.maxProbesInFlight = Math.max(spy.maxProbesInFlight, probesInFlight);
      }
      try {
        return await db.query(...args);
      } finally {
        if (isProbe) probesInFlight--;
      }
    },
  } as Db;
  return spy;
}

function manifest(partialWhere: string): Record<string, SchemaDefinition> {
  const schemas: Record<string, SchemaDefinition> = {
    [parent]: {
      tableName: parent,
      columns: { id: { type: 'UUID', primaryKey: true } },
      indexes: [],
      triggers: [],
      foreignKeys: [],
      dependencies: [],
      version: '1.0.0',
    },
  };
  children.forEach((child, i) => {
    schemas[child] = {
      tableName: child,
      columns: {
        id: { type: 'UUID', primaryKey: true },
        parent_id: {
          type: 'UUID',
          foreignKey: { table: parent, column: 'id' },
        },
      },
      indexes:
        i === 0
          ? [
              {
                name: partialIndex,
                columns: ['parent_id'],
                unique: false,
                where: partialWhere,
              },
            ]
          : [],
      triggers: [],
      foreignKeys: [],
      dependencies: [],
      version: '1.0.0',
    };
  });
  return schemas;
}

describe.skipIf(!pgUrl)(
  'db:status introspection round trips against PostgreSQL',
  () => {
    let db: Db;

    beforeAll(async () => {
      db = await getDatabase({
        type: 'postgres',
        url: pgUrl,
        dbid: `smrt-test-roundtrips-${randomUUID()}`,
        max: 10,
      } as Parameters<typeof getDatabase>[0]);
      await db.query(`CREATE TABLE "${parent}" (id UUID PRIMARY KEY)`);
      for (const child of children) {
        await db.query(
          `CREATE TABLE "${child}" (id UUID PRIMARY KEY, parent_id UUID)`,
        );
      }
      await db.query(
        `CREATE INDEX "${partialIndex}" ON "${children[0]}" (parent_id) WHERE parent_id IS NOT NULL`,
      );
      await db.query(
        `INSERT INTO "${children[1]}" (id, parent_id) VALUES ($1, $2)`,
        [randomUUID(), randomUUID()],
      );
    });

    afterAll(async () => {
      if (!db) return;
      for (const child of children) {
        await db.query(`DROP TABLE IF EXISTS "${child}"`);
      }
      await db.query(`DROP TABLE IF EXISTS "${parent}"`);
      await db.close?.();
    });

    it('compare() introspects each table once, concurrently, with one batched pg_indexes query', async () => {
      const spy = spyOn(db);
      await new SchemaComparer(spy.db, { engineHint: 'postgres' }).compare(
        manifest('parent_id IS NOT NULL'),
      );

      for (const table of [parent, ...children]) {
        expect(spy.schemaReads.get(table)).toBe(1);
      }
      expect(spy.pgIndexQueries).toBe(1);
      expect(spy.maxSchemaInFlight).toBe(POSTGRES_INTROSPECTION_CONCURRENCY);
    });

    it('batched partial-index predicates give the same verdicts as the per-table path', async () => {
      for (const where of [
        'parent_id IS NOT NULL',
        // A drifted predicate must still be reported as drift.
        'parent_id IS NULL',
      ]) {
        const schemas = manifest(where);
        const diff = await new SchemaComparer(db, {
          engineHint: 'postgres',
        }).compare(schemas);
        const batched = diff.changes.filter(
          (change) => change.table === children[0],
        );
        // Standalone compareTable() never has the batch cache, so it takes
        // the original per-table pg_indexes query.
        const perTable = await new SchemaComparer(db, {
          engineHint: 'postgres',
        }).compareTable(
          children[0] as string,
          schemas[children[0] as string] as SchemaDefinition,
          schemas,
        );
        expect(batched).toEqual(perTable);
        if (where === 'parent_id IS NULL') {
          expect(batched.some((change) => change.name === partialIndex)).toBe(
            true,
          );
        }
      }
    });

    it('orphan report reads each table at most once and bounds probe concurrency', async () => {
      const spy = spyOn(db);
      const report = await collectForeignKeyOrphanCounts(
        spy.db,
        manifest('parent_id IS NOT NULL'),
        { engineHint: 'postgres' },
      );

      // Before: every uuid relationship re-read child and parent, so the
      // shared parent was read once per child.
      for (const table of [parent, ...children]) {
        expect(spy.schemaReads.get(table)).toBe(1);
      }
      expect(spy.orphanProbes).toBe(CHILD_COUNT);
      expect(spy.maxProbesInFlight).toBe(POSTGRES_PROBE_CONCURRENCY);
      expect(report.skipped).toEqual([]);
      expect(report.counts).toHaveLength(CHILD_COUNT);
      expect(report.counts[0]).toMatchObject({
        childTable: children[1],
        orphanCount: 1,
      });
    });

    it('orphan report reuses the comparer snapshot without re-introspecting', async () => {
      const comparer = new SchemaComparer(db, { engineHint: 'postgres' });
      const schemas = manifest('parent_id IS NOT NULL');
      await comparer.compare(schemas);

      const spy = spyOn(db);
      const seeded = await collectForeignKeyOrphanCounts(spy.db, schemas, {
        engineHint: 'postgres',
        liveSchemas: comparer.getLiveSchemaSnapshot(),
      });
      expect(spy.schemaReads.size).toBe(0);

      const fresh = await collectForeignKeyOrphanCounts(db, schemas, {
        engineHint: 'postgres',
      });
      expect(seeded).toEqual(fresh);
    });
  },
);
