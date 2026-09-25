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
 * resumable: a retry continues from the persisted status. A close whose
 * claimed sources net to a credit ends `carried_forward`: its `subtotal` is
 * billed as a credit line by the payer's next close.
 */
export type BillingPeriodCloseStatus =
  | 'collecting'
  | 'invoiced'
  | 'pushed'
  | 'sent'
  | 'completed'
  | 'carried_forward';

export type BillingLineSourceType =
  | 'client_charge'
  | 'billing_adjustment'
  | 'retail_charge'
  | 'subscription_period'
  | 'credit_carry_forward';

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
  /**
   * Billing-cycle anchor (#3116). Null bills UTC calendar months; a date bills
   * monthly periods from it (its day and UTC time of day, clamped to shorter
   * months), with calendar months before it and a stub period from its month
   * start to the anchor. Moving it never bills time twice: flat-plan claims
   * record the time they cover.
   */
  @field({ type: 'datetime', nullable: true })
  billingAnchorAt: Date | null = null;
  /**
   * Prorate flat plans to the time they were active inside a period
   * (#3116): a subscription starting, leaving trial, or canceled mid-period
   * is billed `price × covered / cycle`, rounded half up to minor units.
   * Off, a flat plan active at any point of a period is billed in full (the
   * pre-#3116 behavior).
   */
  prorateFlatPlans: boolean = false;

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
    if (
      this.billingAnchorAt !== null &&
      (!(this.billingAnchorAt instanceof Date) ||
        !Number.isFinite(this.billingAnchorAt.getTime()))
    ) {
      throw new Error('billingAnchorAt must be a valid date or null.');
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
   * period each payer's last ended period on its own schedule is closed
   * (#3116), so a daily schedule is safe.
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
 * A claim that one billable source — a charge, an adjustment, or a window of
 * a flat plan — is billed on exactly one period close. The id is derived
 * from `(sourceType, sourceId)`, so a source can never be claimed twice. A
 * flat plan's claims record the window they cover and are numbered per
 * subscription (`<subscriptionId>:seq:<n>`, #3116): only one claimer can take
 * the next number, so no two cover the same time. Claims written before #3116
 * are `<subscriptionId>:<periodStart>` with number 0.
 */
@smrt({
  tableName: '_smrt_billing_line_sources',
  conflictColumns: ['source_type', 'source_id'],
  // Flat-plan claims are read per subscription line, newest number first
  // (#3116).
  indexes: [
    {
      name: '_smrt_billing_line_sources_line_key_chain_sequence_idx',
      columns: ['lineKey', 'chainSequence'],
    },
  ],
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
  /**
   * A flat-plan claim's number within its subscription (1, 2, …; #3116). 0
   * for other sources and for flat-plan claims written before #3116.
   */
  chainSequence: number = 0;
  currency: string = 'USD';
  /**
   * The billed window. For a flat plan this is the time the claim covers
   * (#3116), which later claims for the same subscription never overlap.
   */
  periodStart: Date | null = null;
  periodEnd: Date | null = null;
}

/** Why a payment attempt was taken (#3138). */
export type BillingPaymentAttemptPurpose =
  | 'credit_purchase'
  | 'invoice_payment';

/**
 * Something about an attempt that an operator must resolve (#3138). Empty
 * when nothing needs attention.
 */
export type BillingPaymentAttemptFlag =
  | ''
  | 'overpaid'
  | 'underpaid'
  | 'paid_late'
  | 'manually_marked'
  | 'invalidated_after_settlement'
  | 'invoice_already_paid'
  | 'amount_mismatch'
  /** The issuer's invoice was closed out of band but the payment never settled. */
  | 'out_of_band_without_settlement';

/** One entry of an attempt's append-only status history. */
export interface BillingPaymentAttemptTransition {
  at: string;
  status: string;
  exception: string;
  source: 'created' | 'webhook' | 'poll';
}

/**
 * One payment attempt on a payment rail (#3138): a short-lived provider
 * checkout (for example a BTCPay invoice) paying a credit purchase or an
 * issued invoice. It records everything the provider reported — the locked
 * fiat price, the native amounts, rate and source, each payment's txid and
 * fee — plus a timeline of status transitions and what settlement produced.
 * Its id is derived from `(provider, checkoutId)`.
 */
@smrt({
  tableName: '_smrt_billing_payment_attempts',
  conflictColumns: ['provider', 'checkout_id'],
  api: false,
  cli: false,
  mcp: false,
})
export class BillingPaymentAttempt extends SmrtObject {
  @crossPackageRef('@happyvertical/smrt-users:Tenant')
  @field({ required: true })
  sellerTenantId: string = '';
  @crossPackageRef('@happyvertical/smrt-users:Tenant')
  @field({ required: true })
  payerTenantId: string = '';
  billingAccountId: string = '';
  purpose: BillingPaymentAttemptPurpose = 'credit_purchase';
  /** The invoice paid (`invoice_payment`). */
  invoiceId: string = '';
  /** The balance credited (`credit_purchase`). */
  spendingPolicyId: string = '';
  /** Provider (rail) name, for example `btcpay`. */
  provider: string = '';
  /** The rail order id (checkout idempotency key) the checkout was made for. */
  orderId: string = '';
  checkoutId: string = '';
  status: string = 'open';
  exception: string = 'none';
  flag: BillingPaymentAttemptFlag = '';
  /** Locked fiat price, integer minor units. */
  amount: number = 0;
  currency: string = 'USD';
  /** Fiat value received at the locked rate, minor units (rounded down). */
  amountPaid: number = 0;
  nativeCurrency: string = '';
  /** Native minor units (satoshis). */
  nativeAmountDue: number = 0;
  nativeAmountPaid: number = 0;
  rate: string = '';
  rateSource: string = '';
  checkoutUrl: string = '';
  @field({ type: 'datetime', nullable: true })
  expiresAt: Date | null = null;
  /** The provider's payments (JSON). */
  payments: Record<string, unknown>[] = [];
  /** Append-only status history (JSON). */
  timeline: BillingPaymentAttemptTransition[] = [];
  @field({ type: 'datetime', nullable: true })
  settledAt: Date | null = null;
  /** The commerce `Payment` settlement recorded. */
  paymentId: string = '';
  /** The credit grant settlement recorded. */
  creditGrantId: string = '';
  /** An operator's note when resolving a flag. */
  resolution: string = '';
  @field({ type: 'datetime', nullable: true })
  resolvedAt: Date | null = null;
  /**
   * Set before the issuer's invoice is closed out of band, so the issuer's
   * own `paid` event waits for this settlement instead of recording one.
   */
  @field({ type: 'datetime', nullable: true })
  outOfBandRequestedAt: Date | null = null;
  /**
   * The most severe standing an issuer event asked for while this payment
   * was confirming (dunning paused); re-applied if it ends unsettled.
   */
  pausedStanding: string = '';
  /** Fiat received above the price, booked as customer credit (minor units). */
  excessAmount: number = 0;
  /** Refunds recorded by operators, total (minor units). */
  refundedAmount: number = 0;
  /** The part of `refundedAmount` taken from the price, not the excess. */
  refundedPrincipal: number = 0;
  /** Refund records (JSON): reference, amount, basis, journal, at. */
  refunds: Record<string, unknown>[] = [];

  protected async validateBeforeSave(): Promise<void> {
    await super.validateBeforeSave();
    this.sellerTenantId = canonicalTenantId(
      this.sellerTenantId,
      'sellerTenantId',
    );
    this.payerTenantId = canonicalTenantId(this.payerTenantId, 'payerTenantId');
    this.currency = normalizeCurrency(this.currency);
    if (
      this.purpose !== 'credit_purchase' &&
      this.purpose !== 'invoice_payment'
    ) {
      throw new Error('Payment attempt purpose is invalid.');
    }
    if (!this.provider || !this.checkoutId) {
      throw new Error('Payment attempts require a provider and checkoutId.');
    }
    for (const value of [
      this.amount,
      this.amountPaid,
      this.nativeAmountDue,
      this.nativeAmountPaid,
      this.excessAmount,
      this.refundedAmount,
      this.refundedPrincipal,
    ]) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error('Payment attempt amounts must be minor units.');
      }
    }
  }

  /** The timeline, tolerating a JSON string from the database. */
  get transitions(): BillingPaymentAttemptTransition[] {
    return jsonArray(this.timeline) as BillingPaymentAttemptTransition[];
  }

  /** The recorded payments, tolerating a JSON string from the database. */
  get paymentRecords(): Record<string, unknown>[] {
    return jsonArray(this.payments) as Record<string, unknown>[];
  }

  /** The recorded refunds, tolerating a JSON string from the database. */
  get refundRecords(): Record<string, unknown>[] {
    return jsonArray(this.refunds) as Record<string, unknown>[];
  }
}

function jsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
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
export class BillingPaymentAttemptCollection extends SmrtCollection<BillingPaymentAttempt> {
  static readonly _itemClass = BillingPaymentAttempt;
}
