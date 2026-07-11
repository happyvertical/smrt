import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { TenantUsageMetricCollection } from '../collections/TenantUsageMetricCollection.js';
import {
  BillingAdjustmentCollection,
  type ClientCharge,
  ClientChargeCollection,
  type PricingRule,
  PricingRuleCollection,
  type PricingStrategy,
  type SpendingPolicy,
  SpendingPolicyCollection,
} from '../models/commercial.js';
import type { RecordUsageOptions } from '../types.js';

export interface PriceUsageOptions {
  usageEventId: string;
  approved?: boolean;
  at?: Date;
}
export interface CustomPricingContext {
  usage: { quantity: number; dimensions: Record<string, unknown> };
  rule: PricingRule;
  terms: Record<string, unknown>;
}
export type CustomPricingStrategy = (
  context: CustomPricingContext,
) => number | Promise<number>;

export class CommercialUsageService {
  private readonly customStrategies = new Map<string, CustomPricingStrategy>();
  constructor(
    private readonly usage: TenantUsageMetricCollection,
    private readonly rules: PricingRuleCollection,
    private readonly charges: ClientChargeCollection,
    private readonly adjustments: BillingAdjustmentCollection,
  ) {}

  static async create(
    options: SmrtClassOptions = {},
  ): Promise<CommercialUsageService> {
    return new CommercialUsageService(
      await TenantUsageMetricCollection.create(options),
      await PricingRuleCollection.create(options),
      await ClientChargeCollection.create(options),
      await BillingAdjustmentCollection.create(options),
    );
  }

  registerCustomStrategy(key: string, strategy: CustomPricingStrategy): void {
    this.customStrategies.set(key, strategy);
  }

  async record(options: RecordUsageOptions) {
    return this.usage.recordUsage(options);
  }

  async price(options: PriceUsageOptions): Promise<ClientCharge> {
    const existing = await this.charges.list({
      where: { usageEventId: options.usageEventId },
      limit: 1,
    });
    if (existing[0]) return existing[0];
    const usage = await this.usage.get(options.usageEventId);
    if (!usage)
      throw new Error(`Usage event ${options.usageEventId} was not found.`);
    const at = options.at ?? usage.windowStart;
    const dimensions = usage.getDimensions();
    const rules = await this.rules.list({
      where: {
        tenantId: usage.tenantId,
        metricKey: usage.metricKey,
        active: true,
      },
    });
    const rule = selectRule(rules, at, String(dimensions.serviceKey ?? ''));
    if (!rule)
      throw new Error(
        `No effective pricing rule for metric '${usage.metricKey}'.`,
      );
    if (!usage.id)
      throw new Error(
        `Usage event ${options.usageEventId} has no persisted id.`,
      );
    if (!rule.id)
      throw new Error(`Pricing rule '${rule.ruleKey}' has no persisted id.`);
    const amount = await this.calculateAmount(rule, usage.quantity, dimensions);
    return this.charges.create({
      tenantId: usage.tenantId,
      usageEventId: String(usage.id),
      subscriberKind: usage.subscriberKind,
      subscriberExternalId: usage.subscriberExternalId,
      projectId: usage.projectId,
      workRefType: usage.workRefType,
      workRefId: usage.workRefId,
      provider: usage.provider,
      serviceKey: String(dimensions.serviceKey ?? ''),
      metricKey: usage.metricKey,
      quantity: usage.quantity,
      amount,
      currency: rule.currency,
      pricingRuleId: String(rule.id),
      pricingSnapshot: JSON.stringify({
        ruleKey: rule.ruleKey,
        strategy: rule.strategy,
        terms: rule.getTerms(),
        effectiveFrom: rule.effectiveFrom,
      }),
      status: options.approved ? 'approved' : 'draft',
      approvedAt: options.approved ? new Date() : null,
    });
  }

  async adjust(
    chargeId: string,
    amount: number,
    reason: string,
    source = '',
    sourceId = '',
  ) {
    const charge = await this.charges.get(chargeId);
    if (!charge) throw new Error(`Client charge ${chargeId} was not found.`);
    if (charge.status !== 'approved' && charge.status !== 'adjusted') {
      throw new Error(
        `Client charge ${chargeId} must be approved before it can be adjusted.`,
      );
    }
    const adjustment = await this.adjustments.create({
      tenantId: charge.tenantId,
      clientChargeId: chargeId,
      amount,
      currency: charge.currency,
      reason,
      source,
      sourceId,
    });
    if (charge.status === 'approved') {
      charge.status = 'adjusted';
      await charge.save();
    }
    return adjustment;
  }

  async calculateAmount(
    rule: PricingRule,
    quantity: number,
    dimensions: Record<string, unknown> = {},
  ): Promise<number> {
    const terms = rule.getTerms();
    const number = (key: string, fallback = 0) =>
      Number(terms[key] ?? fallback);
    let amount: number;
    switch (rule.strategy as PricingStrategy) {
      case 'fixed_unit':
        amount = quantity * number('unitPrice');
        break;
      case 'cost_plus':
        amount =
          Number(dimensions.providerCost ?? 0) +
          number('fixedMarkup') +
          Number(dimensions.providerCost ?? 0) * number('markupRatio');
        break;
      case 'multiplier':
        amount =
          Number(dimensions.providerCost ?? quantity) * number('multiplier', 1);
        break;
      case 'flat':
        amount = number('amount');
        break;
      case 'included_overage':
        amount =
          Math.max(0, quantity - number('includedQuantity')) *
          number('overageUnitPrice');
        break;
      case 'tiered':
        amount = priceTiers(
          quantity,
          Array.isArray(terms.tiers) ? terms.tiers : [],
        );
        break;
      case 'custom': {
        const custom = this.customStrategies.get(
          String(terms.strategyKey ?? ''),
        );
        if (!custom)
          throw new Error(
            `Custom pricing strategy '${String(terms.strategyKey ?? '')}' is not registered.`,
          );
        amount = await custom({ usage: { quantity, dimensions }, rule, terms });
        break;
      }
    }
    if (!Number.isFinite(amount) || amount < 0)
      throw new Error('Pricing produced an invalid amount.');
    return Math.round(amount * 1e6) / 1e6;
  }
}

export interface SpendingDecision {
  allowed: boolean;
  approvalRequired: boolean;
  state: 'ok' | 'observed' | 'warned' | 'blocked' | 'approval_required';
  projectedAmount: number;
  matchedPolicyId: string | null;
}

export class SpendingPolicyEvaluator {
  constructor(
    private readonly policies: SpendingPolicyCollection,
    private readonly charges: ClientChargeCollection,
    private readonly adjustments?: BillingAdjustmentCollection,
  ) {}
  static async create(options: SmrtClassOptions = {}) {
    return new SpendingPolicyEvaluator(
      await SpendingPolicyCollection.create(options),
      await ClientChargeCollection.create(options),
      await BillingAdjustmentCollection.create(options),
    );
  }

  async evaluate(input: {
    tenantId: string;
    subscriberKind?: string;
    subscriberExternalId?: string;
    projectId?: string;
    serviceKey?: string;
    metricKey: string;
    estimatedAmount: number;
    at?: Date;
  }): Promise<SpendingDecision> {
    const at = input.at ?? new Date();
    const candidates = await this.policies.list({
      where: { tenantId: input.tenantId, active: true },
    });
    const policy = selectPolicy(candidates, input);
    if (!policy)
      return {
        allowed: true,
        approvalRequired: false,
        state: 'ok',
        projectedAmount: input.estimatedAmount,
        matchedPolicyId: null,
      };
    const [start, end] = policyWindow(policy, at);
    const chargeWhere: Record<string, unknown> = {
      tenantId: input.tenantId,
      'createdAt >=': start.toISOString(),
      'createdAt <': end.toISOString(),
    };
    if (policy.metricKey) chargeWhere.metricKey = policy.metricKey;
    const rows = await this.charges.list({ where: chargeWhere });
    const scopedCharges = rows.filter(
      (charge) =>
        (charge.status === 'approved' || charge.status === 'adjusted') &&
        matchesChargeScope(policy, charge),
    );
    const chargeIds = new Set(scopedCharges.map((charge) => charge.id));
    const adjustmentRows = this.adjustments
      ? await this.adjustments.list({ where: { tenantId: input.tenantId } })
      : [];
    const spent = scopedCharges.reduce((sum, charge) => sum + charge.amount, 0);
    const correctedSpent =
      spent +
      adjustmentRows
        .filter((adjustment) => chargeIds.has(adjustment.clientChargeId))
        .reduce((sum, adjustment) => sum + adjustment.amount, 0);
    const projectedAmount = correctedSpent + input.estimatedAmount;
    const exceeded = projectedAmount > policy.limitAmount;
    if (!exceeded || policy.behavior === 'observe')
      return {
        allowed: true,
        approvalRequired: false,
        state: exceeded ? 'observed' : 'ok',
        projectedAmount,
        matchedPolicyId: policy.id ?? null,
      };
    if (policy.behavior === 'warn')
      return {
        allowed: true,
        approvalRequired: false,
        state: 'warned',
        projectedAmount,
        matchedPolicyId: policy.id ?? null,
      };
    if (policy.behavior === 'approval_required')
      return {
        allowed: false,
        approvalRequired: true,
        state: 'approval_required',
        projectedAmount,
        matchedPolicyId: policy.id ?? null,
      };
    return {
      allowed: false,
      approvalRequired: false,
      state: 'blocked',
      projectedAmount,
      matchedPolicyId: policy.id ?? null,
    };
  }
}

function selectRule(
  rules: PricingRule[],
  at: Date,
  serviceKey: string,
): PricingRule | undefined {
  return rules
    .filter(
      (rule) =>
        rule.effectiveFrom <= at &&
        (!rule.effectiveTo || rule.effectiveTo > at) &&
        (!rule.serviceKey || rule.serviceKey === serviceKey),
    )
    .sort(
      (a, b) =>
        Number(Boolean(b.serviceKey)) - Number(Boolean(a.serviceKey)) ||
        b.priority - a.priority ||
        b.effectiveFrom.getTime() - a.effectiveFrom.getTime(),
    )[0];
}
function priceTiers(quantity: number, tiers: unknown[]): number {
  let remaining = quantity,
    prior = 0,
    amount = 0;
  for (const raw of tiers as Array<Record<string, unknown>>) {
    const upTo = raw.upTo == null ? Infinity : Number(raw.upTo);
    const units = Math.max(0, Math.min(remaining, upTo - prior));
    amount += units * Number(raw.unitPrice ?? 0);
    remaining -= units;
    prior = upTo;
    if (remaining <= 0) break;
  }
  return amount;
}
function selectPolicy(
  policies: SpendingPolicy[],
  input: Record<string, unknown>,
): SpendingPolicy | undefined {
  return policies
    .filter(
      (p) =>
        (!p.metricKey || p.metricKey === input.metricKey) &&
        (!p.projectId || p.projectId === input.projectId) &&
        (!p.serviceKey || p.serviceKey === input.serviceKey) &&
        (!p.subscriberKind ||
          (p.subscriberKind === (input.subscriberKind ?? 'tenant') &&
            (!p.subscriberExternalId ||
              p.subscriberExternalId === input.subscriberExternalId))),
    )
    .sort(
      (a, b) => scopeScore(b) - scopeScore(a) || b.priority - a.priority,
    )[0];
}
function scopeScore(p: SpendingPolicy): number {
  return (
    Number(Boolean(p.subscriberKind)) +
    Number(Boolean(p.projectId)) +
    Number(Boolean(p.serviceKey)) +
    Number(Boolean(p.metricKey))
  );
}
function matchesChargeScope(p: SpendingPolicy, c: ClientCharge): boolean {
  return (
    (!p.projectId || p.projectId === c.projectId) &&
    (!p.serviceKey || p.serviceKey === c.serviceKey) &&
    (!p.metricKey || p.metricKey === c.metricKey) &&
    (!p.subscriberKind ||
      (p.subscriberKind === c.subscriberKind &&
        (!p.subscriberExternalId ||
          p.subscriberExternalId === c.subscriberExternalId)))
  );
}
function policyWindow(policy: SpendingPolicy, at: Date): [Date, Date] {
  const end = new Date(at);
  const start = new Date(at);
  if (policy.period === 'rolling')
    start.setTime(at.getTime() - policy.rollingSeconds * 1000);
  else if (policy.period === 'day') start.setUTCHours(0, 0, 0, 0);
  else if (policy.period === 'week') {
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  } else if (policy.period === 'month') {
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);
  } else {
    start.setUTCMonth(0, 1);
    start.setUTCHours(0, 0, 0, 0);
  }
  return [start, end];
}
