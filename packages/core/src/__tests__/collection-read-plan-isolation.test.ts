/**
 * Real registry/database isolation coverage for bounded read plans (#2304).
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeCollectionReadPlan } from '../collection-read-plan';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { getTestDatabase } from '../testing/database';

@smrt()
class ReadPlanIsolationProbe extends SmrtObject {
  marker: string = '';
}

describe('bounded read plan database isolation (#2304)', () => {
  let databaseA: DatabaseInterface;
  let databaseB: DatabaseInterface;

  beforeAll(async () => {
    [databaseA, databaseB] = await Promise.all([
      getTestDatabase({
        type: 'sqlite',
        url: ':memory:',
        classes: ['ReadPlanIsolationProbe'],
      }),
      getTestDatabase({
        type: 'sqlite',
        url: ':memory:',
        classes: ['ReadPlanIsolationProbe'],
      }),
    ]);

    const [recordsA, recordsB] = await Promise.all([
      ObjectRegistry.getCollection<ReadPlanIsolationProbe>(
        'ReadPlanIsolationProbe',
        { db: databaseA },
      ),
      ObjectRegistry.getCollection<ReadPlanIsolationProbe>(
        'ReadPlanIsolationProbe',
        { db: databaseB },
      ),
    ]);
    await Promise.all([
      recordsA.create({ marker: 'tenant-a' }),
      recordsB.create({ marker: 'tenant-b' }),
    ]);
  });

  afterAll(async () => {
    await Promise.all([databaseA.close?.(), databaseB.close?.()]);
  });

  it('does not reuse registry or read-cache state across databases', async () => {
    const plan = {
      records: {
        className: 'ReadPlanIsolationProbe',
        options: { cache: { ttl: 60_000 } },
      },
    };

    const [resultA, resultB] = await Promise.all([
      executeCollectionReadPlan(plan, {
        collectionOptions: { db: databaseA },
        maxConcurrency: 1,
      }),
      executeCollectionReadPlan(plan, {
        collectionOptions: { db: databaseB },
        maxConcurrency: 1,
      }),
    ]);

    expect(resultA.records.map((record) => record.marker)).toEqual([
      'tenant-a',
    ]);
    expect(resultB.records.map((record) => record.marker)).toEqual([
      'tenant-b',
    ]);
  });
});
