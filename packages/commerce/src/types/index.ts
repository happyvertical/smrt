/**
 * Commerce package type definitions
 * @packageDocumentation
 */

import type { SmrtObjectOptions } from '@happyvertical/smrt-core';

// ============================================================================
// Customer/Vendor Types
// ============================================================================

export enum CustomerStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  SUSPENDED = 'suspended',
}

/**
 * Customer classification — drives channel access, pricing tier, and credit terms.
 *
 * - DTC: direct-to-consumer (end shopper). Pays via storefront checkout.
 * - WHOLESALE: B2B buyer with negotiated terms (NET-30, line sheets, etc.).
 * - RETAIL: in-store walk-in / point-of-sale customer.
 */
export enum CustomerType {
  DTC = 'dtc',
  WHOLESALE = 'wholesale',
  RETAIL = 'retail',
}

export enum VendorStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  SUSPENDED = 'suspended',
}

// ============================================================================
// Contract Types
// ============================================================================

export enum ContractType {
  ESTIMATE = 'estimate',
  ORDER = 'order',
  LEASE = 'lease',
  AGREEMENT = 'agreement',
  PURCHASE_ORDER = 'purchase_order',
  WHOLESALE_ORDER = 'wholesale_order',
  PRODUCTION_ORDER = 'production_order',
  CART = 'cart',
  /**
   * Industry-neutral licensing primitive. The `LicenseSale` STI subtype
   * carries an immutable rights snapshot, a licensee email, optional
   * legal-entity / jurisdiction fields, and a signed-PDF reference.
   * Any application that sells rights for a fee (stock media,
   * music licensing, code-asset marketplace, license keys, etc.)
   * uses this subtype.
   */
  LICENSE_SALE = 'license_sale',
}

export enum ContractStatus {
  DRAFT = 'draft',
  SENT = 'sent',
  ACCEPTED = 'accepted',
  DECLINED = 'declined',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
}

// ============================================================================
// Fulfillment Types
// ============================================================================

export enum FulfillmentType {
  SHIPMENT = 'shipment',
  DELIVERY = 'delivery',
  PICKUP = 'pickup',
  DIGITAL = 'digital',
  SERVICE = 'service',
}

export enum FulfillmentStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  SHIPPED = 'shipped',
  DELIVERED = 'delivered',
  CANCELLED = 'cancelled',
}

// ============================================================================
// Payment Types
// ============================================================================

export enum PaymentMethod {
  CASH = 'cash',
  CHECK = 'check',
  CREDIT_CARD = 'credit_card',
  BANK_TRANSFER = 'bank_transfer',
  CRYPTO = 'crypto',
  OTHER = 'other',
}

export enum PaymentStatus {
  PENDING = 'pending',
  COMPLETED = 'completed',
  FAILED = 'failed',
  REFUNDED = 'refunded',
  CANCELLED = 'cancelled',
}

// ============================================================================
// Payout Types
// ============================================================================

/**
 * Status machine for {@link Payout}.
 *
 * `pending → sent → confirmed → failed`. `failed` is terminal but the
 * model exposes a dedicated `resetFromFailed()` so an operator can
 * deliberately requeue a payout after fixing the underlying problem;
 * the reset moves the row back to `pending` and clears the failure
 * metadata.
 *
 * Skipping intermediate states is rejected — a `pending` payout cannot
 * jump straight to `confirmed`, and a `sent` payout cannot regress to
 * `pending` without going through `resetFromFailed()` first.
 */
export enum PayoutStatus {
  PENDING = 'pending',
  SENT = 'sent',
  CONFIRMED = 'confirmed',
  FAILED = 'failed',
}

// ============================================================================
// PaymentIntent Types
// ============================================================================

/**
 * Status machine for {@link PaymentIntent}.
 *
 * `awaiting_payment → paid → (issued | retired)`, with `expired` and
 * `cancelled` as alternate terminal states reachable from
 * `awaiting_payment`.
 *
 * - `AWAITING_PAYMENT` — open quote, accepting any of the listed
 *   payment options.
 * - `PAID` — one option was satisfied by an incoming payment. The
 *   other options are implicitly retired; later inbound funds to a
 *   retired option must be flagged for refund by the consumer.
 * - `ISSUED` — downstream rights / contract / fulfillment have been
 *   created and linked. Terminal happy-path state.
 * - `RETIRED` — paid but the satisfaction was reversed (refund,
 *   chargeback, etc.). Terminal.
 * - `EXPIRED` — the USD-price-lock window passed without payment.
 *   Terminal.
 * - `CANCELLED` — the buyer or the system explicitly cancelled the
 *   intent before it was paid. Terminal.
 */
export enum PaymentIntentStatus {
  AWAITING_PAYMENT = 'awaiting_payment',
  PAID = 'paid',
  ISSUED = 'issued',
  RETIRED = 'retired',
  EXPIRED = 'expired',
  CANCELLED = 'cancelled',
}

/**
 * One way for a {@link PaymentIntent} to be satisfied. The intent lists
 * an array of these; satisfying any one of them transitions the intent
 * to `PAID` and implicitly retires the rest.
 *
 * Industry-neutral: a marketplace that accepts USDC-on-Base and BTC
 * lists two options; a SaaS billing flow that accepts Stripe and
 * PayPal lists two; a kiosk that accepts only one rail lists one.
 */
export interface PaymentOption {
  /**
   * Stable id of the `PaymentBackend` adapter that fulfills this
   * option — must match a `backendId` the consumer's payment-routing
   * layer recognises. Examples: `base-usdc`, `solana-usdc`, `btc`,
   * `stripe`, `paypal`.
   */
  backendId: string;
  /**
   * Payout-rail-qualified currency code, e.g. `USDC-base`, `BTC`,
   * `USD-stripe`. The same convention used by
   * `Vendor.payoutAddresses` and `Payment.nativeCurrency`.
   */
  currency: string;
  /**
   * Optional chain identifier for blockchain-backed options (`base`,
   * `ethereum`, `solana`, ...). Pure-fiat options leave this empty.
   */
  chain?: string;
  /**
   * Destination address / account id the buyer should send funds to
   * for this option (EVM address, BTC address, Stripe payment-intent
   * id, etc.).
   */
  payTo: string;
  /**
   * Amount denominated in `currency`. Stored at decimal precision —
   * a USDC option might be `199.0`, a BTC option `0.00713`.
   */
  nativeAmount: number;
  /**
   * Optional on-chain memo / payment reference (Solana memo, BTC OP_RETURN
   * tag, Stripe metadata key). Some backends use this to disambiguate
   * which intent an inbound payment satisfies.
   */
  memo?: string;
  /**
   * Whether this option supports the x402 HTTP-402 payment-required
   * flow. Consumers that build agent-driven flows use this flag to
   * filter the offered options.
   */
  x402Capable?: boolean;
  /**
   * Optional per-option expiry — when a single rail's quote becomes
   * stale earlier than the intent-wide price-lock window (e.g. a
   * volatile-currency option that re-quotes more aggressively). ISO
   * 8601 string. Empty / missing means "inherit the intent's
   * `priceLockExpiresAt`".
   */
  expiresAt?: string;
}

// ============================================================================
// Invoice Types
// ============================================================================

export enum InvoiceStatus {
  DRAFT = 'draft',
  SENT = 'sent',
  VIEWED = 'viewed',
  PARTIAL = 'partial',
  PAID = 'paid',
  OVERDUE = 'overdue',
  CANCELLED = 'cancelled',
  WRITTEN_OFF = 'written_off',
}

// ============================================================================
// Common Interfaces
// ============================================================================

/**
 * Address structure used for billing and shipping
 */
export interface Address {
  street1?: string;
  street2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

/**
 * Options for recording a payment with ledger integration
 */
export interface RecordPaymentOptions {
  /** The ledger to record the journal entry in */
  ledgerId: string;
  /** Account ID for receivables (credit side) */
  receivablesAccountId: string;
  /** Account ID for cash/bank (debit side) */
  cashAccountId: string;
}

/**
 * Options for recognizing revenue on an invoice
 */
export interface RecognizeRevenueOptions {
  /** Account ID for accounts receivable (debit side) */
  arAccountId: string;
  /** Account ID for revenue (credit side) */
  revenueAccountId: string;
  /** Account ID for tax payable (credit side, optional) */
  taxAccountId?: string;
}

// ============================================================================
// Accounting-provider sync shapes
// ============================================================================

/**
 * A single line item in the format expected by `@happyvertical/accounting`
 * providers (QBO, Stripe, …). Mirrors the object built by
 * {@link InvoiceLineItem.toAccountingLineItem}. The SDK isn't a dependency of
 * this package, so the shape is declared locally rather than imported.
 */
export interface AccountingLineItemInput {
  description: string;
  sku?: string;
  quantity: number;
  unitPrice: number;
  discount?: number;
  taxRate?: number;
  amount: number;
  periodStart?: Date;
  periodEnd?: Date;
}

/**
 * An invoice in the format expected by `@happyvertical/accounting` providers.
 * Mirrors the object built by {@link Invoice.toAccountingInput}.
 */
export interface AccountingInvoiceInput {
  id: string;
  externalId?: string;
  invoiceNumber: string;
  customerId: string;
  customerExternalId?: string;
  issueDate: Date;
  dueDate: Date;
  lineItems: AccountingLineItemInput[];
  subtotal: number;
  taxAmount: number;
  totalAmount: number;
  currency: string;
  reference?: string;
  memo?: string;
}

// ============================================================================
// Model constructor option interfaces
//
// Each model's `constructor(options)` accepts a partial bag of its own fields.
// Declaring a dedicated `XxxOptions extends SmrtObjectOptions` interface keeps
// the constructors strongly typed (no `any`) while still allowing the
// framework's base options (db, ai, fs, _className, …) through.
// ============================================================================

/**
 * Constructor options for {@link Customer}.
 */
export interface CustomerOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  profileId?: string;
  creditLimit?: number;
  paymentTerms?: string;
  taxExempt?: boolean;
  taxId?: string;
  defaultShippingAddress?: Address;
  defaultBillingAddress?: Address;
  status?: CustomerStatus;
  customerType?: CustomerType | null;
  notes?: string;
}

/**
 * Constructor options for {@link Vendor}.
 */
export interface VendorOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  profileId?: string;
  leadTimeDays?: number;
  minimumOrderAmount?: number;
  paymentTerms?: string;
  currency?: string;
  defaultContactEmail?: string;
  defaultContactPhone?: string;
  status?: VendorStatus;
  notes?: string;
  payoutAddresses?: Record<string, string> | string | null;
}

/**
 * Constructor options for {@link Contract} and its STI subtypes.
 */
export interface ContractOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  contractType?: ContractType;
  status?: ContractStatus;
  customerId?: string;
  vendorId?: string;
  subtotal?: number;
  taxAmount?: number;
  totalAmount?: number;
  currency?: string;
  issueDate?: Date;
  dueDate?: Date | null;
  expiryDate?: Date | null;
  reference?: string;
  notes?: string;
  terms?: string;
  channelId?: string;
}

/**
 * Constructor options for {@link LicenseSale} (Contract STI subtype). Extends
 * {@link ContractOptions} with the licensing-specific meta fields.
 */
export interface LicenseSaleOptions extends ContractOptions {
  skuId?: string;
  paymentId?: string;
  licenseeEmail?: string;
  licenseeLegalEntity?: string;
  licenseeJurisdiction?: string;
  rightsMedium?: string;
  rightsDistributionScope?: string;
  rightsExclusivity?: string;
  rightsDuration?: string;
  rightsTerritory?: string;
  rightsSublicensing?: boolean;
  rightsDerivatives?: boolean;
  pdfUrl?: string;
  pdfHash?: string;
  onChainHashRegistryRef?: string;
}

/**
 * Constructor options for {@link ContractLineItem}.
 */
export interface ContractLineItemOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  contractId?: string;
  description?: string;
  quantity?: number;
  unitPrice?: number;
  discount?: number;
  taxRate?: number;
  amount?: number;
  productId?: string;
  sku?: string;
  startDate?: Date | null;
  endDate?: Date | null;
  billingPeriod?: string;
  sortOrder?: number;
}

/**
 * Constructor options for {@link Invoice}.
 */
export interface InvoiceOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  customerId?: string;
  contractId?: string;
  invoiceNumber?: string;
  reference?: string;
  issueDate?: Date;
  dueDate?: Date;
  paidDate?: Date | null;
  subtotal?: number;
  taxAmount?: number;
  totalAmount?: number;
  amountPaid?: number;
  currency?: string;
  status?: InvoiceStatus;
  arJournalId?: string;
  revenueJournalId?: string;
  externalId?: string;
  customerExternalId?: string;
  externalProvider?: string;
  syncedAt?: Date | null;
  sentAt?: Date | null;
  viewedAt?: Date | null;
  remindersSent?: number;
  lastReminderAt?: Date | null;
  notes?: string;
  customerNotes?: string;
  terms?: string;
}

/**
 * Constructor options for {@link InvoiceLineItem}.
 */
export interface InvoiceLineItemOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  invoiceId?: string;
  description?: string;
  sku?: string;
  quantity?: number;
  unitPrice?: number;
  discount?: number;
  taxRate?: number;
  amount?: number;
  sourceType?: string;
  sourceId?: string;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  revenueAccountId?: string;
  sortOrder?: number;
}

/**
 * Constructor options for {@link Fulfillment}.
 */
export interface FulfillmentOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  contractId?: string;
  fulfillmentType?: FulfillmentType;
  status?: FulfillmentStatus;
  trackingNumber?: string;
  carrier?: string;
  shippingAddress?: Address;
  shippedAt?: Date | null;
  deliveredAt?: Date | null;
  estimatedDelivery?: Date | null;
  notes?: string;
}

/**
 * Constructor options for {@link FulfillmentLineItem}.
 */
export interface FulfillmentLineItemOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  fulfillmentId?: string;
  contractLineItemId?: string;
  quantityFulfilled?: number;
  notes?: string;
}

/**
 * Constructor options for {@link Payment}.
 */
export interface PaymentOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  contractId?: string;
  customerId?: string;
  amount?: number;
  currency?: string;
  method?: PaymentMethod;
  status?: PaymentStatus;
  transactionId?: string;
  reference?: string;
  journalId?: string;
  paidAt?: Date | null;
  notes?: string;
  externalId?: string;
  externalProvider?: string;
  syncedAt?: Date | null;
  backendId?: string;
  backendTxRef?: string;
  nativeAmount?: number;
  nativeCurrency?: string;
  usdAtQuote?: number;
  usdAtConfirmation?: number;
}

/**
 * Constructor options for {@link PaymentAllocation}.
 */
export interface PaymentAllocationOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  paymentId?: string;
  invoiceId?: string;
  amount?: number;
  allocatedAt?: Date;
  allocatedBy?: string;
  notes?: string;
}

/**
 * Constructor options for {@link PaymentIntent}.
 */
export interface PaymentIntentOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  skuId?: string;
  offeringRef?: string;
  licenseeEmail?: string;
  customerId?: string;
  paymentOptions?: PaymentOption[] | string;
  usdPriceLocked?: number;
  priceLockWindowMs?: number;
  priceLockExpiresAt?: Date | number | string | null;
  status?: PaymentIntentStatus;
  idempotencyKey?: string;
  paidOptionBackendId?: string;
  paymentId?: string;
  paidAt?: Date | number | string | null;
  issuedAt?: Date | number | string | null;
  expiredAt?: Date | number | string | null;
  cancelledAt?: Date | number | string | null;
  retiredAt?: Date | number | string | null;
  notes?: string;
}

/**
 * Constructor options for {@link Payout}.
 */
export interface PayoutOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  paymentId?: string;
  vendorId?: string;
  grossAmount?: number;
  operatorFee?: number;
  supplierNet?: number;
  currency?: string;
  backendId?: string;
  backendTxRef?: string;
  status?: PayoutStatus;
  sentAt?: Date | number | string | null;
  confirmedAt?: Date | number | string | null;
  failedAt?: Date | number | string | null;
  failureReason?: string;
  notes?: string;
}
