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
 * What kind of party an {@link Earner} pays out to (#3834).
 *
 * - `person` (default; every pre-existing earner) — an individual, normally
 *   linked to a smrt-profiles person Profile through `profileId`.
 * - `organisation` — a legal entity (a member business, outlet, farm, …).
 *   It needs no person Profile; `profileId` stays empty unless the host
 *   links an organisation Profile.
 * - `treasury` — an entity's own retained-funds account (for example a
 *   co-operative's treasury used as a waterfall remainder sink). It never
 *   has a person Profile.
 */
export const EARNER_KINDS = ['person', 'organisation', 'treasury'] as const;
export type EarnerKind = (typeof EARNER_KINDS)[number];

/**
 * How a payout is delivered. Shared between {@link Earner} (preference) and
 * {@link CommissionPayout} (what a specific batch will use).
 *
 * `stripe_connect` and `crypto` (#3834) are descriptors only: this package
 * records where a payout should go and never calls a payment provider.
 */
export const PAYOUT_METHODS = [
  'bank_transfer',
  'check',
  'paypal',
  'credit',
  'other',
  'stripe_connect',
  'crypto',
] as const;
export type PayoutMethod = (typeof PAYOUT_METHODS)[number];

/**
 * Payout methods whose destination must be described by a typed
 * {@link PayoutDestination} before the earner can be `active`.
 */
export const PAYOUT_METHODS_REQUIRING_DESTINATION = [
  'stripe_connect',
  'crypto',
] as const satisfies readonly PayoutMethod[];

/**
 * A Stripe Connect connected account that receives transfers. Only the
 * public account identifier is stored — never an API key or secret.
 */
export interface StripeConnectPayoutDestination {
  method: 'stripe_connect';
  /** Connected account id (`acct_…`). */
  connectedAccountId: string;
}

/**
 * A public crypto receiving address. `network` and `asset` are open
 * lowercase/uppercase strings (`bitcoin`/`BTC`, `lightning`/`BTC`,
 * `ethereum`/`USDC`, …) so hosts choose their own rails.
 */
export interface CryptoPayoutDestination {
  method: 'crypto';
  /** Settlement network, e.g. `bitcoin`, `lightning`, `ethereum`. */
  network: string;
  /** Asset ticker on that network, e.g. `BTC`, `USDC`. */
  asset: string;
  /** Public receiving address, invoice, or payment code. */
  address: string;
  /** Optional destination tag / memo required by some networks. */
  memo?: string;
}

/** Typed payout-rail descriptor stored on an {@link Earner}. */
export type PayoutDestination =
  | StripeConnectPayoutDestination
  | CryptoPayoutDestination;

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
// Waterfall plan v2
// ---------------------------------------------------------------------------

/** A generic host-resolved recipient reference. */
export interface WaterfallRecipientDescriptor {
  kind: string;
  id?: string;
  metadata?: Record<string, unknown>;
}

/** The concrete recipient evidence returned by a host resolver. */
export interface WaterfallResolvedRecipient {
  kind: string;
  id: string;
  metadata?: Record<string, unknown>;
}

/** Declarative event facts that decide whether a step participates. */
export interface WaterfallStepConditions {
  product?: string[];
  zone?: string[];
  source?: string[];
  member?: string[];
}

/**
 * Pool distribution for a waterfall step (#3834). The step's `recipient`
 * descriptor identifies the pool and resolves through the recipient
 * registry like any other recipient; the pool's members and their metric
 * weights come from host-injected providers and are frozen in the trace.
 */
export interface WaterfallPoolSpec {
  /**
   * Metric key passed to the injected {@link MetricProvider} (for example
   * `deliveries`, `items_published`, `referrals_sent`). Omitted means equal
   * weights and no metric provider call.
   */
  metric?: string;
  /**
   * Where indivisible minor units go after the floor allocation:
   * `remainder_sink` (default) redirects them to the plan's remainder sink;
   * `largest_remainder` hands them out one unit at a time by largest
   * fractional remainder (ties: larger weight, then member `kind`, then
   * member `id`, ascending by UTF-16 code unit).
   */
  residual?: WaterfallPoolResidualRule;
  /**
   * What to do when the pool has members but every weight is zero:
   * `remainder_sink` (default) sends the whole step to the remainder sink;
   * `equal` splits it equally instead. An empty pool always uses the sink.
   */
  zeroWeight?: WaterfallPoolZeroWeightRule;
}

export const WATERFALL_POOL_RESIDUAL_RULES = [
  'remainder_sink',
  'largest_remainder',
] as const;
export type WaterfallPoolResidualRule =
  (typeof WATERFALL_POOL_RESIDUAL_RULES)[number];

export const WATERFALL_POOL_ZERO_WEIGHT_RULES = [
  'remainder_sink',
  'equal',
] as const;
export type WaterfallPoolZeroWeightRule =
  (typeof WATERFALL_POOL_ZERO_WEIGHT_RULES)[number];

/** Half-open metric measurement window, frozen as ISO-8601 strings. */
export interface WaterfallMetricPeriod {
  start: string;
  end: string;
}

/** One member's frozen weight inside a {@link WaterfallPoolSnapshot}. */
export interface WaterfallPoolMemberWeight {
  recipient: WaterfallResolvedRecipient;
  /** Non-negative safe-integer metric value (`1` for equal weights). */
  weight: number;
}

/**
 * The authoritative pool inputs for one step: the resolved pool identity,
 * its members in canonical `(kind, id)` order, and their weights. Frozen in
 * {@link WaterfallFrozenInputs.poolsByStep} so replay never re-reads metrics.
 */
export interface WaterfallPoolSnapshot {
  pool: WaterfallResolvedRecipient;
  /** `null` when the step uses equal weights. */
  metric: string | null;
  period: WaterfallMetricPeriod | null;
  members: WaterfallPoolMemberWeight[];
}

/** Request passed to a {@link MetricProvider}. */
export interface MetricProviderRequest {
  metric: string;
  pool: WaterfallResolvedRecipient;
  members: readonly WaterfallResolvedRecipient[];
  period: WaterfallMetricPeriod | null;
  event: WaterfallEvent;
}

/** One member's metric value returned by a {@link MetricProvider}. */
export interface MetricValue {
  kind: string;
  id: string;
  /** Non-negative safe integer (count, minor units, …). */
  value: number;
}

/**
 * Host-injected metric source for pool weights. Members it omits weigh
 * zero; values for non-members, duplicates, and non-integer or negative
 * values are rejected. Fractional metrics must be scaled to integers by the
 * host so allocation stays exact.
 */
export interface MetricProvider {
  getMetricValues(
    request: MetricProviderRequest,
  ): Promise<readonly MetricValue[]> | readonly MetricValue[];
}

/** Host-injected resolver for the members of a resolved pool. */
export type WaterfallPoolMembershipResolver = (
  pool: WaterfallResolvedRecipient,
  event: WaterfallEvent,
) =>
  | Promise<readonly WaterfallResolvedRecipient[]>
  | readonly WaterfallResolvedRecipient[];

/** A single ordered allocation in a version-two commission plan. */
export interface WaterfallStep {
  key: string;
  base: 'gross' | 'previous_remainder' | 'custom';
  customBaseKey?: string;
  amount:
    | { kind: 'percent'; rate: number }
    | { kind: 'fixed'; amountCents: number };
  floorCents?: number;
  capCents?: number;
  conditions?: WaterfallStepConditions;
  recipient: WaterfallRecipientDescriptor;
  /** Distribute this step across the members of the recipient pool. */
  pool?: WaterfallPoolSpec;
}

/** Version-two terms consumed by `calculateWaterfall`. */
export interface WaterfallPlan {
  planKey: string;
  version: number;
  /** Optional host tenancy identity; included in frozen replay evidence. */
  tenantId?: string | null;
  currency: string;
  steps: WaterfallStep[];
  remainderSink: WaterfallRecipientDescriptor;
  /** Already-settled checkout fees reduce this recipient's payable amount. */
  applicationFeeOffsetRecipient?: WaterfallRecipientDescriptor;
}

/** Generic immutable commercial evidence used to calculate a waterfall. */
export interface WaterfallEvent {
  grossAmountCents: number;
  currency: string;
  facts?: Record<string, string | undefined>;
  customBases?: Record<string, number>;
  applicationFeeSettledCents?: number;
}

/** Frozen authoritative inputs needed for a reproducible replay. */
export interface WaterfallFrozenInputs {
  planKey: string;
  planVersion: number;
  planFingerprint: string;
  currency: string;
  grossAmountCents: number;
  facts: Record<string, string | undefined>;
  customBases: Record<string, number>;
  recipientByStep: Record<string, WaterfallResolvedRecipient | null>;
  remainderSink: WaterfallResolvedRecipient;
  applicationFeeSettledCents: number;
  /**
   * Frozen pool inputs by step key. Present only when the plan has pool
   * steps, so traces of pool-free plans are unchanged.
   */
  poolsByStep?: Record<string, WaterfallPoolSnapshot>;
}

/** One member's allocation inside a {@link WaterfallPoolStepTrace}. */
export interface WaterfallPoolMemberTrace {
  recipient: WaterfallResolvedRecipient;
  weight: number;
  /**
   * `weight / totalWeight` as a decimal (informational; amounts are exact
   * integer arithmetic). Maps to `Commission.shareFraction` when a host
   * persists member allocations under one `splitGroupId`.
   */
  shareFraction: number;
  amountCents: number;
}

/** How a pool step was distributed. */
export interface WaterfallPoolStepTrace {
  metric: string | null;
  period: WaterfallMetricPeriod | null;
  totalWeight: number;
  /**
   * `weighted` / `equal` distributed to members; `remainder_sink` means the
   * pool was empty or every weight was zero under the default rule.
   */
  distribution: 'weighted' | 'equal' | 'remainder_sink';
  residualRule: WaterfallPoolResidualRule;
  /** Indivisible units redirected to the sink by the residual rule. */
  residualToSinkCents: number;
  members: WaterfallPoolMemberTrace[];
}

export interface WaterfallStepTrace {
  key: string;
  baseCents: number;
  amountCents: number;
  recipient: WaterfallResolvedRecipient | null;
  redirectedToSinkCents: number;
  applicationFeeOffsetCents: number;
  payableCents: number;
  skipped?: 'condition_not_met';
  /** Present for pool steps whose pool resolved. */
  pool?: WaterfallPoolStepTrace;
}

export interface WaterfallCalculationTrace {
  planKey: string;
  planVersion: number;
  currency: string;
  grossAmountCents: number;
  steps: WaterfallStepTrace[];
  remainderSink: WaterfallResolvedRecipient;
  remainderSinkCents: number;
  totalRecipientAllocatedCents: number;
  totalSinkCents: number;
  closureCents: 0;
  roundingMode: 'half_away_from_zero';
  frozenInputs: WaterfallFrozenInputs;
}

export interface WaterfallCalculationResult {
  trace: WaterfallCalculationTrace;
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
  kind?: EarnerKind;
  profileId?: string;
  displayName?: string;
  status?: EarnerStatus;
  payoutMethod?: PayoutMethod;
  payoutDestination?: string;
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
  effectiveTo?: Date | string | number | null;
  currency?: string;
  components?: string;
  steps?: string;
  remainderSink?: string;
  applicationFeeOffsetRecipient?: string;
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
  /** JSON routing snapshot captured at batch creation. */
  payoutDestination?: string;
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
