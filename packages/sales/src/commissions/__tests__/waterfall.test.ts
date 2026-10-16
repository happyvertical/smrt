import { describe, expect, it } from 'vitest';
import { CommissionPlan } from '../models/CommissionPlan.js';
import {
  calculateWaterfall,
  WaterfallRecipientResolverRegistry,
} from '../services/WaterfallCalculationService.js';
import type { WaterfallEvent, WaterfallPlan } from '../types.js';

const event: WaterfallEvent = {
  grossAmountCents: 10_000,
  currency: 'USD',
  facts: {
    product: 'solar-install',
    zone: 'north',
    source: 'direct',
    member: 'worker',
  },
  applicationFeeSettledCents: 500,
};

function resolver(): WaterfallRecipientResolverRegistry {
  const registry = new WaterfallRecipientResolverRegistry();
  registry.register('worker', (descriptor) => ({
    kind: 'worker',
    id: descriptor.id ?? 'unassigned',
  }));
  registry.register('treasury', () => ({
    kind: 'treasury',
    id: 'worker-coop',
  }));
  registry.register('platform', () => ({
    kind: 'platform',
    id: 'service-provider',
  }));
  return registry;
}

const plan: WaterfallPlan = {
  planKey: 'worker-coop-project-revenue',
  version: 2,
  currency: 'USD',
  steps: [
    {
      key: 'crew',
      base: 'gross',
      amount: { kind: 'percent', rate: 0.6 },
      recipient: { kind: 'worker', id: 'crew-a' },
    },
    {
      key: 'platform',
      base: 'previous_remainder',
      amount: { kind: 'percent', rate: 0.25 },
      recipient: { kind: 'platform', id: 'fee' },
    },
    {
      key: 'conditional',
      base: 'previous_remainder',
      amount: { kind: 'percent', rate: 0.1 },
      conditions: { zone: ['south'] },
      recipient: { kind: 'worker', id: 'south-pool' },
    },
    {
      key: 'missing-recipient',
      base: 'previous_remainder',
      amount: { kind: 'fixed', amountCents: 250 },
      recipient: { kind: 'unknown', id: 'future-party' },
    },
  ],
  remainderSink: { kind: 'treasury' },
  applicationFeeOffsetRecipient: { kind: 'platform', id: 'fee' },
};

describe('calculateWaterfall', () => {
  it('activates a fee-free persisted waterfall plan with the empty descriptor default', () => {
    const persisted = new CommissionPlan({
      planKey: 'fee-free',
      version: 2,
      currency: 'USD',
    });
    persisted.setSteps([
      {
        key: 'crew',
        base: 'gross',
        amount: { kind: 'percent', rate: 0.5 },
        recipient: { kind: 'worker', id: 'crew-a' },
      },
    ]);
    persisted.setRemainderSink({ kind: 'treasury' });
    persisted.activate();
    expect(persisted.isActive()).toBe(true);
  });

  it('closes a non-journalism $100 worker-co-op project fixture and offsets an already-settled fee once', () => {
    const result = calculateWaterfall(plan, event, { resolver: resolver() });
    expect(result.trace.closureCents).toBe(0);
    expect(
      result.trace.totalRecipientAllocatedCents + result.trace.totalSinkCents,
    ).toBe(10_000);
    expect(result.trace.steps.map((step) => step.amountCents)).toEqual([
      6000, 1000, 0, 250,
    ]);
    expect(result.trace.steps[1].applicationFeeOffsetCents).toBe(500);
    expect(result.trace.steps[1].payableCents).toBe(500);
    expect(result.trace.steps[3].redirectedToSinkCents).toBe(250);
    expect(result.trace.remainderSinkCents).toBe(3000);
  });

  it('replays from frozen resolver and event inputs even after host resolution changes', () => {
    const first = calculateWaterfall(plan, event, { resolver: resolver() });
    const changed = new WaterfallRecipientResolverRegistry();
    changed.register('worker', () => ({
      kind: 'worker',
      id: 'different-worker',
    }));
    changed.register('treasury', () => ({
      kind: 'treasury',
      id: 'different-treasury',
    }));
    changed.register('platform', () => ({
      kind: 'platform',
      id: 'different-platform',
    }));
    const replay = calculateWaterfall(
      plan,
      {
        ...event,
        grossAmountCents: 1,
        facts: { zone: 'south' },
        customBases: { recalculated: 1 },
      },
      {
        resolver: changed,
        frozenInputs: first.trace.frozenInputs,
      },
    );
    expect(replay.trace).toEqual(first.trace);
  });

  it('copies recipient evidence before a host-owned resolver object can mutate', () => {
    const hostRecipient = {
      kind: 'worker',
      id: 'crew-a',
      metadata: { routing: { account: 'original' } },
    };
    const mutableResolver = new WaterfallRecipientResolverRegistry();
    mutableResolver.register('worker', () => hostRecipient);
    mutableResolver.register('treasury', () => ({
      kind: 'treasury',
      id: 'coop',
    }));
    mutableResolver.register('platform', () => ({
      kind: 'platform',
      id: 'platform',
    }));
    const first = calculateWaterfall(plan, event, {
      resolver: mutableResolver,
    });
    hostRecipient.id = 'changed';
    hostRecipient.metadata.routing.account = 'changed';
    expect(first.trace.steps[0].recipient).toMatchObject({
      id: 'crew-a',
      metadata: { routing: { account: 'original' } },
    });
  });

  it('rounds decimal half-cents exactly and spreads an offset across matching steps', () => {
    const result = calculateWaterfall(
      {
        planKey: 'rounding-and-offset',
        version: 2,
        currency: 'USD',
        remainderSink: { kind: 'treasury' },
        applicationFeeOffsetRecipient: { kind: 'platform', id: 'fee' },
        steps: [
          {
            key: 'first',
            base: 'gross',
            amount: { kind: 'percent', rate: 0.29 },
            recipient: { kind: 'platform', id: 'fee' },
          },
          {
            key: 'second',
            base: 'previous_remainder',
            amount: { kind: 'fixed', amountCents: 10 },
            recipient: { kind: 'platform', id: 'fee' },
          },
        ],
      },
      { grossAmountCents: 50, currency: 'USD', applicationFeeSettledCents: 20 },
      { resolver: resolver() },
    );
    expect(result.trace.steps.map((step) => step.amountCents)).toEqual([
      15, 10,
    ]);
    expect(
      result.trace.steps.map((step) => step.applicationFeeOffsetCents),
    ).toEqual([15, 5]);
  });

  it('freezes custom metric bases for replay', () => {
    const customPlan: WaterfallPlan = {
      planKey: 'custom-base',
      version: 2,
      currency: 'USD',
      remainderSink: { kind: 'treasury' },
      steps: [
        {
          key: 'metric',
          base: 'custom',
          customBaseKey: 'labor-value',
          amount: { kind: 'percent', rate: 0.5 },
          recipient: { kind: 'worker', id: 'crew-a' },
        },
      ],
    };
    const first = calculateWaterfall(
      customPlan,
      {
        grossAmountCents: 100,
        currency: 'USD',
        customBases: { 'labor-value': 60 },
      },
      { resolver: resolver() },
    );
    expect(
      calculateWaterfall(
        customPlan,
        {
          grossAmountCents: 1,
          currency: 'USD',
          customBases: { 'labor-value': 1 },
        },
        { resolver: resolver(), frozenInputs: first.trace.frozenInputs },
      ).trace,
    ).toEqual(first.trace);
  });

  it('rejects malformed conditions and replay under changed terms', () => {
    expect(() =>
      calculateWaterfall(
        {
          ...plan,
          steps: [
            { ...plan.steps[0], conditions: { region: ['south'] } as never },
          ],
        },
        event,
        { resolver: resolver() },
      ),
    ).toThrow(/unknown condition/);
    expect(() =>
      calculateWaterfall(
        { ...plan, steps: [{ ...plan.steps[0], conditions: [] as never }] },
        event,
        { resolver: resolver() },
      ),
    ).toThrow(/conditions must be an object/);
    expect(() =>
      calculateWaterfall(
        { ...plan, steps: [{ ...plan.steps[0], key: '__proto__' }] },
        event,
        { resolver: resolver() },
      ),
    ).toThrow(/reserved key/);
    const first = calculateWaterfall(plan, event, { resolver: resolver() });
    expect(() =>
      calculateWaterfall({ ...plan, tenantId: 'other-tenant' }, event, {
        resolver: resolver(),
        frozenInputs: first.trace.frozenInputs,
      }),
    ).toThrow(/different plan version/);
  });

  it('rejects an application fee that has no matching platform allocation', () => {
    expect(() =>
      calculateWaterfall(
        { ...plan, applicationFeeOffsetRecipient: { kind: 'treasury' } },
        event,
        { resolver: resolver() },
      ),
    ).toThrow('no resolved configured recipient allocation');
  });

  it('preserves integer closure across representative percent and fixed inputs', () => {
    for (let gross = 0; gross <= 10_000; gross += 137) {
      const result = calculateWaterfall(
        {
          planKey: 'property-fixture',
          version: 2,
          currency: 'USD',
          remainderSink: { kind: 'treasury' },
          steps: [
            {
              key: 'a',
              base: 'gross',
              amount: { kind: 'percent', rate: 0.333 },
              recipient: { kind: 'worker', id: 'a' },
            },
            {
              key: 'b',
              base: 'previous_remainder',
              amount: { kind: 'fixed', amountCents: Math.min(1, gross) },
              recipient: { kind: 'worker', id: 'b' },
            },
          ],
        },
        { grossAmountCents: gross, currency: 'USD' },
        { resolver: resolver() },
      );
      expect(result.trace.closureCents).toBe(0);
    }
  });
});
