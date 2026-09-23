/**
 * Reseller billing records (#3059): price books, their per-relationship
 * assignment, the reseller's retail ledger, and prepaid credit grants.
 *
 * Money is integer minor units throughout, exactly as in `commercial.ts`.
 */
import {
  crossPackageRef,
  field,
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
import { tenantKey } from '../utils.js';

/**
 * `wholesale` books price what a service provider charges a reseller for its
 * children's usage; `retail` books price what a reseller charges its children.
 */
export type PriceBookKind = 'wholesale' | 'retail';

const PRICE_BOOK_KINDS: readonly PriceBookKind[] = ['wholesale', 'retail'];
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export function isPriceBookKind(value: unknown): value is PriceBookKind {
  return PRICE_BOOK_KINDS.includes(value as PriceBookKind);
}

/** ISO 4217-shaped (three upper-case letters) currency code check. */
export function isCurrencyCode(value: unknown): value is string {
  return typeof value === 'string' && CURRENCY_PATTERN.test(value);
}

/**
 * A named set of prices published by one seller tenant. Its prices are
 * ordinary {@link PricingRule} rows that carry this book's id and the same
 * tenant; one rule per currency gives a price in several currencies.
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: '_smrt_price_books',
  conflictColumns: ['tenant_id', 'book_key'],
  api: false,
  cli: false,
  mcp: false,
})
export class PriceBook extends SmrtObject {
  /** The seller that publishes and owns the book. */
  @tenantId() tenantId?: string;
  bookKey: string = '';
  name: string = '';
  kind: PriceBookKind = 'retail';
  active: boolean = true;

  protected async validateBeforeSave(): Promise<void> {
    await super.validateBeforeSave();
    if (!this.bookKey.trim()) {
      throw new Error('Price books require a bookKey.');
    }
    if (!isPriceBookKind(this.kind)) {
      throw new Error('Price book kind must be wholesale or retail.');
    }
  }
}

/**
 * Which price books rate one child tenant's usage, keyed like the tenancy
 * billing relationship it belongs to (one row per child). The reseller is
 * recorded so an assignment made under one relationship never prices usage
 * after the child moves to a different reseller.
 *
 * A system table managed through `ResellerBillingService`, like
 * `_smrt_billing_relationships`; it has no generated API surface.
 */
@smrt({
  tableName: '_smrt_price_book_assignments',
  conflictColumns: ['child_tenant_id'],
  api: false,
  cli: false,
  mcp: false,
})
export class PriceBookAssignment extends SmrtObject {
  @crossPackageRef('@happyvertical/smrt-users:Tenant')
  @field({ required: true })
  childTenantId: string = '';
  @crossPackageRef('@happyvertical/smrt-users:Tenant')
  @field({ required: true })
  resellerTenantId: string = '';
  @foreignKey('PriceBook')
  wholesalePriceBookId: string = '';
  wholesaleCurrency: string = '';
  @foreignKey('PriceBook')
  retailPriceBookId: string = '';
  retailCurrency: string = '';
}

/**
 * What a reseller charges one child for one usage event, priced from the
 * reseller's retail book. The provider's charge for the same event is the
 * {@link ClientCharge} in `clientChargeId`, payable by the billing owner.
 *
 * `tenantId` is always the payer (the child), so tenant-scoped reads and the
 * child's `retail`-basis spending policies see exactly what it owes.
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: '_smrt_retail_charges',
  api: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  conflictColumns: ['usage_event_id'],
})
export class RetailCharge extends SmrtObject {
  @tenantId() tenantId?: string;
  @crossPackageRef('@happyvertical/smrt-users:Tenant')
  resellerTenantId: string = '';
  @foreignKey('TenantUsageMetric')
  usageEventId: string = '';
  @foreignKey('ClientCharge')
  clientChargeId: string = '';
  subscriberKind: string = 'tenant';
  subscriberExternalId: string = '';
  projectId: string = '';
  workRefType: string = '';
  workRefId: string = '';
  provider: string = '';
  serviceKey: string = '';
  metricKey: string = '';
  /** Metered quantity; fractional, like `ClientCharge.quantity`. */
  quantity: number = 0.0;
  /** Charge in integer minor units of {@link currency}. */
  amount: number = 0;
  currency: string = 'USD';
  @foreignKey('PriceBook')
  priceBookId: string = '';
  @foreignKey('PricingRule')
  pricingRuleId: string = '';
  pricingSnapshot: string = '{}';
  status: 'draft' | 'approved' = 'draft';
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
    if (row?.status !== 'approved') return;
    const persisted = [
      row.tenant_id,
      row.reseller_tenant_id,
      row.usage_event_id,
      row.client_charge_id,
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
      row.price_book_id,
      row.pricing_rule_id,
      row.pricing_snapshot,
      row.status,
      row.approved_at,
    ];
    const current = [
      this.tenantId,
      this.resellerTenantId,
      this.usageEventId,
      this.clientChargeId,
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
      this.priceBookId,
      this.pricingRuleId,
      this.pricingSnapshot,
      this.status,
      this.approvedAt,
    ];
    if (
      persisted.some(
        (value, index) =>
          normalizeLedgerValue(value) !== normalizeLedgerValue(current[index]),
      )
    ) {
      throw new Error('Approved retail charges are immutable.');
    }
  }
}

/**
 * An append-only credit on a prepaid (`period: 'balance'`) spending policy.
 * Positive amounts add credit; a negative amount reverses an earlier grant.
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: '_smrt_credit_grants',
  api: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
})
export class CreditGrant extends SmrtObject {
  /** The tenant whose balance is credited (the policy's tenant). */
  @tenantId() tenantId?: string;
  @foreignKey('SpendingPolicy')
  spendingPolicyId: string = '';
  /** Signed credit in integer minor units of {@link currency}. */
  amount: number = 0;
  currency: string = 'USD';
  reason: string = '';
  source: string = '';
  sourceId: string = '';
  /** A parent tenant that granted the credit, or empty when self-granted. */
  @crossPackageRef('@happyvertical/smrt-users:Tenant')
  grantedByTenantId: string = '';

  protected async validateBeforeSave(): Promise<void> {
    await super.validateBeforeSave();
    if (!Number.isSafeInteger(this.amount) || this.amount === 0) {
      throw new Error(
        'Credit grant amounts must be nonzero integer minor units (cents).',
      );
    }
    if (this.id) {
      const row = await this.db.get(this.tableName, { id: this.id });
      if (row) {
        throw new Error(
          'Credit grants are append-only; record a reversing grant instead.',
        );
      }
    }
    const policy = this.spendingPolicyId
      ? ((await this.db.get('_smrt_spending_policies', {
          id: this.spendingPolicyId,
        })) as Record<string, unknown> | null)
      : null;
    if (
      policy?.period !== 'balance' ||
      tenantKey(policy.tenant_id as string) !== tenantKey(this.tenantId) ||
      policy.currency !== this.currency
    ) {
      throw new Error(
        'Credit grants must credit a balance policy of the same tenant and currency.',
      );
    }
    // A parent's delegated balance is funded only by that parent.
    const setBy = tenantKey(policy.set_by_tenant_id as string);
    if (!setBy) return;
    if (tenantKey(this.grantedByTenantId) !== setBy) {
      throw new TenantIsolationError(
        'Delegated balance credit must be granted by the parent that set it.',
      );
    }
    if (
      !isSystemContext() &&
      !isSuperAdminBypass() &&
      tenantKey(getTenantId()) !== setBy
    ) {
      throw new TenantIsolationError(
        'Only the parent that set a delegated policy can grant it credit.',
      );
    }
  }
}

export class PriceBookCollection extends SmrtCollection<PriceBook> {
  static readonly _itemClass = PriceBook;
}
export class PriceBookAssignmentCollection extends SmrtCollection<PriceBookAssignment> {
  static readonly _itemClass = PriceBookAssignment;
}
export class RetailChargeCollection extends SmrtCollection<RetailCharge> {
  static readonly _itemClass = RetailCharge;
}
export class CreditGrantCollection extends SmrtCollection<CreditGrant> {
  static readonly _itemClass = CreditGrant;
}

function normalizeLedgerValue(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}[T ]/.test(value)) {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
  }
  if (typeof value === 'boolean') return value ? '1' : '0';
  return String(value ?? '');
}
