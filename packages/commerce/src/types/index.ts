/**
 * Commerce package type definitions
 * @packageDocumentation
 */

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
