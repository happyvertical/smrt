import {
  foreignKey,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

export type PricingStrategy =
  | 'fixed_unit'
  | 'cost_plus'
  | 'multiplier'
  | 'tiered'
  | 'included_overage'
  | 'flat'
  | 'custom';
export type SpendingPolicyBehavior =
  | 'observe'
  | 'warn'
  | 'block'
  | 'approval_required';
export type SpendingPeriod = 'day' | 'week' | 'month' | 'year' | 'rolling';

@TenantScoped({ mode: 'required' })
@smrt({
  tableName: '_smrt_pricing_rules',
  api: true,
  cli: true,
  mcp: true,
})
export class PricingRule extends SmrtObject {
  @tenantId() tenantId?: string;
  ruleKey: string = '';
  metricKey: string = '';
  serviceKey: string = '';
  strategy: PricingStrategy = 'fixed_unit';
  currency: string = 'USD';
  effectiveFrom: Date = new Date();
  effectiveTo: Date | null = null;
  priority: number = 0;
  terms: string = '{}';
  active: boolean = true;

  getTerms(): Record<string, unknown> {
    try {
      return JSON.parse(this.terms) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  setTerms(value: Record<string, unknown>): void {
    this.terms = JSON.stringify(value);
  }
}

@TenantScoped({ mode: 'required' })
@smrt({
  tableName: '_smrt_client_charges',
  api: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  conflictColumns: ['usage_event_id'],
})
export class ClientCharge extends SmrtObject {
  @tenantId() tenantId?: string;
  @foreignKey('TenantUsageMetric')
  usageEventId: string = '';
  subscriberKind: string = 'tenant';
  subscriberExternalId: string = '';
  projectId: string = '';
  workRefType: string = '';
  workRefId: string = '';
  provider: string = '';
  serviceKey: string = '';
  metricKey: string = '';
  /**
   * Metered quantity — genuinely fractional (`duration.seconds`, token counts
   * scaled by a rate), so it stays DECIMAL.
   */
  quantity: number = 0.0;
  /**
   * Charge in **integer minor units** of {@link currency} (#2401).
   *
   * Summed against {@link BillingAdjustment.amount} and compared against
   * {@link SpendingPolicy.limitAmount}, so all three carry the same unit —
   * `CommercialService.calculateAmount()` rounds to a whole minor unit at the
   * one boundary where the fractional pricing terms meet money.
   */
  amount: number = 0;
  currency: string = 'USD';
  @foreignKey('PricingRule')
  pricingRuleId: string = '';
  pricingSnapshot: string = '{}';
  status: 'draft' | 'approved' | 'adjusted' = 'draft';
  approvedAt: Date | null = null;

  getPricingSnapshot(): Record<string, unknown> {
    try {
      return JSON.parse(this.pricingSnapshot) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  protected async validateBeforeSave(): Promise<void> {
    await super.validateBeforeSave();
    if (!this.id) return;
    const persistedRow = await this.db.get(this.tableName, { id: this.id });
    const row = persistedRow
      ? await this.canonicalizePersistedUuidRow(persistedRow)
      : null;
    if (!row || (row.status !== 'approved' && row.status !== 'adjusted'))
      return;
    if (
      (row.status === 'approved' &&
        this.status !== 'approved' &&
        this.status !== 'adjusted') ||
      (row.status === 'adjusted' && this.status !== 'adjusted')
    ) {
      throw new Error(
        'Approved client charges cannot be reverted to an editable status.',
      );
    }
    const persisted = [
      row.tenant_id,
      row.usage_event_id,
      row.subscriber_kind,
      row.subscriber_external_id,
      row.project_id,
      row.work_ref_type,
      row.work_ref_id,
      row.provider,
      row.service_key,
      row.metric_key,
      row.quantity,
      row.amount,
      row.currency,
      row.pricing_rule_id,
      row.pricing_snapshot,
      row.approved_at,
    ];
    const current = [
      this.tenantId,
      this.usageEventId,
      this.subscriberKind,
      this.subscriberExternalId,
      this.projectId,
      this.workRefType,
      this.workRefId,
      this.provider,
      this.serviceKey,
      this.metricKey,
      this.quantity,
      this.amount,
      this.currency,
      this.pricingRuleId,
      this.pricingSnapshot,
      this.approvedAt,
    ];
    if (
      persisted.some(
        (value, index) =>
          normalizeSnapshot(value) !== normalizeSnapshot(current[index]),
      )
    ) {
      throw new Error(
        'Approved client charges are immutable; append a BillingAdjustment instead.',
      );
    }
  }
}

@TenantScoped({ mode: 'required' })
@smrt({
  tableName: '_smrt_billing_adjustments',
  api: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
})
export class BillingAdjustment extends SmrtObject {
  @tenantId() tenantId?: string;
  @foreignKey('ClientCharge')
  clientChargeId: string = '';
  /**
   * Signed correction in **integer minor units**, same unit as
   * {@link ClientCharge.amount} it adjusts. Negative values are legitimate
   * (a credit) — that is why the non-negative guard in
   * `CommercialService.calculateAmount()` does not apply here (#2401).
   */
  amount: number = 0;
  currency: string = 'USD';
  reason: string = '';
  source: string = '';
  sourceId: string = '';
  createdBy: string = '';

  protected async validateBeforeSave(): Promise<void> {
    await super.validateBeforeSave();
    if (!this.id) return;
    const row = await this.db.get(this.tableName, { id: this.id });
    if (row) {
      throw new Error(
        'Billing adjustments are append-only; create a new adjustment instead.',
      );
    }
  }
}

@TenantScoped({ mode: 'required' })
@smrt({
  tableName: '_smrt_spending_policies',
  conflictColumns: [
    'tenant_id',
    'subscriber_kind',
    'subscriber_external_id',
    'project_id',
    'service_key',
    'metric_key',
    'period',
    'name',
  ],
  api: true,
  cli: true,
  mcp: true,
})
export class SpendingPolicy extends SmrtObject {
  @tenantId() tenantId?: string;
  name: string = '';
  subscriberKind: string = '';
  subscriberExternalId: string = '';
  projectId: string = '';
  serviceKey: string = '';
  metricKey: string = '';
  period: SpendingPeriod = 'month';
  rollingSeconds: number = 0;
  /**
   * Spending cap in **integer minor units** of {@link currency}. Compared
   * directly against the sum of `ClientCharge.amount` + `BillingAdjustment`s
   * plus the caller's estimate, so it must carry the same unit (#2401).
   */
  limitAmount: number = 0;
  currency: string = 'USD';
  behavior: SpendingPolicyBehavior = 'observe';
  priority: number = 0;
  active: boolean = true;

  protected async validateBeforeSave(): Promise<void> {
    await super.validateBeforeSave();
    if (this.subscriberExternalId && !this.subscriberKind) {
      throw new Error(
        'Spending policies with subscriberExternalId require subscriberKind.',
      );
    }
    if (
      this.period === 'rolling' &&
      (!Number.isFinite(this.rollingSeconds) || this.rollingSeconds <= 0)
    ) {
      throw new Error(
        'Rolling spending policies require rollingSeconds greater than zero.',
      );
    }
  }
}

export class PricingRuleCollection extends SmrtCollection<PricingRule> {
  static readonly _itemClass = PricingRule;
}
export class ClientChargeCollection extends SmrtCollection<ClientCharge> {
  static readonly _itemClass = ClientCharge;
}
export class BillingAdjustmentCollection extends SmrtCollection<BillingAdjustment> {
  static readonly _itemClass = BillingAdjustment;
}
export class SpendingPolicyCollection extends SmrtCollection<SpendingPolicy> {
  static readonly _itemClass = SpendingPolicy;
}

function normalizeSnapshot(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}[T ]/.test(value)) {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
  }
  return String(value ?? '');
}
