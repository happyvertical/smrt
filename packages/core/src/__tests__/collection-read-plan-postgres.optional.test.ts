/**
 * PostgreSQL pool behavior for bounded collection read plans (issue #2304).
 *
 * Runs only in the dedicated disposable PostgreSQL shard. The test lets an
 * initialized read pool expire to zero clients, then proves that a 26-read
 * plan keeps the cold pool at or below the requested concurrency while using
 * the normal collection query path.
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection.js';
import { executeCollectionReadPlan } from '../collection-read-plan.js';
import { field } from '../decorators/index.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const TABLE = 'issue_2304_read_plan_probes';

@smrt({ tableName: 'issue_2304_read_plan_probes' })
class Issue2304ReadPlanProbe extends SmrtObject {
  @field()
  position: number = 0;
}

class Issue2304ReadPlanProbeCollection extends SmrtCollection<Issue2304ReadPlanProbe> {
  static readonly _itemClass = Issue2304ReadPlanProbe;
}

interface PublicPoolCounters {
  idleCount: number;
  totalCount: number;
  waitingCount: number;
}

function poolCounters(db: DatabaseInterface): PublicPoolCounters {
  return db.client as PublicPoolCounters;
}

async function waitForPoolExpiry(
  pool: PublicPoolCounters,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (pool.totalCount > 0) {
    if (Date.now() >= deadline) {
      throw new Error(
        `PostgreSQL pool did not expire within ${timeoutMs}ms (total=${pool.totalCount}, idle=${pool.idleCount})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe.skipIf(!pgUrl)('bounded read plan PostgreSQL pool (#2304)', () => {
  let adminDb: DatabaseInterface;
  let readDb: DatabaseInterface;

  beforeAll(async () => {
    adminDb = (await getDatabase({
      type: 'postgres',
      url: pgUrl,
      dbid: `smrt-test-read-plan-admin-${randomUUID()}`,
      max: 1,
    } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;

    await adminDb.query(`DROP TABLE IF EXISTS "${TABLE}"`);
    const registration = ObjectRegistry.getClassByConstructor(
      Issue2304ReadPlanProbe,
    );
    const className =
      registration?.qualifiedName ||
      registration?.name ||
      Issue2304ReadPlanProbe.name;
    const ddl = ObjectRegistry.getSchemaDDL(className, 'postgres');
    if (!ddl) throw new Error(`Missing schema DDL for ${className}`);
    await adminDb.query(ddl);

    for (const position of [1, 2, 3]) {
      const id = randomUUID();
      await adminDb.insert(TABLE, {
        id,
        slug: id,
        context: '',
        created_at: new Date(),
        updated_at: new Date(),
        position,
      });
    }

    readDb = (await getDatabase({
      type: 'postgres',
      url: pgUrl,
      dbid: `smrt-test-read-plan-reader-${randomUUID()}`,
      max: 20,
    } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;

    // Initialize and cache the collection before measuring only the read plan.
    await ObjectRegistry.getCollection<Issue2304ReadPlanProbe>(
      'Issue2304ReadPlanProbe',
      { db: readDb },
    );
    await waitForPoolExpiry(poolCounters(readDb));
  }, 30_000);

  afterAll(async () => {
    try {
      await readDb?.close?.();
      await adminDb?.query(`DROP TABLE IF EXISTS "${TABLE}"`);
    } finally {
      await adminDb?.close?.();
      ObjectRegistry.clear();
    }
  });

  it('opens at most maxConcurrency clients for 26 cold reads', async () => {
    const pool = poolCounters(readDb);
    expect(pool.totalCount).toBe(0);

    const originalQuery = readDb.query.bind(readDb);
    let queryCount = 0;
    readDb.query = ((...args: unknown[]) => {
      queryCount += 1;
      return (originalQuery as (...queryArgs: unknown[]) => unknown)(...args);
    }) as DatabaseInterface['query'];

    const plan = Object.fromEntries(
      Array.from({ length: 26 }, (_, index) => [
        `read${index}`,
        {
          className: 'Issue2304ReadPlanProbe',
          options: { orderBy: 'position ASC' },
        },
      ]),
    );

    const result = await executeCollectionReadPlan(plan, {
      collectionOptions: { db: readDb },
      maxConcurrency: 2,
    });

    expect(queryCount).toBe(26);
    expect(pool.totalCount).toBeGreaterThan(0);
    expect(pool.totalCount).toBeLessThanOrEqual(2);
    expect(pool.idleCount).toBe(pool.totalCount);
    expect(pool.waitingCount).toBe(0);

    const resultShapes = Object.values(result).map((rows) =>
      JSON.stringify(rows),
    );
    expect(new Set(resultShapes).size).toBe(1);
    const orderedRows = JSON.parse(resultShapes[0]) as Array<{
      position: number;
    }>;
    expect(orderedRows.map((row) => row.position)).toEqual([1, 2, 3]);
  });
});
