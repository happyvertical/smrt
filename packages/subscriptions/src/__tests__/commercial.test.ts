import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TenantUsageMetricCollection } from '../collections/TenantUsageMetricCollection.js';
import {
  BillingAdjustmentCollection,
  ClientChargeCollection,
  PricingRule,
  PricingRuleCollection,
  SpendingPolicyCollection,
} from '../models/commercial.js';
import {
  CommercialUsageService,
  SpendingPolicyEvaluator,
} from '../services/commercial.js';

describe('commercial usage tracer', () => {
  let usage: TenantUsageMetricCollection;
  let rules: PricingRuleCollection;
  let charges: ClientChargeCollection;
  let adjustments: BillingAdjustmentCollection;
  let policies: SpendingPolicyCollection;
  let service: CommercialUsageService;

  beforeEach(async () => {
    usage = await TenantUsageMetricCollection.create({
      db: { type: 'sqlite', url: ':memory:' },
    });
    const options = { db: usage.db };
    rules = await PricingRuleCollection.create(options);
    charges = await ClientChargeCollection.create(options);
    adjustments = await BillingAdjustmentCollection.create(options);
    policies = await SpendingPolicyCollection.create(options);
    service = new CommercialUsageService(usage, rules, charges, adjustments);
  });
  afterEach(async () => {
    await usage.db.close?.();
  });

  it('keeps usage idempotent and prices an immutable effective-dated snapshot', async () => {
    const event = await service.record({
      tenantId: '11111111-1111-4111-8111-111111111111',
      metricKey: 'ai.tokens',
      quantity: 120,
      windowStart: new Date('2026-07-01T00:00:00Z'),
      windowEnd: new Date('2026-07-01T00:01:00Z'),
      source: 'ai-run',
      sourceId: 'run-1',
      projectId: 'project-1',
      workRefType: 'task',
      workRefId: 'task-1',
      provider: 'openai',
    });
    const duplicate = await service.record({
      tenantId: '11111111-1111-4111-8111-111111111111',
      metricKey: 'ai.tokens',
      quantity: 999,
      windowStart: new Date('2026-07-01T00:00:00Z'),
      windowEnd: new Date('2026-07-01T00:01:00Z'),
      source: 'ai-run',
      sourceId: 'run-1',
    });
    expect(duplicate.id).toBe(event.id);
    expect(duplicate.quantity).toBe(120);
    const otherMetric = await service.record({
      tenantId: event.tenantId as string,
      metricKey: 'ai.requests',
      quantity: 1,
      windowStart: new Date('2026-07-01T00:00:00Z'),
      windowEnd: new Date('2026-07-01T00:01:00Z'),
      source: 'ai-run',
      sourceId: 'run-1',
    });
    const otherSubscriber = await service.record({
      tenantId: event.tenantId as string,
      subscriberKind: 'external',
      subscriberExternalId: 'user:1',
      metricKey: 'ai.tokens',
      quantity: 3,
      windowStart: new Date('2026-07-01T00:00:00Z'),
      windowEnd: new Date('2026-07-01T00:01:00Z'),
      source: 'ai-run',
      sourceId: 'run-1',
    });
    expect(otherMetric.id).not.toBe(event.id);
    expect(otherSubscriber.id).not.toBe(event.id);
    event.quantity = 121;
    await expect(event.save()).rejects.toThrow('Operation failed: save');
    const rule = await rules.create({
      tenantId: event.tenantId,
      ruleKey: 'tokens-v1',
      metricKey: 'ai.tokens',
      strategy: 'included_overage',
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      terms: JSON.stringify({ includedQuantity: 100, overageUnitPrice: 0.02 }),
    });
    expect(rule.id).toBeTruthy();
    const draftCharge = await service.price({ usageEventId: String(event.id) });
    expect(draftCharge.status).toBe('draft');
    const charge = await service.price({
      usageEventId: String(event.id),
      approved: true,
    });
    expect(charge.id).toBe(draftCharge.id);
    expect(charge.amount).toBe(0.4);
    expect(charge.status).toBe('approved');
    expect(charge.approvedAt).toBeInstanceOf(Date);
    expect(charge.getPricingSnapshot()).toMatchObject({
      ruleKey: 'tokens-v1',
      strategy: 'included_overage',
    });
    charge.amount = 99;
    await expect(charge.save()).rejects.toThrow('Operation failed: save');
    const correction = await service.adjust(
      String(charge.id),
      -0.1,
      'provider credit',
    );
    expect(correction.amount).toBe(-0.1);
    expect(
      (await adjustments.list({ where: { clientChargeId: charge.id } })).length,
    ).toBe(1);
    correction.amount = -99;
    await expect(correction.save()).rejects.toThrow('Operation failed: save');
    charge.status = 'draft';
    await expect(charge.save()).rejects.toThrow('Operation failed: save');
  });

  it('rejects adjustments until a charge is approved', async () => {
    const charge = await charges.create({
      tenantId: '11111111-1111-4111-8111-111111111111',
      usageEventId: 'usage-draft',
      amount: 1,
      status: 'draft',
    });
    await expect(
      service.adjust(String(charge.id), -0.25, 'premature correction'),
    ).rejects.toThrow('must be approved');
  });

  it.each([
    ['fixed_unit', { unitPrice: 2 }, {}, 10, 20],
    [
      'cost_plus',
      { fixedMarkup: 1, markupRatio: 0.2 },
      { providerCost: 10 },
      1,
      13,
    ],
    ['multiplier', { multiplier: 1.5 }, { providerCost: 10 }, 1, 15],
    [
      'tiered',
      {
        tiers: [
          { upTo: 10, unitPrice: 1 },
          { upTo: null, unitPrice: 0.5 },
        ],
      },
      {},
      14,
      12,
    ],
    [
      'included_overage',
      { includedQuantity: 100, overageUnitPrice: 0.02 },
      {},
      120,
      0.4,
    ],
    ['flat', { amount: 9 }, {}, 999, 9],
  ] as const)('prices the %s strategy', async (strategy, terms, dimensions, quantity, expected) => {
    const rule = new PricingRule();
    rule.strategy = strategy;
    rule.terms = JSON.stringify(terms);
    expect(await service.calculateAmount(rule, quantity, dimensions)).toBe(
      expected,
    );
  });

  it('supports registered custom pricing strategies', async () => {
    service.registerCustomStrategy(
      'seat-hour',
      ({ usage }) => usage.quantity * 3,
    );
    const rule = new PricingRule();
    rule.strategy = 'custom';
    rule.terms = JSON.stringify({ strategyKey: 'seat-hour' });
    expect(await service.calculateAmount(rule, 4)).toBe(12);
  });

  it.each([
    ['observe', true, false, 'observed'],
    ['warn', true, false, 'warned'],
    ['block', false, false, 'blocked'],
    ['approval_required', false, true, 'approval_required'],
  ] as const)('enforces %s policies before expensive work', async (behavior, allowed, approvalRequired, state) => {
    await policies.create({
      tenantId: '11111111-1111-4111-8111-111111111111',
      name: behavior,
      projectId: 'project-1',
      serviceKey: 'ai',
      metricKey: 'ai.tokens',
      period: 'month',
      limitAmount: 5,
      behavior,
    });
    const decision = await new SpendingPolicyEvaluator(
      policies,
      charges,
    ).evaluate({
      tenantId: '11111111-1111-4111-8111-111111111111',
      projectId: 'project-1',
      serviceKey: 'ai',
      metricKey: 'ai.tokens',
      estimatedAmount: 6,
      at: new Date('2026-07-10T00:00:00Z'),
    });
    expect(decision).toMatchObject({
      allowed,
      approvalRequired,
      state,
      projectedAmount: 6,
    });
  });

  it('scopes spending policy name conflicts by tenant and policy scope', async () => {
    const tenantA = '11111111-1111-4111-8111-111111111111';
    const tenantB = '22222222-2222-4222-8222-222222222222';
    const first = await policies.create({
      tenantId: tenantA,
      name: 'Monthly cap',
      projectId: 'project-1',
      serviceKey: 'ai',
      metricKey: 'ai.tokens',
      period: 'month',
      limitAmount: 10,
      behavior: 'warn',
    });
    const otherTenant = await policies.create({
      tenantId: tenantB,
      name: 'Monthly cap',
      projectId: 'project-1',
      serviceKey: 'ai',
      metricKey: 'ai.tokens',
      period: 'month',
      limitAmount: 20,
      behavior: 'block',
    });
    const otherProject = await policies.create({
      tenantId: tenantA,
      name: 'Monthly cap',
      projectId: 'project-2',
      serviceKey: 'ai',
      metricKey: 'ai.tokens',
      period: 'month',
      limitAmount: 30,
      behavior: 'approval_required',
    });

    expect(new Set([first.id, otherTenant.id, otherProject.id]).size).toBe(3);
    expect(first).toMatchObject({ tenantId: tenantA, limitAmount: 10 });
    expect(otherTenant).toMatchObject({ tenantId: tenantB, limitAmount: 20 });
    expect(otherProject).toMatchObject({
      tenantId: tenantA,
      projectId: 'project-2',
      limitAmount: 30,
    });
  });

  it('aggregates all metrics for a wildcard spending policy', async () => {
    const tenantId = '11111111-1111-4111-8111-111111111111';
    await policies.create({
      tenantId,
      name: 'all project spend',
      projectId: 'project-1',
      metricKey: '',
      period: 'month',
      limitAmount: 10,
      behavior: 'block',
    });
    for (const [metricKey, amount] of [
      ['ai.tokens', 4],
      ['storage.bytes', 5],
    ] as const) {
      await charges.create({
        tenantId,
        usageEventId: `usage-${metricKey}`,
        projectId: 'project-1',
        metricKey,
        amount,
        status: 'approved',
        approvedAt: new Date('2026-07-01T00:00:00Z'),
      });
    }
    const decision = await new SpendingPolicyEvaluator(
      policies,
      charges,
    ).evaluate({
      tenantId,
      projectId: 'project-1',
      metricKey: 'ai.tokens',
      estimatedAmount: 2,
      at: new Date('2026-07-31T00:00:00Z'),
    });
    expect(decision).toMatchObject({
      allowed: false,
      state: 'blocked',
      projectedAmount: 11,
    });
  });
});
