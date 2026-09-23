/**
 * Billing-period close records (#3060).
 *
 * These are system tables managed by `BillingRuntime`, like smrt-tenancy's
 * `_smrt_billing_relationships`: they span a seller and its payers, so they
 * are not tenant-scoped and have no generated API, CLI, or MCP surface.
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
  backgroundEligible,
  type JobExecutionContext,
} from '@happyvertical/smrt-jobs';
import { canonicalTenantId, normalizeCurrency } from '../billing/units.js';

/**
 * Who a runtime bills. `provider` closes the platform's `ClientCharge`s,
 * their `BillingAdjustment`s, and the platform's flat plans; `reseller`
 * closes the `RetailCharge`s a reseller's children owe it and the reseller's
 * own flat plans.
 */
export type BillingCloseKind = 'provider' | 'reseller';

/** A payer's standing with its seller, driven by provider invoice events. */
export type BillingStanding = 'current' | 'past_due' | 'uncollectible';

/**
 * `collecting` → `invoiced` → `pushed` → `sent` → `completed`. Every step is
 * resumable: a retry continues from the persisted status.
 */
export type BillingPeriodCloseStatus =
  | 'collecting'
  | 'invoiced'
  | 'pushed'
  | 'sent'
  | 'completed';

export type BillingLineSourceType =
  | 'client_charge'
  | 'billing_adjustment'
  | 'retail_charge'
  | 'subscription_period';

const STANDINGS: readonly BillingStanding[] = [
  'current',
  'past_due',
  'uncollectible',
];

/**
 * One payer's account with one seller: the commerce `Customer` invoices are
 * issued to, the provider customer they are pushed to, and the payer's
 * billing terms. The seller's tax location for the payer is the customer's
 * `defaultBillingAddress`.
 */
@smrt({
  tableName: '_smrt_billing_accounts',
  conflictColumns: ['seller_tenant_id', 'payer_tenant_id'],
  api: false,
  cli: false,
  mcp: false,
})
export class BillingAccount extends SmrtObject {
  /** The tenant that issues invoices (the provider or a reseller). */
  @crossPackageRef('@happyvertical/smrt-users:Tenant')
  @field({ required: true })
  sellerTenantId: string = '';
  /** The billing owner that pays them. */
  @crossPackageRef('@happyvertical/smrt-users:Tenant')
  @field({ required: true })
  payerTenantId: string = '';
  @foreignKey('Customer')
  customerId: string = '';
  /** Display name sent to the provider customer. */
  name: string = '';
  email: string = '';
  /** Provider name (`stripe`) once a provider customer exists. */
  provider: string = '';
  providerCustomerId: string = '';
  /** Let the provider calculate tax from the customer's tax location. */
  automaticTax: boolean = true;
  /** Discount on flat plan lines, in basis points (10000 = 100%). */
  flatDiscountBasisPoints: number = 0;
  paymentTermsDays: number = 30;
  standing: BillingStanding = 'current';

  protected async validateBeforeSave(): Promise<void> {
    await super.validateBeforeSave();
    this.sellerTenantId = canonicalTenantId(
      this.sellerTenantId,
      'sellerTenantId',
    );
    this.payerTenantId = canonicalTenantId(this.payerTenantId, 'payerTenantId');
    if (this.sellerTenantId === this.payerTenantId) {
      throw new Error('A tenant cannot bill itself.');
    }
    if (!this.customerId) {
      throw new Error('Billing accounts require a customerId.');
    }
    if (
      !Number.isSafeInteger(this.flatDiscountBasisPoints) ||
      this.flatDiscountBasisPoints < 0 ||
      this.flatDiscountBasisPoints > 10_000
    ) {
      throw new Error(
        'flatDiscountBasisPoints must be an integer from 0 to 10000.',
      );
    }
    if (
      !Number.isSafeInteger(this.paymentTermsDays) ||
      this.paymentTermsDays < 0 ||
      this.paymentTermsDays > 365
    ) {
      throw new Error('paymentTermsDays must be an integer from 0 to 365.');
    }
    if (!STANDINGS.includes(this.standing)) {
      throw new Error('standing must be current, past_due, or uncollectible.');
    }
  }
}

/**
 * The idempotency anchor for one payer's invoice in one currency for one
 * period. Its id is derived from that identity, so a retried close always
 * resumes the same row, invoice, and provider invoice.
 */
@smrt({
  tableName: '_smrt_billing_period_closes',
  conflictColumns: [
    'seller_tenant_id',
    'kind',
    'payer_tenant_id',
    'currency',
    'period_start',
    'period_end',
  ],
  api: false,
  cli: false,
  mcp: false,
})
export class BillingPeriodClose extends SmrtObject {
  @crossPackageRef('@happyvertical/smrt-users:Tenant')
  @field({ required: true })
  sellerTenantId: string = '';
  kind: BillingCloseKind = 'provider';
  @crossPackageRef('@happyvertical/smrt-users:Tenant')
  @field({ required: true })
  payerTenantId: string = '';
  currency: string = 'USD';
  periodStart: Date = new Date(0);
  periodEnd: Date = new Date(0);
  @foreignKey('BillingAccount')
  billingAccountId: string = '';
  status: BillingPeriodCloseStatus = 'collecting';
  @foreignKey('Invoice')
  invoiceId: string = '';
  providerInvoiceId: string = '';
  /** Invoice subtotal in integer minor units once invoiced. */
  subtotal: number = 0;
  lineCount: number = 0;
  /** When the invoice was issued; fixed at first collection. */
  issuedAt: Date = new Date(0);
  @field({ type: 'text', nullable: true })
  leaseToken: string | null = null;
  @field({ type: 'datetime', nullable: true })
  leaseExpiresAt: Date | null = null;
  attempts: number = 0;
  lastError: string = '';

  protected async validateBeforeSave(): Promise<void> {
    await super.validateBeforeSave();
    this.sellerTenantId = canonicalTenantId(
      this.sellerTenantId,
      'sellerTenantId',
    );
    this.payerTenantId = canonicalTenantId(this.payerTenantId, 'payerTenantId');
    this.currency = normalizeCurrency(this.currency);
    if (this.kind !== 'provider' && this.kind !== 'reseller') {
      throw new Error('Billing close kind must be provider or reseller.');
    }
    if (!(this.periodEnd.getTime() > this.periodStart.getTime())) {
      throw new Error('A billing period must end after it starts.');
    }
  }

  /**
   * smrt-jobs entry point: close a period for a registered billing runtime.
   * Args: `{ runtime, periodStart?, periodEnd? }` (ISO strings); without a
   * period the previous calendar month (UTC) is closed, so a daily schedule
   * is safe.
   */
  @backgroundEligible()
  async runPeriodClose(
    args: Record<string, unknown> = {},
    _context?: JobExecutionContext,
  ): Promise<unknown> {
    const { runBillingPeriodCloseJob } = await import('../billing/jobs.js');
    return runBillingPeriodCloseJob(args);
  }

  /**
   * smrt-jobs entry point: apply queued provider webhook events for a
   * registered billing runtime. Args: `{ runtime, limit? }`.
   */
  @backgroundEligible()
  async processBillingEvents(
    args: Record<string, unknown> = {},
    _context?: JobExecutionContext,
  ): Promise<unknown> {
    const { runBillingEventsJob } = await import('../billing/jobs.js');
    return runBillingEventsJob(args);
  }
}

/**
 * A claim that one billable source — a charge, an adjustment, or one period
 * of a flat plan — is billed on exactly one period close. The id is derived
 * from `(sourceType, sourceId)`, so a source can never be claimed twice.
 */
@smrt({
  tableName: '_smrt_billing_line_sources',
  conflictColumns: ['source_type', 'source_id'],
  api: false,
  cli: false,
  mcp: false,
})
export class BillingLineSource extends SmrtObject {
  @crossPackageRef('@happyvertical/smrt-users:Tenant')
  @field({ required: true })
  sellerTenantId: string = '';
  @foreignKey('BillingPeriodClose')
  periodCloseId: string = '';
  sourceType: BillingLineSourceType = 'client_charge';
  sourceId: string = '';
  /** Groups sources into one invoice line. */
  lineKey: string = '';
  lineDescription: string = '';
  /** Source amount in integer minor units (signed for adjustments). */
  amount: number = 0;
  /** Discount on this source in integer minor units (flat plans only). */
  discount: number = 0;
  /** Metered quantity, informational; fractional like the charge's. */
  quantity: number = 0.0;
  currency: string = 'USD';
  periodStart: Date | null = null;
  periodEnd: Date | null = null;
}

export class BillingAccountCollection extends SmrtCollection<BillingAccount> {
  static readonly _itemClass = BillingAccount;
}
export class BillingPeriodCloseCollection extends SmrtCollection<BillingPeriodClose> {
  static readonly _itemClass = BillingPeriodClose;
}
export class BillingLineSourceCollection extends SmrtCollection<BillingLineSource> {
  static readonly _itemClass = BillingLineSource;
}
