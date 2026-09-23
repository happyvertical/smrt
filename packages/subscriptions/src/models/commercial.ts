import {
  crossPackageRef,
  foreignKey,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import {
  getTenantId,
  isSuperAdminBypass,
  isSystemContext,
  TenantIsolationError,
  TenantScoped,
  tenantId,
} from '@happyvertical/smrt-tenancy';

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
/**
 * `balance` is a prepaid credit balance: the policy's limit is the sum of its
 * {@link CreditGrant}s and spend accumulates from `balanceFrom` onward.
 */
export type SpendingPeriod =
  | 'day'
  | 'week'
  | 'month'
  | 'year'
  | 'rolling'
  | 'balance';
/**
 * Which charges a spending policy counts (#3059).
 *
 * - `billed`: provider charges payable by the policy tenant (`ClientCharge`
 *   rows whose `tenantId` is the tenant) — the pre-#3059 behavior.
 * - `retail`: what the tenant owes its reseller (`RetailCharge` rows).
 * - `wholesale`: what the policy's parent (`setByTenantId`) pays the provider
 *   for this tenant's usage (`ClientCharge` rows billed to the parent with
 *   `usageTenantId` = the tenant). Requires a delegated policy.
 */
export type SpendingBasis = 'billed' | 'retail' | 'wholesale';

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
  /**
   * The price book this rule belongs to (#3059), or empty for a tenant's
   * direct pricing. Book rules are priced only through
   * `CommercialUsageService.rateUsage()`; `price()` ignores them.
   */
  @foreignKey('PriceBook')
  priceBookId: string = '';

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
  /** The payer: the usage tenant, or its billing owner when parent-billed. */
  @tenantId() tenantId?: string;
  @foreignKey('TenantUsageMetric')
  usageEventId: string = '';
  /** The tenant whose usage was charged; differs from `tenantId` for wholesale. */
  @crossPackageRef('@happyvertical/smrt-users:Tenant')
  usageTenantId: string = '';
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
  /** Wholesale book that priced this charge, or empty for direct pricing. */
  @foreignKey('PriceBook')
  priceBookId: string = '';
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
    const row = await this.getCanonicalPersistedRow({ id: this.id });
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
      row.usage_tenant_id,
      row.price_book_id,
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
      this.usageTenantId,
      this.priceBookId,
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
  hooks: { beforeDelete: 'assertDelegationAuthority' },
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
   * Must be zero for a `balance` policy, whose limit is its credit grants.
   */
  limitAmount: number = 0;
  currency: string = 'USD';
  behavior: SpendingPolicyBehavior = 'observe';
  priority: number = 0;
  active: boolean = true;
  /** Which charges count toward the policy; see {@link SpendingBasis}. */
  basis: SpendingBasis = 'billed';
  /**
   * The parent tenant that set this policy on its child (#3059), or empty for
   * a tenant's own policy. A delegated policy can be changed or deleted only
   * by that parent, a system context, or a super-admin bypass.
   */
  @crossPackageRef('@happyvertical/smrt-users:Tenant')
  setByTenantId: string = '';
  /** Start of the spend window for a `balance` policy; defaults to creation. */
  balanceFrom: Date | null = null;

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
    if (
      this.basis !== 'billed' &&
      this.basis !== 'retail' &&
      this.basis !== 'wholesale'
    ) {
      throw new Error(
        'Spending policy basis must be billed, retail, or wholesale.',
      );
    }
    if (this.basis === 'wholesale' && !this.setByTenantId) {
      throw new Error(
        'Wholesale spending policies must be delegated by a parent (setByTenantId).',
      );
    }
    if (this.period === 'balance') {
      if (this.limitAmount !== 0) {
        throw new Error(
          'Balance spending policies take their limit from credit grants; limitAmount must be 0.',
        );
      }
      if (!this.balanceFrom) this.balanceFrom = new Date();
    }
    const targets = await this.persistedTargets();
    await this.assertBalanceLedgerStable(targets);
    await this.assertDelegationAuthority(targets);
  }

  /**
   * A balance policy's credit grants are scoped to its currency and period;
   * changing either would silently detach the ledger, so create a new
   * balance instead.
   */
  protected async assertBalanceLedgerStable(
    rows: Array<Record<string, unknown> | null>,
  ): Promise<void> {
    for (const row of rows) {
      if (row?.period !== 'balance') continue;
      if (this.period !== 'balance' || row.currency !== this.currency) {
        throw new Error(
          'A balance policy cannot change currency or period; create a new balance policy.',
        );
      }
    }
  }

  /**
   * The rows this save can overwrite: by id and, because a new object may
   * already carry a generated id, by conflict key (an upsert target).
   */
  protected async persistedTargets(): Promise<
    Array<Record<string, unknown> | null>
  > {
    const byId = this.id
      ? await this.getCanonicalPersistedRow({ id: this.id })
      : null;
    const byKey = this.tenantId
      ? await this.getCanonicalPersistedRow({
          tenant_id: this.tenantId,
          subscriber_kind: this.subscriberKind,
          subscriber_external_id: this.subscriberExternalId,
          project_id: this.projectId,
          service_key: this.serviceKey,
          metric_key: this.metricKey,
          period: this.period,
          name: this.name,
        })
      : null;
    return [byId, byKey];
  }

  /**
   * A delegated policy belongs to the parent that set it: the constrained
   * child cannot create one in a parent's name, loosen it, or delete it.
   * The parent's-own-context allowance applies only where no tenancy
   * interceptor is registered; with one, the interceptor refuses a parent
   * writing the child's row, so parents change delegated policies through
   * `ResellerBillingService.setDelegatedSpendingPolicy()` (set
   * `active: false` to retire one).
   * Checks both the persisted row (by id, or by conflict key for an upsert)
   * and the incoming value.
   */
  protected async assertDelegationAuthority(
    targets?: Array<Record<string, unknown> | null>,
  ): Promise<void> {
    const [byId, byKey] = targets ?? (await this.persistedTargets());
    const owners = new Set(
      [byId?.set_by_tenant_id, byKey?.set_by_tenant_id, this.setByTenantId]
        .filter((value): value is string => Boolean(value))
        .map((value) => String(value).toLowerCase()),
    );
    if (owners.size === 0) return;
    if (isSystemContext() || isSuperAdminBypass()) return;
    const current = getTenantId()?.toLowerCase();
    if (owners.size === 1 && current && owners.has(current)) return;
    throw new TenantIsolationError(
      'Delegated spending policies can be changed only by the parent that set them.',
    );
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
