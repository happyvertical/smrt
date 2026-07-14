/**
 * @happyvertical/smrt-affiliates — DEPRECATED compatibility shim.
 *
 * This package no longer declares any models and owns no persistence. Every
 * export below is a thin alias over the neutral commissions core in
 * `@happyvertical/smrt-sales` (`Earner`, `Commission`, `CommissionPayout`,
 * their collections, and the status vocabularies), kept only so existing
 * imports keep compiling while consumers migrate.
 *
 * Migrate at your own pace:
 *
 * - New code should import from `@happyvertical/smrt-sales` directly
 *   (`Earner`, `EarnerCollection`, `Commission`, `CommissionCollection`,
 *   `CommissionPayout`, `CommissionPayoutCollection`, plans, earning events,
 *   adjustments, services, and money helpers).
 * - The legacy partner ROLES (publisher/salesperson/referrer) are now
 *   first-class models: `Referrer` in `@happyvertical/smrt-sales/referrals`
 *   and `SalesRepresentative` in `@happyvertical/smrt-sales/crm`, each
 *   holding an `earnerId` pointing at the shared financial account.
 * - The data/API migration path (table and column mappings, status mappings,
 *   SQL sketches) is documented in this package's `MIGRATION.md`.
 *
 * This shim will be removed in a future major release.
 *
 * @deprecated Use `@happyvertical/smrt-sales` instead. See `MIGRATION.md` in
 * this package for the full data/API migration path.
 * @packageDocumentation
 */

import type {
  CommissionOptions as SalesCommissionOptions,
  CommissionPayoutOptions as SalesCommissionPayoutOptions,
  EarnerOptions as SalesEarnerOptions,
} from '@happyvertical/smrt-sales';

// ---------------------------------------------------------------------------
// Class / collection aliases
//
// These are the SAME runtime classes as the `@happyvertical/smrt-sales`
// exports — `Partner === Earner`, `Payout === CommissionPayout` — re-exported
// under the legacy names. Data lives in the sales tables (`earners`,
// `commissions`, `commission_payouts`); the legacy `partners`/`payouts`
// tables are not read or written by this package. See MIGRATION.md.
// ---------------------------------------------------------------------------

/**
 * @deprecated Import `Earner` / `EarnerCollection`, `Commission` /
 * `CommissionCollection`, and `CommissionPayout` /
 * `CommissionPayoutCollection` from `@happyvertical/smrt-sales` instead.
 */
export {
  Commission,
  CommissionCollection,
  CommissionPayout as Payout,
  CommissionPayoutCollection as PayoutCollection,
  Earner as Partner,
  EarnerCollection as PartnerCollection,
} from '@happyvertical/smrt-sales';

// ---------------------------------------------------------------------------
// Option-type aliases
// ---------------------------------------------------------------------------

/** @deprecated Use `EarnerOptions` from `@happyvertical/smrt-sales`. */
export type PartnerOptions = SalesEarnerOptions;

/** @deprecated Use `CommissionOptions` from `@happyvertical/smrt-sales`. */
export type CommissionOptions = SalesCommissionOptions;

/** @deprecated Use `CommissionPayoutOptions` from `@happyvertical/smrt-sales`. */
export type PayoutOptions = SalesCommissionPayoutOptions;

// ---------------------------------------------------------------------------
// Legacy enum-compatible const objects
//
// The old package exported TS enums; these frozen `as const` objects preserve
// the exact legacy member names and string values so both value positions
// (`PartnerStatus.ACTIVE`) and type positions (`status: PartnerStatus`) keep
// compiling. Where a new equivalent exists, the values align with the
// `@happyvertical/smrt-sales` string-literal unions.
// ---------------------------------------------------------------------------

/**
 * Legacy partner status values.
 *
 * @deprecated Use the `EarnerStatus` union
 * (`'pending' | 'active' | 'suspended'`) from `@happyvertical/smrt-sales` —
 * the string values align exactly.
 */
export const PartnerStatus = Object.freeze({
  PENDING: 'pending',
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
} as const);
/** @deprecated Use `EarnerStatus` from `@happyvertical/smrt-sales`. */
export type PartnerStatus = (typeof PartnerStatus)[keyof typeof PartnerStatus];

/**
 * Legacy partner role values.
 *
 * @deprecated Partner roles have NO direct equivalent in
 * `@happyvertical/smrt-sales` — roles are now first-class models instead of a
 * JSON array on the financial account: use `Referrer` from
 * `@happyvertical/smrt-sales/referrals` and `SalesRepresentative` from
 * `@happyvertical/smrt-sales/crm` (each holds an `earnerId`); model
 * publisher-style roles in your application domain. See MIGRATION.md.
 */
export const PartnerType = Object.freeze({
  PUBLISHER: 'publisher',
  SALESPERSON: 'salesperson',
  REFERRER: 'referrer',
} as const);
/**
 * @deprecated Roles are first-class models in `@happyvertical/smrt-sales`
 * (`Referrer`, `SalesRepresentative`); see MIGRATION.md.
 */
export type PartnerType = (typeof PartnerType)[keyof typeof PartnerType];

/**
 * Legacy commission type values.
 *
 * @deprecated Superseded by `CommissionPlan` component keys in
 * `@happyvertical/smrt-sales`: a versioned plan's `components` array replaces
 * the fixed display/referral/sales/parent/overhead taxonomy — each component
 * has its own `key`, `trigger`, `basis`, and `rate`, and every `Commission`
 * records the `componentKey` that produced it. See MIGRATION.md for a worked
 * plan reproducing the legacy waterfall.
 */
export const CommissionType = Object.freeze({
  DISPLAY: 'display',
  REFERRAL: 'referral',
  SALES: 'sales',
  PARENT: 'parent',
  OVERHEAD: 'overhead',
} as const);
/**
 * @deprecated Superseded by `CommissionPlan` component keys in
 * `@happyvertical/smrt-sales`; see MIGRATION.md.
 */
export type CommissionType =
  (typeof CommissionType)[keyof typeof CommissionType];

/**
 * Legacy commission status values.
 *
 * @deprecated Use the `CommissionStatus` union
 * (`'pending' | 'earned' | 'approved' | 'payable' | 'paid'`) from
 * `@happyvertical/smrt-sales`. `PENDING` and `PAID` align; `INCLUDED` has no
 * direct equivalent — the nearest new state is `'payable'` with `payoutId`
 * set (a commission gathered into a payout batch). See MIGRATION.md.
 */
export const CommissionStatus = Object.freeze({
  PENDING: 'pending',
  INCLUDED: 'included',
  PAID: 'paid',
} as const);
/** @deprecated Use `CommissionStatus` from `@happyvertical/smrt-sales`. */
export type CommissionStatus =
  (typeof CommissionStatus)[keyof typeof CommissionStatus];

/**
 * Legacy payout status values.
 *
 * @deprecated Use the `CommissionPayoutStatus` union
 * (`'pending' | 'approved' | 'processing' | 'completed' | 'failed' |
 * 'rejected'`) from `@happyvertical/smrt-sales` — the legacy value set is a
 * subset (legacy affiliates had no reject) and the shared string values
 * align exactly.
 */
export const PayoutStatus = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const);
/** @deprecated Use `CommissionPayoutStatus` from `@happyvertical/smrt-sales`. */
export type PayoutStatus = (typeof PayoutStatus)[keyof typeof PayoutStatus];

/**
 * Legacy payout method values.
 *
 * @deprecated Use the `PayoutMethod` union
 * (`'bank_transfer' | 'check' | 'paypal' | 'credit' | 'other'`) from
 * `@happyvertical/smrt-sales` — the legacy values align exactly; the new
 * union adds `'other'`.
 */
export const PayoutMethod = Object.freeze({
  BANK_TRANSFER: 'bank_transfer',
  CHECK: 'check',
  PAYPAL: 'paypal',
  CREDIT: 'credit',
} as const);
/** @deprecated Use `PayoutMethod` from `@happyvertical/smrt-sales`. */
export type PayoutMethod = (typeof PayoutMethod)[keyof typeof PayoutMethod];
