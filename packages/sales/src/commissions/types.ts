/**
 * Shared types for the neutral commissions financial core.
 *
 * Statuses are string-literal unions derived from `as const` arrays (no TS
 * enums) so downstream code can iterate the legal values and the types stay
 * erasable. All monetary fields across the module are integer cents with a
 * `*Cents` suffix; rates/fractions are decimals in the range 0–1.
 *
 * This module is the neutral financial core of `@happyvertical/smrt-sales`:
 * it never imports from the `crm` or `referrals` modules and never assumes
 * advertising, Referral, Lead, or Opportunity semantics. Earning sources are
 * generic `(sourceKind, sourceId)` string pairs.
 *
 * @packageDocumentation
 */

import type { SmrtObjectOptions } from '@happyvertical/smrt-core';

// ---------------------------------------------------------------------------
// Status / kind vocabularies
// ---------------------------------------------------------------------------

/** Lifecycle of an {@link Earner} payout account. */
export const EARNER_STATUSES = ['pending', 'active', 'suspended'] as const;
export type EarnerStatus = (typeof EARNER_STATUSES)[number];

/**
 * Lifecycle of an {@link EarnerSourceAttribution} mapping row. `inactive`
 * rows are retained for audit but never resolve through the attribution
 * lookups.
 */
export const EARNER_SOURCE_ATTRIBUTION_STATUSES = [
  'active',
  'inactive',
] as const;
export type EarnerSourceAttributionStatus =
  (typeof EARNER_SOURCE_ATTRIBUTION_STATUSES)[number];

/**
 * How a payout is delivered. Shared between {@link Earner} (preference) and
 * {@link CommissionPayout} (what a specific batch will use).
 */
export const PAYOUT_METHODS = [
  'bank_transfer',
  'check',
  'paypal',
  'credit',
  'other',
] as const;
export type PayoutMethod = (typeof PAYOUT_METHODS)[number];

/**
 * Lifecycle of a versioned {@link CommissionPlan} row.
 *
 * `draft → active | retired`; `active → superseded | retired`;
 * `superseded` / `retired` are terminal. Amendments never mutate an active
 * row — they insert a new `(planKey, version + 1)` draft.
 */
export const COMMISSION_PLAN_STATUSES = [
  'draft',
  'active',
  'superseded',
  'retired',
] as const;
export type CommissionPlanStatus = (typeof COMMISSION_PLAN_STATUSES)[number];

/**
 * Lifecycle of a {@link Commission} earning record. STRICT forward chain:
 * `pending → earned → approved → payable → paid` — no skips, no reversals.
 * Corrections to earned/paid commissions are appended as
 * {@link CommissionAdjustment} rows, never edits.
 */
export const COMMISSION_STATUSES = [
  'pending',
  'earned',
  'approved',
  'payable',
  'paid',
] as const;
export type CommissionStatus = (typeof COMMISSION_STATUSES)[number];

/** How a commission amount is derived from its earning event. */
export const COMMISSION_BASES = [
  'fixed',
  'gross',
  'net',
  'margin',
  'custom',
] as const;
export type CommissionBasis = (typeof COMMISSION_BASES)[number];

/** Kinds of append-only {@link CommissionAdjustment} corrections. */
export const COMMISSION_ADJUSTMENT_KINDS = [
  'refund',
  'credit',
  'chargeback',
  'dispute',
  'correction',
] as const;
export type CommissionAdjustmentKind =
  (typeof COMMISSION_ADJUSTMENT_KINDS)[number];

/**
 * Lifecycle of a {@link CommissionPayout} settlement batch.
 *
 * `pending → approved → processing → completed | failed`, with `failed`
 * reachable from `approved`/`processing` and resettable to `pending` only via
 * the dedicated `resetFromFailed()` helper. `rejected` is the terminal
 * operator-decline exit from `pending`/`approved` — rejecting releases the
 * batch's membership back to unsettled so a future batch can re-gather it
 * (`reject()` on the model mutates status only; the release lives in
 * `CommissionPayoutService.transitionPayoutForSource`).
 */
export const COMMISSION_PAYOUT_STATUSES = [
  'pending',
  'approved',
  'processing',
  'completed',
  'failed',
  'rejected',
] as const;
export type CommissionPayoutStatus =
  (typeof COMMISSION_PAYOUT_STATUSES)[number];

/**
 * Recommended earning-event kinds. The `EarningEvent.eventKind` field stays an
 * open string so applications can define their own commercial vocabulary —
 * these are the kinds the framework's own modules emit and recognize.
 */
export const EARNING_EVENT_KINDS = [
  'conversion',
  'agreement_execution',
  'invoice_payment',
  'collected_revenue',
  'recognized_margin',
  'milestone',
] as const;
export type EarningEventKind = (typeof EARNING_EVENT_KINDS)[number];

/**
 * Commission statuses whose unsettled adjustments count toward an earner's
 * net payable balance (and are gathered into payout batches). Adjustments
 * against a still-`pending` commission stay out of settlement until the
 * underlying earning clears.
 */
export const ADJUSTMENT_SETTLEABLE_COMMISSION_STATUSES = [
  'earned',
  'approved',
  'payable',
  'paid',
] as const satisfies readonly CommissionStatus[];

// ---------------------------------------------------------------------------
// Plan components
// ---------------------------------------------------------------------------

/** Recurrence contract for a {@link CommissionPlanComponent}. */
export interface CommissionPlanComponentRecurrence {
  /** `one_time` fires at most once per earner+terms; `recurring` repeats. */
  kind: 'one_time' | 'recurring';
  /** Maximum number of occurrences for `recurring` components. */
  maxOccurrences?: number;
  /**
   * Only events whose `occurredAt` falls within `anchorAt + windowMonths`
   * qualify (the anchor — e.g. an agreement's effective date — is supplied by
   * the caller at calculation time).
   */
  windowMonths?: number;
}

/**
 * One calculation term inside a {@link CommissionPlan}'s `components` JSON
 * array. Each earning event is matched against every component whose
 * `trigger` equals the event's `eventKind` (or `'*'`).
 */
export interface CommissionPlanComponent {
  /** Unique key within the plan (stable across versions by convention). */
  key: string;
  /** Earning-event kind this component fires on, or `'*'` for any kind. */
  trigger: string;
  /** How the commission base amount is resolved from the event. */
  basis: CommissionBasis;
  /** Rate in the range 0–1. Required for every basis except `fixed`. */
  rate?: number;
  /** Flat amount in integer cents. Required for basis `fixed`. */
  fixedAmountCents?: number;
  /** Optional recurrence limits; omitted means unlimited. */
  recurrence?: CommissionPlanComponentRecurrence;
  /**
   * For basis `custom`: the key into the earning event's `customBases`
   * JSON map (`basisKey → cents`) that supplies the base amount.
   */
  customBasisKey?: string;
}

// ---------------------------------------------------------------------------
// Calculation trace
// ---------------------------------------------------------------------------

/**
 * Everything needed to reproduce a Commission's `amountCents` from first
 * principles. Persisted as a JSON string on every Commission so amounts stay
 * auditable even after plans are superseded.
 */
export interface CommissionCalculationTrace {
  planKey: string;
  planVersion: number;
  componentKey: string;
  basis: CommissionBasis;
  /** Base amount the rate was applied to, in integer cents. */
  baseAmountCents: number;
  /** Rate applied (0–1). Recorded as `0` for `fixed`-basis components. */
  rate: number;
  /** Split share applied (0–1; `1` for unsplit commissions). */
  shareFraction: number;
  /** Zero-based occurrence index within the component's recurrence. */
  occurrenceIndex: number;
  /** Id of the {@link EarningEvent} evidence row. */
  earningEventId: string;
  /** Rounding contract used by `roundCents()`. */
  roundingMode: 'half_away_from_zero';
}

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

/**
 * Computed (never stored) per-earner, per-currency balance snapshot.
 * All figures in integer cents.
 */
export interface EarnerBalance {
  earnerId: string;
  currency: string;
  /** Σ unsettled `payable` commissions. */
  payableCents: number;
  /** Σ `pending` commissions (still clearing). */
  pendingCents: number;
  /** Σ `earned` commissions (cleared, awaiting approval). */
  earnedCents: number;
  /** Σ `approved` commissions (awaiting payable release). */
  approvedCents: number;
  /**
   * Σ unsettled adjustments whose parent commission is
   * earned/approved/payable/paid (signed — clawbacks are negative).
   */
  unsettledAdjustmentCents: number;
  /** `payableCents + unsettledAdjustmentCents`. May be negative. */
  netPayableCents: number;
}

// ---------------------------------------------------------------------------
// Model constructor options
// ---------------------------------------------------------------------------

/** Options for constructing an {@link Earner}. */
export interface EarnerOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  profileId?: string;
  displayName?: string;
  status?: EarnerStatus;
  payoutMethod?: PayoutMethod;
  payoutThresholdCents?: number;
  payoutScheduleKey?: string;
  currency?: string;
  metadata?: string;
}

/** Options for constructing an {@link EarnerSourceAttribution}. */
export interface EarnerSourceAttributionOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  earnerId?: string;
  sourceKind?: string;
  sourceId?: string;
  status?: EarnerSourceAttributionStatus;
  metadata?: string;
}

/** Options for constructing a {@link CommissionPlan}. */
export interface CommissionPlanOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  planKey?: string;
  version?: number;
  name?: string;
  description?: string;
  status?: CommissionPlanStatus;
  effectiveFrom?: Date | string | number | null;
  currency?: string;
  components?: string;
  metadata?: string;
}

/** Options for constructing an {@link EarningEvent}. */
export interface EarningEventOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  eventKind?: string;
  occurredAt?: Date | string | number;
  sourceKind?: string;
  sourceId?: string;
  grossAmountCents?: number;
  netAmountCents?: number | null;
  marginCents?: number | null;
  currency?: string;
  customBases?: string;
  dedupeKey?: string;
  metadata?: string;
}

/** Options for constructing a {@link Commission}. */
export interface CommissionOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  earnerId?: string;
  earningEventId?: string | null;
  planKey?: string;
  planVersion?: number;
  componentKey?: string;
  termsSnapshotKind?: string;
  termsSnapshotId?: string;
  basis?: CommissionBasis;
  baseAmountCents?: number;
  rate?: number;
  shareFraction?: number;
  splitGroupId?: string;
  amountCents?: number;
  currency?: string;
  status?: CommissionStatus;
  clearingEndsAt?: Date | string | number | null;
  earnedAt?: Date | string | number | null;
  approvedAt?: Date | string | number | null;
  payableAt?: Date | string | number | null;
  paidAt?: Date | string | number | null;
  payoutId?: string | null;
  sourceKind?: string;
  sourceId?: string;
  calculationTrace?: string;
  dedupeKey?: string;
  metadata?: string;
}

/** Options for constructing a {@link CommissionAdjustment}. */
export interface CommissionAdjustmentOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  commissionId?: string;
  earnerId?: string;
  adjustmentKind?: CommissionAdjustmentKind;
  amountCents?: number;
  currency?: string;
  reason?: string;
  createdByProfileId?: string;
  payoutId?: string | null;
  metadata?: string;
}

/** Options for constructing a {@link CommissionPayout}. */
export interface CommissionPayoutOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  earnerId?: string;
  periodStart?: Date | string | number | null;
  periodEnd?: Date | string | number | null;
  commissionTotalCents?: number;
  adjustmentTotalCents?: number;
  totalAmountCents?: number;
  currency?: string;
  payoutMethod?: PayoutMethod;
  status?: CommissionPayoutStatus;
  paymentReference?: string;
  providerRef?: string;
  paidAt?: Date | string | number | null;
  invoiceId?: string;
  notes?: string;
  idempotencyKey?: string;
  sourceKind?: string;
  sourceId?: string;
  metadata?: string;
}
