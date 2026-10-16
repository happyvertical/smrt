import { describe, expect, it } from 'vitest';
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
      { ...event, facts: { zone: 'south' } },
      {
        resolver: changed,
        frozenInputs: first.trace.frozenInputs,
      },
    );
    expect(replay.trace).toEqual(first.trace);
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
