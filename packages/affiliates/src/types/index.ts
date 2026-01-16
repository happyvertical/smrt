/**
 * Types and enums for smrt-affiliates package
 */

/**
 * Partner types - what role(s) this partner plays
 */
export enum PartnerType {
  PUBLISHER = 'publisher',
  SALESPERSON = 'salesperson',
  REFERRER = 'referrer',
}

/**
 * Partner status
 */
export enum PartnerStatus {
  PENDING = 'pending',
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
}

/**
 * Commission types - how earnings were generated
 */
export enum CommissionType {
  DISPLAY = 'display',
  REFERRAL = 'referral',
  SALES = 'sales',
  PARENT = 'parent',
}

/**
 * Commission status - lifecycle of a commission
 */
export enum CommissionStatus {
  PENDING = 'pending',
  INCLUDED = 'included',
  PAID = 'paid',
}

/**
 * Payout status - lifecycle of a payout batch
 */
export enum PayoutStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

/**
 * Payout method - how payment is delivered
 */
export enum PayoutMethod {
  BANK_TRANSFER = 'bank_transfer',
  CHECK = 'check',
  PAYPAL = 'paypal',
  CREDIT = 'credit',
}
