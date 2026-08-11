import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { SmrtCollection } from './collection';
import {
  executeCollectionReadPlan,
  type SmrtCollectionReadPlanEntry,
} from './collection-read-plan';
import { SmrtObject } from './object';
import { ObjectRegistry } from './registry';

class ReadPlanProbe extends SmrtObject {
  name: string = '';
}

function mockCollection(
  list: (options?: unknown) => Promise<unknown[]>,
): SmrtCollection<ReadPlanProbe> {
  return { list } as unknown as SmrtCollection<ReadPlanProbe>;
}

function fakeDatabase(url: string): DatabaseInterface {
  return {
    close: vi.fn(),
    query: vi.fn(),
    url,
  } as unknown as DatabaseInterface;
}

describe('executeCollectionReadPlan', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('preserves plan keys and model result typing', async () => {
    vi.spyOn(ObjectRegistry, 'getCollection').mockImplementation(
      async (className: string) =>
        mockCollection(async () => {
          await new Promise((resolve) =>
            setTimeout(resolve, className === 'AlphaProbe' ? 5 : 1),
          );
          return [{ name: className } as unknown as ReadPlanProbe];
        }),
    );

    const alpha: SmrtCollectionReadPlanEntry<ReadPlanProbe> = {
      className: 'AlphaProbe',
    };
    const beta: SmrtCollectionReadPlanEntry<ReadPlanProbe> = {
      className: 'BetaProbe',
    };
    const result = await executeCollectionReadPlan(
      { alpha, beta },
      { maxConcurrency: 2 },
    );

    expectTypeOf(result).toMatchTypeOf<{
      alpha: ReadPlanProbe[];
      beta: ReadPlanProbe[];
    }>();
    expect(Object.keys(result)).toEqual(['alpha', 'beta']);
    expect(result.alpha[0].name).toBe('AlphaProbe');
    expect(result.beta[0].name).toBe('BetaProbe');
  });

  it('returns special plan keys as own data properties', async () => {
    vi.spyOn(ObjectRegistry, 'getCollection').mockResolvedValue(
      mockCollection(async () => []),
    );
    const plan = Object.fromEntries([
      ['__proto__', { className: 'ReadPlanProbe' }],
    ]);

    const result = await executeCollectionReadPlan(plan, {
      maxConcurrency: 1,
    });

    expect(Object.hasOwn(result, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(result, '__proto__')?.value).toEqual(
      [],
    );
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });

  it('never exceeds the configured list-operation concurrency', async () => {
    let active = 0;
    let maximumActive = 0;

    vi.spyOn(ObjectRegistry, 'getCollection').mockImplementation(
      async (className: string) =>
        mockCollection(async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return [{ name: className } as unknown as ReadPlanProbe];
        }),
    );

    const result = await executeCollectionReadPlan(
      Object.fromEntries(
        Array.from({ length: 7 }, (_, index) => [
          `entry${index}`,
          { className: `Probe${index}` },
        ]),
      ),
      { maxConcurrency: 2 },
    );

    expect(maximumActive).toBe(2);
    expect(active).toBe(0);
    expect(Object.keys(result)).toHaveLength(7);
  });

  it('forwards list options and retains projection result typing', async () => {
    const list = vi.fn(async () => [{ id: 'probe-1', name: 'Published' }]);
    vi.spyOn(ObjectRegistry, 'getCollection').mockResolvedValue(
      mockCollection(list),
    );

    const projection: SmrtCollectionReadPlanEntry<
      ReadPlanProbe,
      {
        orderBy: string;
        select: readonly ['id', 'name'];
      }
    > = {
      className: 'ReadPlanProbe',
      options: {
        orderBy: 'name ASC',
        select: ['id', 'name'] as const,
      },
    };

    const result = await executeCollectionReadPlan(
      { published: projection },
      { maxConcurrency: 1 },
    );

    expectTypeOf(result.published).toEqualTypeOf<
      { id: string | null | undefined; name: string }[]
    >();
    expect(list).toHaveBeenCalledWith(projection.options);
    expect(result.published).toEqual([{ id: 'probe-1', name: 'Published' }]);
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('rejects maxConcurrency=%s before resolving a collection', async (maxConcurrency) => {
    const getCollection = vi.spyOn(ObjectRegistry, 'getCollection');

    await expect(
      executeCollectionReadPlan(
        { probe: { className: 'ReadPlanProbe' } },
        { maxConcurrency },
      ),
    ).rejects.toThrow('maxConcurrency must be a positive integer');
    expect(getCollection).not.toHaveBeenCalled();
  });

  it('drains in-flight reads but starts no queued entry after a failure', async () => {
    const failure = new Error('read failed');
    let secondSettled = false;
    const started: string[] = [];

    vi.spyOn(ObjectRegistry, 'getCollection').mockImplementation(
      async (className: string) =>
        mockCollection(async () => {
          started.push(className);
          if (className === 'FirstProbe') {
            await new Promise((resolve) => setTimeout(resolve, 1));
            throw failure;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
          secondSettled = true;
          return [];
        }),
    );

    await expect(
      executeCollectionReadPlan(
        {
          first: { className: 'FirstProbe' },
          second: { className: 'SecondProbe' },
          third: { className: 'ThirdProbe' },
          fourth: { className: 'FourthProbe' },
        },
        { maxConcurrency: 2 },
      ),
    ).rejects.toBe(failure);

    expect(secondSettled).toBe(true);
    expect(started).toEqual(['FirstProbe', 'SecondProbe']);
  });

  it('keeps collection resolution scoped to the supplied database', async () => {
    const databaseA = fakeDatabase('sqlite://tenant-a');
    const databaseB = fakeDatabase('sqlite://tenant-b');
    const getCollection = vi
      .spyOn(ObjectRegistry, 'getCollection')
      .mockImplementation(async (_className: string, options?: unknown) => {
        const db = (options as { db?: DatabaseInterface } | undefined)?.db;
        const marker = db === databaseA ? 'tenant-a' : 'tenant-b';
        return mockCollection(async () => [
          { name: marker } as unknown as ReadPlanProbe,
        ]);
      });

    const records: SmrtCollectionReadPlanEntry<ReadPlanProbe> = {
      className: 'ReadPlanProbe',
    };
    const plan = { records };
    const resultA = await executeCollectionReadPlan(plan, {
      collectionOptions: { db: databaseA },
      maxConcurrency: 1,
    });
    const resultB = await executeCollectionReadPlan(plan, {
      collectionOptions: { db: databaseB },
      maxConcurrency: 1,
    });

    expect(resultA.records[0].name).toBe('tenant-a');
    expect(resultB.records[0].name).toBe('tenant-b');
    expect(getCollection).toHaveBeenNthCalledWith(1, 'ReadPlanProbe', {
      db: databaseA,
    });
    expect(getCollection).toHaveBeenNthCalledWith(2, 'ReadPlanProbe', {
      db: databaseB,
    });
  });

  it('returns an empty keyed result without resolving collections', async () => {
    const getCollection = vi.spyOn(ObjectRegistry, 'getCollection');

    await expect(
      executeCollectionReadPlan({}, { maxConcurrency: 3 }),
    ).resolves.toEqual({});
    expect(getCollection).not.toHaveBeenCalled();
  });
});
