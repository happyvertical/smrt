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
