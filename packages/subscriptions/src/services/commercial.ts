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
import type { RecordUsageOptions, SubscriberKind } from '../types.js';
import {
  deterministicUuid,
  normalizeSubscriber,
  subscriberToColumns,
} from '../utils.js';

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
    const usage = await TenantUsageMetricCollection.create(options);
    const sharedOptions = { ...options, db: usage.db };
    return new CommercialUsageService(
      usage,
      await PricingRuleCollection.create(sharedOptions),
      await ClientChargeCollection.create(sharedOptions),
      await BillingAdjustmentCollection.create(sharedOptions),
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
    if (existing[0]) {
      return this.approveCharge(existing[0], options.approved);
    }
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
    const chargeId = await deterministicUuid([
      'client-charge',
      String(usage.tenantId),
      String(usage.id),
    ]);
    try {
      return await this.charges.create({
        id: chargeId,
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
        _insertOnly: true,
      });
    } catch (error) {
      const concurrent = await this.charges.get(chargeId);
      if (!concurrent) throw error;
      return this.approveCharge(concurrent, options.approved);
    }
  }

  private async approveCharge(
    charge: ClientCharge,
    approved = false,
  ): Promise<ClientCharge> {
    if (approved && charge.status === 'draft') {
      charge.status = 'approved';
      charge.approvedAt = new Date();
      await charge.save();
    }
    return charge;
  }

  /**
   * Append a signed correction to an approved charge.
   *
   * @param amount - Signed correction in **integer minor units**, same unit as
   *   the charge (#2401). Negative is legitimate — that is a credit. A
   *   fractional value is rejected rather than silently rounded, because it
   *   almost always means the caller passed major units.
   */
  async adjust(
    chargeId: string,
    amount: number,
    reason: string,
    source = '',
    sourceId = '',
  ) {
    if (!Number.isInteger(amount)) {
      throw new Error(
        `Billing adjustment amount must be an integer number of minor units ` +
          `(cents) — got ${amount}. Money is exact: -$0.25 is -25, not -0.25.`,
      );
    }
    const charge = await this.charges.get(chargeId);
    if (!charge) throw new Error(`Client charge ${chargeId} was not found.`);
    if (charge.status !== 'approved' && charge.status !== 'adjusted') {
      throw new Error(
        `Client charge ${chargeId} must be approved before it can be adjusted.`,
      );
    }
    const sourcedId =
      source && sourceId
        ? await deterministicUuid([
            'billing-adjustment',
            String(charge.tenantId),
            chargeId,
            source,
            sourceId,
          ])
        : null;
    let adjustment = sourcedId
      ? await this.adjustments.get(sourcedId)
      : undefined;
    if (!adjustment) {
      try {
        adjustment = await this.adjustments.create({
          ...(sourcedId ? { id: sourcedId } : {}),
          tenantId: charge.tenantId,
          clientChargeId: chargeId,
          amount,
          currency: charge.currency,
          reason,
          source,
          sourceId,
          _insertOnly: Boolean(sourcedId),
        });
      } catch (error) {
        if (sourcedId) adjustment = await this.adjustments.get(sourcedId);
        if (!adjustment) throw error;
      }
    }
    if (charge.status === 'approved') {
      charge.status = 'adjusted';
      try {
        await charge.save();
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !('code' in error) ||
          error.code !== 'RUNTIME_REVISION_CONFLICT'
        )
          throw error;
        const current = await this.charges.get(chargeId);
        if (current?.status !== 'adjusted') throw error;
      }
    }
    return adjustment;
  }

  /**
   * Price one usage event, in **integer minor units** (#2401).
   *
   * The pricing terms stay fractional on purpose — a per-token rate is
   * routinely a fraction of a cent, and an integer `unitPrice` would truncate
   * it to zero — so terms are read as *minor units per unit of usage* and only
   * the result is rounded. This is the single boundary in the package where a
   * rate meets money, which is what lets `evaluateSpending()` compare sums
   * against `SpendingPolicy.limitAmount` exactly.
   *
   * Replaces the old micro-unit rounding (`Math.round(amount * 1e6) / 1e6`),
   * which kept six sub-cent digits in a column that is now integral.
   */
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
    return Math.round(amount);
  }
}

export interface SpendingDecision {
  allowed: boolean;
  approvalRequired: boolean;
  state: 'ok' | 'observed' | 'warned' | 'blocked' | 'approval_required';
  /**
   * Already-spent plus estimated, in **integer minor units** — the same unit as
   * `SpendingPolicy.limitAmount` it is compared against (#2401).
   */
  projectedAmount: number;
  matchedPolicyId: string | null;
}

interface SpendingEvaluationInput {
  tenantId: string;
  subscriberKind?: SubscriberKind;
  subscriberExternalId?: string;
  projectId?: string;
  serviceKey?: string;
  metricKey: string;
  /** Estimated cost of the pending call, in integer minor units (#2401). */
  estimatedAmount: number;
  currency: string;
  at?: Date;
}

export class SpendingPolicyEvaluator {
  constructor(
    private readonly policies: SpendingPolicyCollection,
    private readonly charges: ClientChargeCollection,
    private readonly adjustments: BillingAdjustmentCollection,
  ) {}
  static async create(options: SmrtClassOptions = {}) {
    const policies = await SpendingPolicyCollection.create(options);
    const sharedOptions = { ...options, db: policies.db };
    return new SpendingPolicyEvaluator(
      policies,
      await ClientChargeCollection.create(sharedOptions),
      await BillingAdjustmentCollection.create(sharedOptions),
    );
  }

  async evaluate(input: SpendingEvaluationInput): Promise<SpendingDecision> {
    const at = input.at ?? new Date();
    const normalizedInput = {
      ...input,
      ...subscriberToColumns(
        normalizeSubscriber({
          tenantId: input.tenantId,
          subscriberKind: input.subscriberKind,
          subscriberExternalId: input.subscriberExternalId,
        }),
      ),
    };
    const candidates = await this.policies.list({
      where: {
        tenantId: input.tenantId,
        currency: input.currency,
        active: true,
      },
    });
    const matchingPolicies = selectPolicies(candidates, normalizedInput);
    if (matchingPolicies.length === 0)
      return {
        allowed: true,
        approvalRequired: false,
        state: 'ok',
        projectedAmount: input.estimatedAmount,
        matchedPolicyId: null,
      };
    const decisions = await Promise.all(
      matchingPolicies.map((policy) =>
        this.evaluatePolicy(policy, normalizedInput, at),
      ),
    );
    return decisions.reduce((mostRestrictive, decision) =>
      decisionRank(decision) > decisionRank(mostRestrictive)
        ? decision
        : mostRestrictive,
    );
  }

  private async evaluatePolicy(
    policy: SpendingPolicy,
    input: SpendingEvaluationInput,
    at: Date,
  ): Promise<SpendingDecision> {
    const [start, end] = policyWindow(policy, at);
    const chargeWhere: Record<string, unknown> = {
      tenantId: input.tenantId,
      currency: policy.currency,
      status: ['approved', 'adjusted'],
      'approvedAt >=': start.toISOString(),
      'approvedAt <': end.toISOString(),
    };
    if (policy.metricKey) chargeWhere.metricKey = policy.metricKey;
    if (policy.projectId) chargeWhere.projectId = policy.projectId;
    if (policy.serviceKey) chargeWhere.serviceKey = policy.serviceKey;
    if (policy.subscriberKind)
      chargeWhere.subscriberKind = policy.subscriberKind;
    if (policy.subscriberExternalId)
      chargeWhere.subscriberExternalId = policy.subscriberExternalId;
    const rows = await this.charges.list({ where: chargeWhere });
    const scopedCharges = rows.filter(
      (charge) =>
        (charge.status === 'approved' || charge.status === 'adjusted') &&
        matchesChargeScope(policy, charge),
    );
    const chargeIds = scopedCharges
      .map((charge) => charge.id)
      .filter((id): id is string => Boolean(id));
    const chargeIdSet = new Set(chargeIds);
    const adjustmentRows =
      chargeIds.length > 0
        ? await this.adjustments.list({
            where: {
              tenantId: input.tenantId,
              currency: policy.currency,
              clientChargeId: chargeIds,
            },
          })
        : [];
    const spent = scopedCharges.reduce((sum, charge) => sum + charge.amount, 0);
    const correctedSpent =
      spent +
      adjustmentRows
        .filter((adjustment) => chargeIdSet.has(adjustment.clientChargeId))
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
function selectPolicies(
  policies: SpendingPolicy[],
  input: Record<string, unknown>,
): SpendingPolicy[] {
  return policies
    .filter(
      (p) =>
        hasValidSubscriberScope(p) &&
        (!p.metricKey || p.metricKey === input.metricKey) &&
        p.currency === input.currency &&
        (!p.projectId || p.projectId === input.projectId) &&
        (!p.serviceKey || p.serviceKey === input.serviceKey) &&
        (!p.subscriberKind ||
          (p.subscriberKind === (input.subscriberKind ?? 'tenant') &&
            (!p.subscriberExternalId ||
              p.subscriberExternalId === input.subscriberExternalId))),
    )
    .sort((a, b) => scopeScore(b) - scopeScore(a) || b.priority - a.priority);
}

function decisionRank(decision: SpendingDecision): number {
  return {
    ok: 0,
    observed: 1,
    warned: 2,
    approval_required: 3,
    blocked: 4,
  }[decision.state];
}
function scopeScore(p: SpendingPolicy): number {
  return (
    Number(Boolean(p.subscriberKind)) +
    Number(Boolean(p.subscriberExternalId)) +
    Number(Boolean(p.projectId)) +
    Number(Boolean(p.serviceKey)) +
    Number(Boolean(p.metricKey))
  );
}
function matchesChargeScope(p: SpendingPolicy, c: ClientCharge): boolean {
  return (
    hasValidSubscriberScope(p) &&
    (!p.projectId || p.projectId === c.projectId) &&
    (!p.serviceKey || p.serviceKey === c.serviceKey) &&
    (!p.metricKey || p.metricKey === c.metricKey) &&
    (!p.subscriberKind ||
      (p.subscriberKind === c.subscriberKind &&
        (!p.subscriberExternalId ||
          p.subscriberExternalId === c.subscriberExternalId)))
  );
}
function hasValidSubscriberScope(p: SpendingPolicy): boolean {
  return !p.subscriberExternalId || Boolean(p.subscriberKind);
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
