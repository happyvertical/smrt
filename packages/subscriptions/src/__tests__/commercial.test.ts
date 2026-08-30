import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TenantUsageMetricCollection } from '../collections/TenantUsageMetricCollection.js';
import {
  BillingAdjustmentCollection,
  ClientCharge,
  ClientChargeCollection,
  PricingRule,
  PricingRuleCollection,
  SpendingPolicyCollection,
} from '../models/commercial.js';
import {
  assertCommercialBillingStorageSupported,
  CommercialBillingStorageConfigurationError,
  CommercialUsageService,
  SpendingPolicyEvaluator,
  UnsupportedCommercialBillingStorageError,
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
    service = new CommercialUsageService(usage, rules, charges, adjustments, {
      adapterType: 'sqlite',
    });
  });

  it('rejects non-transactional billing write-back adapters before setup', async () => {
    await expect(
      CommercialUsageService.create({
        db: {
          type: 'json',
          url: './unused-commercial-json',
        },
      }),
    ).rejects.toBeInstanceOf(UnsupportedCommercialBillingStorageError);
    await expect(
      CommercialUsageService.create({
        db: {
          type: 'duckdb',
          url: ':memory:',
          writeStrategy: 'immediate',
        },
      }),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_COMMERCIAL_BILLING_STORAGE',
    });
    await expect(
      CommercialUsageService.create({ db: usage.db }),
    ).rejects.toBeInstanceOf(CommercialBillingStorageConfigurationError);
    await expect(
      CommercialUsageService.create({ persistence: usage.db }),
    ).rejects.toBeInstanceOf(CommercialBillingStorageConfigurationError);
    await expect(
      CommercialUsageService.create({
        persistence: {
          type: 'duckdb',
          url: ':memory:',
          writeStrategy: 'immediate',
        },
      }),
    ).rejects.toBeInstanceOf(UnsupportedCommercialBillingStorageError);
    await expect(
      CommercialUsageService.create({
        db: {
          type: 'json',
          url: './unused-commercial-json',
          writeStrategy: 'immediate',
        },
        billingStorage: { adapterType: 'json', writeStrategy: 'manual' },
      }),
    ).rejects.toBeInstanceOf(CommercialBillingStorageConfigurationError);
  });

  it('uses SQL environment precedence when the adapter type is omitted', async () => {
    vi.stubEnv('HAVE_SQL_TYPE', 'json');
    await expect(
      CommercialUsageService.create({
        db: { url: 'file:billing-json' },
      }),
    ).rejects.toBeInstanceOf(UnsupportedCommercialBillingStorageError);
    vi.stubEnv('HAVE_SQL_TYPE', 'duckdb');
    vi.stubEnv('HAVE_SQL_WRITE_STRATEGY', 'immediate');
    await expect(CommercialUsageService.create()).rejects.toBeInstanceOf(
      UnsupportedCommercialBillingStorageError,
    );
    vi.stubEnv('HAVE_SQL_TYPE', 'sqlite');
    vi.stubEnv('HAVE_SQL_WRITE_STRATEGY', '');
    const directory = await mkdtemp(join(tmpdir(), 'smrt-commercial-'));
    try {
      await expect(
        CommercialUsageService.create({
          db: join(directory, 'billing.db'),
          billingStorage: { adapterType: 'sqlite' },
        }),
      ).resolves.toBeInstanceOf(CommercialUsageService);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('normalizes environment values over explicitly undefined options', async () => {
    vi.stubEnv('HAVE_SQL_TYPE', 'json');
    vi.stubEnv('HAVE_SQL_WRITE_STRATEGY', 'immediate');
    await expect(
      CommercialUsageService.create({
        db: {
          type: undefined,
          url: './unused-commercial-json',
          writeStrategy: undefined,
        },
      }),
    ).rejects.toBeInstanceOf(UnsupportedCommercialBillingStorageError);

    vi.stubEnv('HAVE_SQL_WRITE_STRATEGY', 'manual');
    const directory = await mkdtemp(join(tmpdir(), 'smrt-commercial-'));
    try {
      await expect(
        CommercialUsageService.create({
          db: {
            type: 'json',
            url: join(directory, 'billing.json'),
            writeStrategy: undefined,
          },
          billingStorage: { adapterType: 'json', writeStrategy: 'manual' },
        }),
      ).resolves.toBeInstanceOf(CommercialUsageService);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it.each([
    '',
    false,
    'later',
  ])('rejects invalid configured write strategy %j before setup', async (writeStrategy) => {
    await expect(
      CommercialUsageService.create({
        db: {
          type: 'json',
          url: './unused-commercial-json',
          writeStrategy: writeStrategy as never,
        },
        billingStorage: { adapterType: 'json', writeStrategy: 'manual' },
      }),
    ).rejects.toBeInstanceOf(CommercialBillingStorageConfigurationError);
  });

  it.each([
    '',
    false,
    'later',
  ])('rejects invalid declared write strategy %j before use', (writeStrategy) => {
    expect(() =>
      assertCommercialBillingStorageSupported({
        adapterType: 'json',
        writeStrategy: writeStrategy as never,
      }),
    ).toThrow(CommercialBillingStorageConfigurationError);
    expect(
      () =>
        new CommercialUsageService(usage, rules, charges, adjustments, {
          adapterType: 'json',
          writeStrategy: writeStrategy as never,
        }),
    ).toThrow(CommercialBillingStorageConfigurationError);
  });

  it('validates declarations before default resolution and snapshots accessors', async () => {
    await expect(
      CommercialUsageService.create({
        billingStorage: {
          adapterType: 'sqlite',
          writeStrategy: '' as never,
        },
      }),
    ).rejects.toBeInstanceOf(CommercialBillingStorageConfigurationError);

    let storageReads = 0;
    expect(() =>
      assertCommercialBillingStorageSupported({
        adapterType: 'json',
        get writeStrategy() {
          storageReads += 1;
          return storageReads === 1 ? 'manual' : (false as never);
        },
      }),
    ).not.toThrow();
    expect(storageReads).toBe(1);

    let configReads = 0;
    await expect(
      CommercialUsageService.create({
        db: {
          type: 'duckdb',
          url: ':memory:',
          get writeStrategy() {
            configReads += 1;
            return configReads === 1 ? undefined : 'immediate';
          },
        },
      }),
    ).resolves.toBeInstanceOf(CommercialUsageService);
    expect(configReads).toBe(1);
  });

  it.each([
    undefined,
    false,
    'bogus',
  ])('rejects invalid declared adapter type %j before resolved-handle use', async (adapterType) => {
    const billingStorage = {
      adapterType: adapterType as never,
      writeStrategy: 'manual' as const,
    };
    expect(() =>
      assertCommercialBillingStorageSupported(billingStorage),
    ).toThrow(CommercialBillingStorageConfigurationError);
    await expect(
      CommercialUsageService.create({ db: usage.db, billingStorage }),
    ).rejects.toBeInstanceOf(CommercialBillingStorageConfigurationError);
  });

  it('normalizes explicit contracts for ambiguous database strings', async () => {
    vi.stubEnv('HAVE_SQL_TYPE', '');
    const directory = await mkdtemp(join(tmpdir(), 'smrt-commercial-'));
    try {
      await expect(
        CommercialUsageService.create({
          db: join(directory, 'billing-db-option.db'),
          billingStorage: { adapterType: 'sqlite' },
        }),
      ).resolves.toBeInstanceOf(CommercialUsageService);
      await expect(
        CommercialUsageService.create({
          db: join(directory, 'billing.duckdb'),
          billingStorage: {
            adapterType: 'duckdb',
            writeStrategy: 'manual',
          },
        }),
      ).resolves.toBeInstanceOf(CommercialUsageService);
      await expect(
        CommercialUsageService.create({
          db: join(directory, 'billing.json'),
          billingStorage: {
            adapterType: 'json',
            writeStrategy: 'immediate',
          },
        }),
      ).rejects.toBeInstanceOf(UnsupportedCommercialBillingStorageError);
      await expect(
        CommercialUsageService.create({
          persistence: join(directory, 'billing-persistence-option.db'),
          billingStorage: { adapterType: 'sqlite' },
        }),
      ).resolves.toBeInstanceOf(CommercialUsageService);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('preserves relational and ordinary DuckDB billing storage', () => {
    expect(() =>
      assertCommercialBillingStorageSupported({ adapterType: 'sqlite' }),
    ).not.toThrow();
    expect(() =>
      assertCommercialBillingStorageSupported({ adapterType: 'postgres' }),
    ).not.toThrow();
    expect(() =>
      assertCommercialBillingStorageSupported({ adapterType: 'duckdb' }),
    ).not.toThrow();
    expect(() =>
      assertCommercialBillingStorageSupported({
        adapterType: 'duckdb',
        writeStrategy: 'none',
      }),
    ).not.toThrow();
    expect(() =>
      assertCommercialBillingStorageSupported({
        adapterType: 'duckdb',
        writeStrategy: 'manual',
      }),
    ).not.toThrow();
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await usage.db.close?.();
  });

  async function seedUsageEvent(
    id: string,
    tenantId: string,
    metricKey = 'ai.tokens',
  ): Promise<void> {
    await usage.create({
      id,
      tenantId,
      metricKey,
      quantity: 0,
      windowStart: new Date('2026-07-01T00:00:00Z'),
      windowEnd: new Date('2026-07-01T00:01:00Z'),
    });
  }

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
      terms: JSON.stringify({ includedQuantity: 100, overageUnitPrice: 2 }),
    });
    expect(rule.id).toBeTruthy();
    const draftCharge = await service.price({ usageEventId: String(event.id) });
    expect(draftCharge.status).toBe('draft');
    const charge = await service.price({
      usageEventId: String(event.id),
      approved: true,
    });
    expect(charge.id).toBe(draftCharge.id);
    expect(charge.amount).toBe(40); // 20 overage units x 2 cents
    expect(charge.status).toBe('approved');
    expect(charge.approvedAt).toBeInstanceOf(Date);
    expect(charge.getPricingSnapshot()).toMatchObject({
      ruleKey: 'tokens-v1',
      strategy: 'included_overage',
    });
    const originalTenantId = charge.tenantId;
    charge.tenantId = '22222222-2222-4222-8222-222222222222';
    await expect(charge.save()).rejects.toThrow('Operation failed: save');
    charge.tenantId = originalTenantId;
    charge.amount = 99;
    await expect(charge.save()).rejects.toThrow('Operation failed: save');
    const correction = await service.adjust(
      String(charge.id),
      -10,
      'provider credit',
    );
    expect(correction.amount).toBe(-10);
    expect(
      (await adjustments.list({ where: { clientChargeId: charge.id } })).length,
    ).toBe(1);
    correction.amount = -99;
    await expect(correction.save()).rejects.toThrow('Operation failed: save');
    charge.status = 'draft';
    await expect(charge.save()).rejects.toThrow('Operation failed: save');
  });

  it('shares one resolved database in commercial service factories', async () => {
    const factory = await CommercialUsageService.create({
      db: { type: 'sqlite', url: ':memory:' },
    });
    const event = await factory.record({
      tenantId: '11111111-1111-4111-8111-111111111111',
      metricKey: 'ai.tokens',
      quantity: 10,
      windowStart: new Date('2026-07-01T00:00:00Z'),
      windowEnd: new Date('2026-07-01T00:01:00Z'),
      source: 'factory-test',
      sourceId: 'event-1',
    });
    const factoryRules = await PricingRuleCollection.create({ db: event.db });
    const rule = await factoryRules.create({
      tenantId: event.tenantId,
      ruleKey: 'factory-rule',
      metricKey: 'ai.tokens',
      strategy: 'fixed_unit',
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    });
    // Pricing terms are minor units per unit of usage (#2401): 5 cents each.
    rule.setTerms({ unitPrice: 5 });
    await rule.save();

    const charge = await factory.price({ usageEventId: String(event.id) });

    expect(charge).toMatchObject({ amount: 50, usageEventId: event.id });
    await event.db.close?.();
  });

  it('enforces sourced usage idempotency across concurrent writers', async () => {
    const input = {
      tenantId: '11111111-1111-4111-8111-111111111111',
      metricKey: 'ai.tokens',
      quantity: 100,
      windowStart: new Date('2026-07-01T00:00:00Z'),
      windowEnd: new Date('2026-07-01T00:01:00Z'),
      source: 'ai-run',
      sourceId: 'concurrent-run',
    };
    const [first, second] = await Promise.all([
      service.record(input),
      service.record({ ...input, quantity: 999 }),
    ]);

    expect(second.id).toBe(first.id);
    expect(second.quantity).toBe(first.quantity);
    expect(first.id).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );
    expect(await usage.get(String(first.id))).toMatchObject({ id: first.id });
  });

  it('does not let concurrent charge pricing revert an approval', async () => {
    const event = await service.record({
      tenantId: '11111111-1111-4111-8111-111111111111',
      metricKey: 'ai.tokens',
      quantity: 10,
      windowStart: new Date('2026-07-01T00:00:00Z'),
      windowEnd: new Date('2026-07-01T00:01:00Z'),
      source: 'ai-run',
      sourceId: 'concurrent-price',
    });
    await rules.create({
      tenantId: event.tenantId,
      ruleKey: 'tokens-concurrent',
      metricKey: 'ai.tokens',
      strategy: 'fixed_unit',
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      terms: JSON.stringify({ unitPrice: 1 }),
    });

    const [approved, draftAttempt] = await Promise.all([
      service.price({ usageEventId: String(event.id), approved: true }),
      service.price({ usageEventId: String(event.id) }),
    ]);

    expect(draftAttempt.id).toBe(approved.id);
    expect((await charges.get(String(approved.id)))?.status).toBe('approved');
    expect(
      await charges.list({ where: { usageEventId: String(event.id) } }),
    ).toHaveLength(1);
  });

  it('keeps unsourced usage evidence distinct', async () => {
    const input = {
      tenantId: '11111111-1111-4111-8111-111111111111',
      metricKey: 'ai.tokens',
      quantity: 100,
      windowStart: new Date('2026-07-01T00:00:00Z'),
      windowEnd: new Date('2026-07-01T00:01:00Z'),
    };
    const [first, second] = await Promise.all([
      service.record(input),
      service.record(input),
    ]);

    expect(first.id).not.toBe(second.id);
  });

  it('rejects adjustments until a charge is approved', async () => {
    await seedUsageEvent('usage-draft', '11111111-1111-4111-8111-111111111111');
    const charge = await charges.create({
      tenantId: '11111111-1111-4111-8111-111111111111',
      usageEventId: 'usage-draft',
      amount: 1,
      status: 'draft',
    });
    await expect(
      service.adjust(String(charge.id), -25, 'premature correction'),
    ).rejects.toThrow('must be approved');
  });

  it('deduplicates concurrent sourced billing adjustments', async () => {
    await seedUsageEvent(
      'usage-adjustment-retry',
      '11111111-1111-4111-8111-111111111111',
    );
    const charge = await charges.create({
      tenantId: '11111111-1111-4111-8111-111111111111',
      usageEventId: 'usage-adjustment-retry',
      amount: 10,
      status: 'approved',
      approvedAt: new Date('2026-07-01T00:00:00Z'),
    });
    const [first, second] = await Promise.all([
      service.adjust(
        String(charge.id),
        -1,
        'provider credit',
        'provider-credit',
        'credit-1',
      ),
      service.adjust(
        String(charge.id),
        -1,
        'provider credit',
        'provider-credit',
        'credit-1',
      ),
    ]);

    expect(second.id).toBe(first.id);
    expect(
      await adjustments.list({ where: { clientChargeId: charge.id } }),
    ).toHaveLength(1);
    expect((await charges.get(String(charge.id)))?.status).toBe('adjusted');
  });

  it('rolls back an unsourced adjustment when the charge revision drifts', async () => {
    await seedUsageEvent(
      'usage-adjustment-race',
      '11111111-1111-4111-8111-111111111111',
    );
    const charge = await charges.create({
      tenantId: '11111111-1111-4111-8111-111111111111',
      usageEventId: 'usage-adjustment-race',
      amount: 10,
      status: 'approved',
      approvedAt: new Date('2026-07-01T00:00:00Z'),
    });
    const originalSave = ClientCharge.prototype.save;
    vi.spyOn(ClientCharge.prototype, 'save').mockImplementationOnce(
      async function (this: ClientCharge, ...args) {
        await this.db.update(
          this.tableName,
          { id: this.id },
          { updated_at: new Date(Date.now() + 1_000) },
        );
        return originalSave.apply(this, args);
      },
    );

    await expect(
      service.adjust(String(charge.id), -1, 'provider credit'),
    ).rejects.toMatchObject({ code: 'RUNTIME_REVISION_CONFLICT' });

    expect(
      await adjustments.list({ where: { clientChargeId: charge.id } }),
    ).toHaveLength(0);
    expect((await charges.get(String(charge.id)))?.status).toBe('approved');
  });

  // Terms are minor units per unit of usage and may be fractional (a per-token
  // rate is routinely a fraction of a cent); the RESULT is rounded to a whole
  // minor unit, which is what `expected` asserts (#2401).
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
      { includedQuantity: 100, overageUnitPrice: 2 },
      {},
      120,
      40,
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
      adjustments,
    ).evaluate({
      tenantId: '11111111-1111-4111-8111-111111111111',
      projectId: 'project-1',
      serviceKey: 'ai',
      metricKey: 'ai.tokens',
      estimatedAmount: 6,
      currency: 'USD',
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

  it('prefers subscriber-specific policy scope over broad subscriber kind', async () => {
    const tenantId = '11111111-1111-4111-8111-111111111111';
    await policies.create({
      tenantId,
      name: 'All external subscribers',
      subscriberKind: 'external',
      metricKey: 'ai.tokens',
      period: 'month',
      limitAmount: 5,
      behavior: 'warn',
      priority: 100,
    });
    const specific = await policies.create({
      tenantId,
      name: 'Specific external subscriber',
      subscriberKind: 'external',
      subscriberExternalId: 'user:1',
      metricKey: 'ai.tokens',
      period: 'month',
      limitAmount: 5,
      behavior: 'block',
      priority: 0,
    });
    const decision = await new SpendingPolicyEvaluator(
      policies,
      charges,
      adjustments,
    ).evaluate({
      tenantId,
      subscriberKind: 'external',
      subscriberExternalId: 'user:1',
      metricKey: 'ai.tokens',
      estimatedAmount: 6,
      currency: 'USD',
      at: new Date('2026-07-10T00:00:00Z'),
    });
    expect(decision).toMatchObject({
      allowed: false,
      state: 'blocked',
      matchedPolicyId: specific.id,
    });
  });

  it('rejects malformed subscriber scope during spending evaluation', async () => {
    await expect(
      new SpendingPolicyEvaluator(policies, charges, adjustments).evaluate({
        tenantId: '11111111-1111-4111-8111-111111111111',
        subscriberExternalId: 'user:1',
        metricKey: 'ai.tokens',
        estimatedAmount: 1,
        currency: 'USD',
      }),
    ).rejects.toThrow(/subscriberKind/i);
  });

  it('rejects subscriber-specific policies without a subscriber kind', async () => {
    await expect(
      policies.create({
        tenantId: '11111111-1111-4111-8111-111111111111',
        name: 'Invalid subscriber scope',
        subscriberExternalId: 'user:1',
        metricKey: 'ai.tokens',
        limitAmount: 5,
        behavior: 'block',
      }),
    ).rejects.toThrow('Operation failed: save');
  });

  it('rejects rolling policies without a positive window', async () => {
    await expect(
      policies.create({
        tenantId: '11111111-1111-4111-8111-111111111111',
        name: 'Invalid rolling cap',
        metricKey: 'ai.tokens',
        period: 'rolling',
        rollingSeconds: 0,
        limitAmount: 5,
        behavior: 'block',
      }),
    ).rejects.toThrow('Operation failed: save');
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
      await seedUsageEvent(`usage-${metricKey}`, tenantId, metricKey);
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
      adjustments,
    ).evaluate({
      tenantId,
      projectId: 'project-1',
      metricKey: 'ai.tokens',
      estimatedAmount: 2,
      currency: 'USD',
      at: new Date('2026-07-31T00:00:00Z'),
    });
    expect(decision).toMatchObject({
      allowed: false,
      state: 'blocked',
      projectedAmount: 11,
    });
  });

  it('enforces every matching spending policy period', async () => {
    const tenantId = '11111111-1111-4111-8111-111111111111';
    await policies.create({
      tenantId,
      name: 'Daily cap',
      metricKey: 'ai.tokens',
      period: 'day',
      limitAmount: 100,
      behavior: 'block',
    });
    const monthly = await policies.create({
      tenantId,
      name: 'Monthly cap',
      metricKey: 'ai.tokens',
      period: 'month',
      limitAmount: 5,
      behavior: 'block',
    });
    await seedUsageEvent('usage-earlier-this-month', tenantId);
    await charges.create({
      tenantId,
      usageEventId: 'usage-earlier-this-month',
      metricKey: 'ai.tokens',
      amount: 4,
      currency: 'USD',
      status: 'approved',
      approvedAt: new Date('2026-07-02T00:00:00Z'),
    });

    const decision = await new SpendingPolicyEvaluator(
      policies,
      charges,
      adjustments,
    ).evaluate({
      tenantId,
      metricKey: 'ai.tokens',
      estimatedAmount: 2,
      currency: 'USD',
      at: new Date('2026-07-10T00:00:00Z'),
    });

    expect(decision).toMatchObject({
      allowed: false,
      state: 'blocked',
      projectedAmount: 6,
      matchedPolicyId: monthly.id,
    });
  });

  it('only counts charges in the spending policy currency', async () => {
    const tenantId = '11111111-1111-4111-8111-111111111111';
    await policies.create({
      tenantId,
      name: 'USD project cap',
      projectId: 'project-1',
      metricKey: 'ai.tokens',
      period: 'month',
      limitAmount: 10,
      currency: 'USD',
      behavior: 'block',
    });
    for (const [currency, amount] of [
      ['USD', 4],
      ['EUR', 100],
    ] as const) {
      await seedUsageEvent(`usage-${currency.toLowerCase()}`, tenantId);
      await charges.create({
        tenantId,
        usageEventId: `usage-${currency.toLowerCase()}`,
        projectId: 'project-1',
        metricKey: 'ai.tokens',
        amount,
        currency,
        status: 'approved',
        approvedAt: new Date('2026-07-02T00:00:00Z'),
      });
    }
    const decision = await new SpendingPolicyEvaluator(
      policies,
      charges,
      adjustments,
    ).evaluate({
      tenantId,
      projectId: 'project-1',
      metricKey: 'ai.tokens',
      estimatedAmount: 2,
      currency: 'USD',
      at: new Date('2026-07-10T00:00:00Z'),
    });
    expect(decision).toMatchObject({
      allowed: true,
      state: 'ok',
      projectedAmount: 6,
    });
  });

  it('selects spending policies in the prospective charge currency', async () => {
    const tenantId = '11111111-1111-4111-8111-111111111111';
    await policies.create({
      tenantId,
      name: 'USD cap',
      metricKey: 'ai.tokens',
      currency: 'USD',
      period: 'month',
      limitAmount: 1,
      behavior: 'block',
      priority: 100,
    });
    const euroPolicy = await policies.create({
      tenantId,
      name: 'EUR cap',
      metricKey: 'ai.tokens',
      currency: 'EUR',
      period: 'month',
      limitAmount: 10,
      behavior: 'block',
    });

    const decision = await new SpendingPolicyEvaluator(
      policies,
      charges,
      adjustments,
    ).evaluate({
      tenantId,
      metricKey: 'ai.tokens',
      estimatedAmount: 2,
      currency: 'EUR',
      at: new Date('2026-07-10T00:00:00Z'),
    });

    expect(decision).toMatchObject({
      allowed: true,
      state: 'ok',
      projectedAmount: 2,
      matchedPolicyId: euroPolicy.id,
    });
  });

  it('counts approved charges in the policy period when approval occurred', async () => {
    const tenantId = '11111111-1111-4111-8111-111111111111';
    await policies.create({
      tenantId,
      name: 'July approval cap',
      projectId: 'project-1',
      metricKey: 'ai.tokens',
      period: 'month',
      limitAmount: 10,
      behavior: 'block',
    });
    await seedUsageEvent('usage-approved-in-july', tenantId);
    await charges.create({
      tenantId,
      usageEventId: 'usage-approved-in-july',
      projectId: 'project-1',
      metricKey: 'ai.tokens',
      amount: 9,
      status: 'approved',
      createdAt: new Date('2026-06-30T23:59:00Z'),
      approvedAt: new Date('2026-07-02T00:00:00Z'),
    });
    const decision = await new SpendingPolicyEvaluator(
      policies,
      charges,
      adjustments,
    ).evaluate({
      tenantId,
      projectId: 'project-1',
      metricKey: 'ai.tokens',
      estimatedAmount: 2,
      currency: 'USD',
      at: new Date('2026-07-10T00:00:00Z'),
    });
    expect(decision).toMatchObject({
      allowed: false,
      state: 'blocked',
      projectedAmount: 11,
    });
  });
});
