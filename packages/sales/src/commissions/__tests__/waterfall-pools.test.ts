/**
 * Pool recipients for v2 waterfalls (#3834): a step's amount is split across
 * the members of a host-resolved pool, weighted by an injected
 * MetricProvider (or equally), with exact integer minor units, a
 * deterministic residual rule, closure to gross, and frozen replay inputs.
 *
 * Fixture: a farm co-operative that keeps 10% of each wholesale sale in its
 * treasury and shares the rest among its growers by kilograms delivered.
 */

import { describe, expect, it, vi } from 'vitest';
import { CommissionPlan } from '../models/CommissionPlan.js';
import {
  calculateWaterfall,
  calculateWaterfallWithPools,
  prepareWaterfallPools,
  validateWaterfallPlan,
  WaterfallRecipientResolverRegistry,
} from '../services/WaterfallCalculationService.js';
import type {
  MetricProvider,
  MetricValue,
  WaterfallEvent,
  WaterfallPlan,
  WaterfallPoolSpec,
  WaterfallResolvedRecipient,
} from '../types.js';

const growers: WaterfallResolvedRecipient[] = [
  { kind: 'grower', id: 'apple-hill' },
  { kind: 'grower', id: 'birch-farm' },
  { kind: 'grower', id: 'cedar-acres' },
  { kind: 'grower', id: 'dune-orchard' },
];

function registry(): WaterfallRecipientResolverRegistry {
  const r = new WaterfallRecipientResolverRegistry();
  r.register('treasury', () => ({ kind: 'treasury', id: 'valley-coop' }));
  r.register('grower_pool', (descriptor) => ({
    kind: 'grower_pool',
    id: descriptor.id ?? 'all',
  }));
  return r;
}

function farmPlan(pool: WaterfallPoolSpec = { metric: 'kg_delivered' }) {
  return {
    planKey: 'valley-coop-wholesale',
    version: 1,
    currency: 'USD',
    steps: [
      {
        key: 'treasury',
        base: 'gross',
        amount: { kind: 'percent', rate: 0.1 },
        recipient: { kind: 'treasury' },
      },
      {
        key: 'growers',
        base: 'previous_remainder',
        amount: { kind: 'percent', rate: 1 },
        recipient: { kind: 'grower_pool', id: '2026-season' },
        pool,
      },
    ],
    remainderSink: { kind: 'treasury' },
  } satisfies WaterfallPlan;
}

const sale = (grossAmountCents: number): WaterfallEvent => ({
  grossAmountCents,
  currency: 'USD',
  facts: { product: 'apples' },
});

function metrics(values: Record<string, number>): MetricProvider & {
  getMetricValues: ReturnType<typeof vi.fn>;
} {
  return {
    getMetricValues: vi.fn(
      async (): Promise<MetricValue[]> =>
        Object.entries(values).map(([id, value]) => ({
          kind: 'grower',
          id,
          value,
        })),
    ),
  };
}

const members = (list = growers) => vi.fn(async () => list);

const kgDelivered = {
  'apple-hill': 500,
  'birch-farm': 300,
  'cedar-acres': 200,
  'dune-orchard': 0,
};

describe('waterfall pool recipients (#3834)', () => {
  it('splits a step by metric weight with exact minor units and closure', async () => {
    const result = await calculateWaterfallWithPools(farmPlan(), sale(10_000), {
      resolver: registry(),
      poolMembers: members(),
      metricProvider: metrics(kgDelivered),
    });
    const growersStep = result.trace.steps[1];
    expect(growersStep.amountCents).toBe(9000);
    expect(growersStep.recipient).toEqual({
      kind: 'grower_pool',
      id: '2026-season',
    });
    expect(growersStep.pool?.distribution).toBe('weighted');
    expect(growersStep.pool?.totalWeight).toBe(1000);
    expect(
      growersStep.pool?.members.map((m) => [m.recipient.id, m.amountCents]),
    ).toEqual([
      ['apple-hill', 4500],
      ['birch-farm', 2700],
      ['cedar-acres', 1800],
      ['dune-orchard', 0],
    ]);
    expect(growersStep.pool?.members[0].shareFraction).toBe(0.5);
    expect(growersStep.payableCents).toBe(9000);
    expect(result.trace.totalRecipientAllocatedCents).toBe(10_000);
    expect(result.trace.totalSinkCents).toBe(0);
    expect(result.trace.closureCents).toBe(0);
  });

  it('keeps a zero-metric member in the trace with nothing allocated', async () => {
    const result = await calculateWaterfallWithPools(farmPlan(), sale(10_000), {
      resolver: registry(),
      poolMembers: members(),
      metricProvider: metrics({ 'apple-hill': 1, 'birch-farm': 1 }),
    });
    const pool = result.trace.steps[1].pool;
    expect(pool?.members.map((m) => [m.recipient.id, m.weight])).toEqual([
      ['apple-hill', 1],
      ['birch-farm', 1],
      ['cedar-acres', 0],
      ['dune-orchard', 0],
    ]);
    expect(pool?.members.map((m) => m.amountCents)).toEqual([4500, 4500, 0, 0]);
  });

  it('sends indivisible units to the remainder sink by default', async () => {
    const result = await calculateWaterfallWithPools(farmPlan(), sale(10_001), {
      resolver: registry(),
      poolMembers: members(),
      metricProvider: metrics(kgDelivered),
    });
    const step = result.trace.steps[1];
    // 10% of 10_001 rounds to 1000; 9001 split 5:3:2 floors to 4500/2700/1800.
    expect(step.amountCents).toBe(9001);
    expect(step.pool?.members.map((m) => m.amountCents)).toEqual([
      4500, 2700, 1800, 0,
    ]);
    expect(step.pool?.residualRule).toBe('remainder_sink');
    expect(step.pool?.residualToSinkCents).toBe(1);
    expect(step.redirectedToSinkCents).toBe(1);
    expect(step.payableCents).toBe(9000);
    expect(result.trace.remainderSinkCents).toBe(1);
    expect(
      result.trace.totalRecipientAllocatedCents + result.trace.totalSinkCents,
    ).toBe(10_001);
  });

  it('hands out residual units by largest remainder with documented tie-breaking', async () => {
    const weighted = await calculateWaterfallWithPools(
      farmPlan({ metric: 'kg_delivered', residual: 'largest_remainder' }),
      sale(10_001),
      {
        resolver: registry(),
        poolMembers: members(),
        metricProvider: metrics(kgDelivered),
      },
    );
    // Fractional remainders .5/.3/.2 — apple-hill takes the single unit.
    expect(
      weighted.trace.steps[1].pool?.members.map((m) => m.amountCents),
    ).toEqual([4501, 2700, 1800, 0]);
    expect(weighted.trace.totalSinkCents).toBe(0);

    // Equal weights tie on remainder and weight: kind, then id, decides —
    // independent of the order the host listed the members in.
    const equalPlan: WaterfallPlan = {
      ...farmPlan({ residual: 'largest_remainder' }),
      steps: [
        {
          key: 'growers',
          base: 'gross',
          amount: { kind: 'fixed', amountCents: 100 },
          recipient: { kind: 'grower_pool', id: 'equal' },
          pool: { residual: 'largest_remainder' },
        },
      ],
    };
    for (const order of [
      growers.slice(0, 3),
      [...growers.slice(0, 3)].reverse(),
    ]) {
      const equal = await calculateWaterfallWithPools(equalPlan, sale(100), {
        resolver: registry(),
        poolMembers: members(order),
      });
      expect(
        equal.trace.steps[0].pool?.members.map((m) => [
          m.recipient.id,
          m.amountCents,
        ]),
      ).toEqual([
        ['apple-hill', 34],
        ['birch-farm', 33],
        ['cedar-acres', 33],
      ]);
    }
  });

  it('uses equal weights without calling a metric provider when no metric is named', async () => {
    const provider = metrics(kgDelivered);
    const result = await calculateWaterfallWithPools(
      farmPlan({}),
      sale(10_000),
      {
        resolver: registry(),
        poolMembers: members(),
        metricProvider: provider,
      },
    );
    expect(provider.getMetricValues).not.toHaveBeenCalled();
    const pool = result.trace.steps[1].pool;
    expect(pool?.distribution).toBe('equal');
    expect(pool?.metric).toBeNull();
    expect(pool?.members.map((m) => m.amountCents)).toEqual([
      2250, 2250, 2250, 2250,
    ]);
  });

  it('routes an all-zero pool to the sink by default, or splits it equally on request', async () => {
    const zero = metrics({});
    const sunk = await calculateWaterfallWithPools(farmPlan(), sale(10_000), {
      resolver: registry(),
      poolMembers: members(),
      metricProvider: zero,
    });
    expect(sunk.trace.steps[1].pool?.distribution).toBe('remainder_sink');
    expect(sunk.trace.steps[1].redirectedToSinkCents).toBe(9000);
    expect(sunk.trace.steps[1].payableCents).toBe(0);
    expect(sunk.trace.remainderSinkCents).toBe(9000);

    const equal = await calculateWaterfallWithPools(
      farmPlan({ metric: 'kg_delivered', zeroWeight: 'equal' }),
      sale(10_000),
      { resolver: registry(), poolMembers: members(), metricProvider: zero },
    );
    expect(equal.trace.steps[1].pool?.distribution).toBe('equal');
    expect(
      equal.trace.steps[1].pool?.members.map((m) => m.amountCents),
    ).toEqual([2250, 2250, 2250, 2250]);
  });

  it('routes an empty pool and an unresolved pool descriptor to the sink', async () => {
    const empty = await calculateWaterfallWithPools(farmPlan(), sale(10_000), {
      resolver: registry(),
      poolMembers: members([]),
      metricProvider: metrics({}),
    });
    expect(empty.trace.steps[1].pool?.distribution).toBe('remainder_sink');
    expect(empty.trace.remainderSinkCents).toBe(9000);

    const noPools = new WaterfallRecipientResolverRegistry();
    noPools.register('treasury', () => ({ kind: 'treasury', id: 'valley' }));
    const poolMembers = members();
    const unresolved = await calculateWaterfallWithPools(
      farmPlan(),
      sale(10_000),
      { resolver: noPools, poolMembers, metricProvider: metrics({}) },
    );
    expect(poolMembers).not.toHaveBeenCalled();
    expect(unresolved.trace.steps[1].recipient).toBeNull();
    expect(unresolved.trace.steps[1].redirectedToSinkCents).toBe(9000);
    expect(unresolved.trace.frozenInputs.recipientByStep.growers).toBeNull();
    expect(unresolved.trace.closureCents).toBe(0);
  });

  it('skips a pool step whose conditions do not match without reading metrics', async () => {
    const plan = farmPlan();
    plan.steps[1] = {
      ...plan.steps[1],
      conditions: { product: ['pears'] },
    } as (typeof plan.steps)[1];
    const provider = metrics(kgDelivered);
    const poolMembers = members();
    const result = await calculateWaterfallWithPools(plan, sale(10_000), {
      resolver: registry(),
      poolMembers,
      metricProvider: provider,
    });
    expect(poolMembers).not.toHaveBeenCalled();
    expect(provider.getMetricValues).not.toHaveBeenCalled();
    expect(result.trace.steps[1].skipped).toBe('condition_not_met');
    expect(result.trace.remainderSinkCents).toBe(9000);
  });

  it('freezes members, weights, and the metric period for provider-free replay', async () => {
    const provider = metrics(kgDelivered);
    const first = await calculateWaterfallWithPools(farmPlan(), sale(10_001), {
      resolver: registry(),
      poolMembers: members(),
      metricProvider: provider,
      metricPeriod: {
        start: new Date('2026-09-01T00:00:00Z'),
        end: '2026-10-01T00:00:00Z',
      },
    });
    expect(provider.getMetricValues).toHaveBeenCalledWith(
      expect.objectContaining({
        metric: 'kg_delivered',
        pool: { kind: 'grower_pool', id: '2026-season' },
        period: {
          start: '2026-09-01T00:00:00.000Z',
          end: '2026-10-01T00:00:00.000Z',
        },
      }),
    );
    const frozen = first.trace.frozenInputs.poolsByStep?.growers;
    expect(frozen?.period?.start).toBe('2026-09-01T00:00:00.000Z');
    expect(frozen?.members.map((m) => m.weight)).toEqual([500, 300, 200, 0]);

    const throwing = {
      getMetricValues: () => {
        throw new Error('metrics must not be re-read on replay');
      },
    };
    const replay = await calculateWaterfallWithPools(farmPlan(), sale(1), {
      resolver: new WaterfallRecipientResolverRegistry(),
      poolMembers: () => {
        throw new Error('members must not be re-read on replay');
      },
      metricProvider: throwing,
      frozenInputs: first.trace.frozenInputs,
    });
    expect(replay.trace).toEqual(first.trace);
    // The synchronous engine replays the same evidence.
    expect(
      calculateWaterfall(farmPlan(), sale(1), {
        frozenInputs: first.trace.frozenInputs,
      }).trace,
    ).toEqual(first.trace);

    // Returned evidence owns its pool snapshot.
    const expected = structuredClone(replay.trace);
    const input = first.trace.frozenInputs.poolsByStep?.growers;
    if (!input) throw new Error('expected frozen pool');
    input.members[0].weight = 9999;
    input.members[0].recipient.id = 'tampered';
    expect(replay.trace).toEqual(expected);
  });

  it('refuses frozen pool evidence that disagrees with its frozen recipient', async () => {
    const first = await calculateWaterfallWithPools(farmPlan(), sale(10_000), {
      resolver: registry(),
      poolMembers: members(),
      metricProvider: metrics(kgDelivered),
    });
    const frozen = structuredClone(first.trace.frozenInputs);
    if (!frozen.poolsByStep) throw new Error('expected pools');
    frozen.poolsByStep.growers.pool = { kind: 'grower_pool', id: 'other' };
    expect(() =>
      calculateWaterfall(farmPlan(), sale(10_000), { frozenInputs: frozen }),
    ).toThrow(/does not match its frozen recipient/);
    delete frozen.poolsByStep.growers;
    expect(() =>
      calculateWaterfall(farmPlan(), sale(10_000), { frozenInputs: frozen }),
    ).toThrow(/lack the pool snapshot/);
  });

  it('requires prepared pool inputs on the synchronous engine', () => {
    expect(() =>
      calculateWaterfall(farmPlan(), sale(10_000), { resolver: registry() }),
    ).toThrow(/requires prepared pool inputs/);
  });

  it('accepts prepared pools and canonicalizes member order', async () => {
    const pools = await prepareWaterfallPools(farmPlan(), sale(10_000), {
      resolver: registry(),
      poolMembers: members([...growers].reverse()),
      metricProvider: metrics(kgDelivered),
    });
    expect(pools.growers?.members.map((m) => m.recipient.id)).toEqual([
      'apple-hill',
      'birch-farm',
      'cedar-acres',
      'dune-orchard',
    ]);
    const result = calculateWaterfall(farmPlan(), sale(10_000), {
      resolver: registry(),
      pools,
    });
    expect(result.trace.steps[1].pool?.members[0].amountCents).toBe(4500);
  });

  it('rejects malformed membership and metric evidence', async () => {
    const run = (
      list: WaterfallResolvedRecipient[],
      values: MetricValue[] | unknown,
    ) =>
      calculateWaterfallWithPools(farmPlan(), sale(10_000), {
        resolver: registry(),
        poolMembers: async () => list,
        metricProvider: {
          getMetricValues: async () => values as MetricValue[],
        },
      });
    await expect(run([growers[0], { ...growers[0] }], [])).rejects.toThrow(
      /more than once/,
    );
    await expect(run([{ kind: 'grower', id: '' }], [])).rejects.toThrow(
      /non-empty kind and id/,
    );
    await expect(
      run(growers, [{ kind: 'grower', id: 'stranger', value: 1 }]),
    ).rejects.toThrow(/non-member/);
    await expect(
      run(growers, [
        { kind: 'grower', id: 'apple-hill', value: 1 },
        { kind: 'grower', id: 'apple-hill', value: 2 },
      ]),
    ).rejects.toThrow(/repeats a member/);
    for (const value of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(
        run(growers, [{ kind: 'grower', id: 'apple-hill', value }]),
      ).rejects.toThrow(/non-negative safe integers/);
    }
    await expect(run(growers, 'not-an-array')).rejects.toThrow(
      /must return an array/,
    );
    await expect(
      calculateWaterfallWithPools(farmPlan(), sale(10_000), {
        resolver: registry(),
        poolMembers: members(),
      }),
    ).rejects.toThrow(/requires a metricProvider/);
    await expect(
      calculateWaterfallWithPools(farmPlan(), sale(10_000), {
        resolver: registry(),
      }),
    ).rejects.toThrow(/requires a poolMembers resolver/);
    await expect(
      calculateWaterfallWithPools(farmPlan(), sale(10_000), {
        resolver: registry(),
        poolMembers: members(),
        metricProvider: metrics(kgDelivered),
        metricPeriod: { start: '2026-10-01', end: '2026-09-01' },
      }),
    ).rejects.toThrow(/end must be later than start/);
  });

  it('rejects hand-built pool snapshots with impossible weights', () => {
    const base = {
      pool: { kind: 'grower_pool', id: '2026-season' },
      period: null,
      members: [{ recipient: growers[0], weight: 2 }],
    };
    expect(() =>
      calculateWaterfall(farmPlan(), sale(10_000), {
        resolver: registry(),
        pools: { growers: { ...base, metric: null } },
      }),
    ).toThrow(/every weight must be 1/);
    expect(() =>
      calculateWaterfall(farmPlan(), sale(10_000), {
        resolver: registry(),
        pools: {
          growers: {
            ...base,
            metric: 'kg_delivered',
            members: [
              { recipient: growers[0], weight: Number.MAX_SAFE_INTEGER },
              { recipient: growers[1], weight: 1 },
            ],
          },
        },
      }),
    ).toThrow(/total weight exceeds/);
  });

  it('validates pool options at plan validation and activation', () => {
    const bad = (pool: unknown) => {
      const plan = farmPlan();
      (plan.steps[1] as { pool: unknown }).pool = pool;
      return plan;
    };
    expect(() => validateWaterfallPlan(bad([]))).toThrow(/must be an object/);
    expect(() => validateWaterfallPlan(bad({ weights: 'x' }))).toThrow(
      /unknown option 'weights'/,
    );
    expect(() => validateWaterfallPlan(bad({ metric: '' }))).toThrow(
      /metric must be a non-empty string/,
    );
    expect(() => validateWaterfallPlan(bad({ residual: 'random' }))).toThrow(
      /residual is invalid/,
    );
    expect(() => validateWaterfallPlan(bad({ zeroWeight: 'drop' }))).toThrow(
      /zeroWeight is invalid/,
    );
    expect(() =>
      validateWaterfallPlan({
        ...farmPlan(),
        applicationFeeOffsetRecipient: {
          kind: 'grower_pool',
          id: '2026-season',
        },
      }),
    ).toThrow(/cannot be the application fee offset recipient/);

    const persisted = new CommissionPlan({
      planKey: 'valley-coop-wholesale',
      version: 1,
      currency: 'USD',
    });
    persisted.setSteps(farmPlan().steps);
    persisted.setRemainderSink({ kind: 'treasury' });
    persisted.activate();
    expect(persisted.getWaterfallPlan()?.steps[1].pool).toEqual({
      metric: 'kg_delivered',
    });

    const invalid = new CommissionPlan({
      planKey: 'valley-coop-wholesale',
      version: 2,
      currency: 'USD',
    });
    invalid.setSteps(bad({ residual: 'random' }).steps);
    invalid.setRemainderSink({ kind: 'treasury' });
    expect(() => invalid.activate()).toThrow(/residual is invalid/);
  });

  it('closes for any amount and weights (seeded property check)', async () => {
    let seed = 3834;
    const next = (limit: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % limit;
    };
    for (let run = 0; run < 200; run++) {
      const count = 1 + next(7);
      const list = Array.from({ length: count }, (_, i) => ({
        kind: 'grower',
        id: `g${i}`,
      }));
      const values = Object.fromEntries(
        list.map((m) => [m.id, next(4) === 0 ? 0 : next(1_000_000)]),
      );
      const gross = next(10_000_000);
      for (const residual of ['remainder_sink', 'largest_remainder'] as const) {
        const result = await calculateWaterfallWithPools(
          farmPlan({ metric: 'kg_delivered', residual }),
          sale(gross),
          {
            resolver: registry(),
            poolMembers: members(list),
            metricProvider: metrics(values),
          },
        );
        const trace = result.trace;
        expect(trace.totalRecipientAllocatedCents + trace.totalSinkCents).toBe(
          gross,
        );
        const step = trace.steps[1];
        const memberSum =
          step.pool?.members.reduce((sum, m) => sum + m.amountCents, 0) ?? 0;
        expect(memberSum + step.redirectedToSinkCents).toBe(step.amountCents);
        expect(step.pool?.residualToSinkCents ?? 0).toBeLessThan(count);
        for (const m of step.pool?.members ?? []) {
          expect(Number.isSafeInteger(m.amountCents)).toBe(true);
          expect(m.amountCents).toBeGreaterThanOrEqual(0);
          if (m.weight === 0 && step.pool?.distribution === 'weighted')
            expect(m.amountCents).toBe(0);
        }
        if (
          residual === 'largest_remainder' &&
          step.pool?.distribution !== 'remainder_sink'
        )
          expect(step.redirectedToSinkCents).toBe(0);
      }
    }
  });

  it('leaves pool-free plans and their traces unchanged', async () => {
    const plain: WaterfallPlan = {
      ...farmPlan(),
      steps: [farmPlan().steps[0]],
    };
    const sync = calculateWaterfall(plain, sale(10_000), {
      resolver: registry(),
    });
    expect('poolsByStep' in sync.trace.frozenInputs).toBe(false);
    expect(sync.trace.steps.every((step) => !('pool' in step))).toBe(true);
    const viaPools = await calculateWaterfallWithPools(plain, sale(10_000), {
      resolver: registry(),
    });
    expect(viaPools.trace).toEqual(sync.trace);
  });
});
