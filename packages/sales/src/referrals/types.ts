/**
 * Shared types, status unions, and contracts for the referrals module.
 *
 * Statuses are string-literal unions derived from `as const` arrays (no TS
 * enums) so the runtime lists (validation, UI pickers) and the compile-time
 * unions stay in lockstep. All monetary fields across the module are integer
 * cents with a `*Cents` suffix; rates/fractions are decimals in `0`–`1`.
 *
 * The referrals module depends on the `commissions` module (same package)
 * for the neutral financial core — Earners, CommissionPlans, EarningEvents,
 * Commissions — and NEVER on `crm`. Qualifying targets are generic
 * `(targetKind, targetId)` string pairs so a referral can point at a lead,
 * opportunity, client, project, subscription, or any application-defined
 * record without this module knowing its semantics.
 *
 * @packageDocumentation
 */

import type { SmrtObjectOptions } from '@happyvertical/smrt-core';

// ---------------------------------------------------------------------------
// Status / kind vocabularies
// ---------------------------------------------------------------------------

/** Lifecycle of a {@link ReferrerOptions | Referrer} role. */
export const REFERRER_STATUSES = ['pending', 'active', 'suspended'] as const;
export type ReferrerStatus = (typeof REFERRER_STATUSES)[number];

/** Lifecycle of a {@link ReferralProgramOptions | ReferralProgram}. */
export const REFERRAL_PROGRAM_STATUSES = [
  'draft',
  'active',
  'paused',
  'archived',
] as const;
export type ReferralProgramStatus = (typeof REFERRAL_PROGRAM_STATUSES)[number];

/**
 * Lifecycle of a versioned AttributionPolicy row.
 *
 * `draft → active | retired`; `active → superseded | retired`;
 * `superseded` / `retired` are terminal. Amendments never mutate an active
 * row — they insert a new `(policyKey, version + 1)` draft (CommissionPlan
 * pattern).
 */
export const ATTRIBUTION_POLICY_STATUSES = [
  'draft',
  'active',
  'superseded',
  'retired',
] as const;
export type AttributionPolicyStatus =
  (typeof ATTRIBUTION_POLICY_STATUSES)[number];

/**
 * How an AttributionPolicy credits touches:
 *
 * - `first_touch` — the earliest eligible touch wins.
 * - `last_touch` — the latest eligible touch wins.
 * - `assigned` — only `manual_assignment` touches count (most recent wins;
 *   competing assignments from distinct referrers raise an exception).
 * - `split` — every distinct eligible referrer receives an attributed
 *   Referral with an equal credit fraction sharing one `splitGroupId`.
 */
export const ATTRIBUTION_CREDIT_MODES = [
  'first_touch',
  'last_touch',
  'assigned',
  'split',
] as const;
export type AttributionCreditMode = (typeof ATTRIBUTION_CREDIT_MODES)[number];

/**
 * How an AttributionPolicy behaves when more than one distinct eligible
 * referrer competes: `auto` lets the credit mode decide (only genuine
 * conflicts raise exceptions); `review` forces an AttributionException for
 * any multi-referrer contention.
 */
export const ATTRIBUTION_CONFLICT_BEHAVIORS = ['auto', 'review'] as const;
export type AttributionConflictBehavior =
  (typeof ATTRIBUTION_CONFLICT_BEHAVIORS)[number];

/** Lifecycle of a ReferralLink — disabled links refuse new clicks. */
export const REFERRAL_LINK_STATUSES = ['active', 'disabled'] as const;
export type ReferralLinkStatus = (typeof REFERRAL_LINK_STATUSES)[number];

/** Kinds of immutable ReferralTouch attribution evidence. */
export const REFERRAL_TOUCH_KINDS = [
  'click',
  'code_entry',
  'manual_assignment',
  'partner_entry',
] as const;
export type ReferralTouchKind = (typeof REFERRAL_TOUCH_KINDS)[number];

/**
 * Lifecycle of a Referral. Guarded transitions (save-time, authoritative
 * prior re-read — commerce pattern):
 * `pending → attributed | under_review | disqualified | expired`;
 * `under_review → attributed | disqualified`;
 * `attributed → qualified | disqualified | expired`;
 * `qualified → disqualified` (rare clawback path);
 * `disqualified` / `expired` are terminal.
 */
export const REFERRAL_STATUSES = [
  'pending',
  'attributed',
  'qualified',
  'disqualified',
  'expired',
  'under_review',
] as const;
export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];

/** Lifecycle of an AttributionException conflict-review row. */
export const ATTRIBUTION_EXCEPTION_STATUSES = ['open', 'resolved'] as const;
export type AttributionExceptionStatus =
  (typeof ATTRIBUTION_EXCEPTION_STATUSES)[number];

/**
 * How an AttributionException was resolved: `override` (a human awarded
 * credit explicitly) or `policy` (a policy re-run settled it). Stored as an
 * open string on the model; this list is the recommended vocabulary.
 */
export const ATTRIBUTION_RESOLUTION_MODES = ['override', 'policy'] as const;
export type AttributionResolutionMode =
  (typeof ATTRIBUTION_RESOLUTION_MODES)[number];

/**
 * Lifecycle of a versioned ReferralAgreement row.
 *
 * `draft → active | terminated`; `active → superseded | terminated`;
 * `superseded` / `terminated` are terminal.
 */
export const REFERRAL_AGREEMENT_STATUSES = [
  'draft',
  'active',
  'superseded',
  'terminated',
] as const;
export type ReferralAgreementStatus =
  (typeof REFERRAL_AGREEMENT_STATUSES)[number];

/**
 * How commissions earned under an agreement are approved downstream:
 * `manual` (an operator approves each earning) or `auto`. Recorded on the
 * agreement and frozen into every ReferralTermSnapshot.
 */
export const REFERRAL_AGREEMENT_APPROVAL_MODES = ['manual', 'auto'] as const;
export type ReferralAgreementApprovalMode =
  (typeof REFERRAL_AGREEMENT_APPROVAL_MODES)[number];

// ---------------------------------------------------------------------------
// Attribution-exception candidates
// ---------------------------------------------------------------------------

/**
 * One competing touch recorded in an AttributionException's `candidates`
 * JSON array — enough to review the conflict without re-querying touches.
 */
export interface AttributionExceptionCandidate {
  /** Id of the candidate ReferralTouch (empty for touchless awards). */
  touchId: string;
  /** The referrer the touch credits. */
  referrerId: string;
  /** Kind of the candidate touch. */
  kind: ReferralTouchKind;
  /** ISO-8601 timestamp of when the candidate touch occurred. */
  occurredAt: string;
}

// ---------------------------------------------------------------------------
// Model constructor options
// ---------------------------------------------------------------------------

/** Options for constructing a Referrer. */
export interface ReferrerOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  profileId?: string;
  earnerId?: string;
  displayName?: string;
  status?: ReferrerStatus;
  metadata?: string;
}

/** Options for constructing a ReferralProgram. */
export interface ReferralProgramOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  key?: string;
  name?: string;
  status?: ReferralProgramStatus;
  defaultCommissionPlanKey?: string;
  defaultAttributionPolicyKey?: string;
  metadata?: string;
}

/** Options for constructing an AttributionPolicy. */
export interface AttributionPolicyOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  policyKey?: string;
  version?: number;
  status?: AttributionPolicyStatus;
  effectiveFrom?: Date | string | number | null;
  windowDays?: number;
  creditMode?: AttributionCreditMode;
  conflictBehavior?: AttributionConflictBehavior;
  allowSelfReferral?: boolean;
  allowExistingClients?: boolean;
  eligibleServices?: string;
  eligibleCampaigns?: string;
  eligibleRegions?: string;
  metadata?: string;
}

/** Options for constructing a ReferralLink. */
export interface ReferralLinkOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  referrerId?: string;
  programId?: string;
  code?: string;
  targetUrl?: string;
  label?: string;
  status?: ReferralLinkStatus;
  clickCount?: number;
  metadata?: string;
}

/** Options for constructing a ReferralTouch. */
export interface ReferralTouchOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  linkId?: string;
  code?: string;
  referrerId?: string;
  programId?: string;
  kind?: ReferralTouchKind;
  subjectKind?: string;
  subjectId?: string;
  occurredAt?: Date | string | number;
  evidence?: string;
  metadata?: string;
}

/** Options for constructing a Referral. */
export interface ReferralOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  referrerId?: string;
  programId?: string;
  policyKey?: string;
  policyVersion?: number;
  status?: ReferralStatus;
  targetKind?: string;
  targetId?: string;
  creditFraction?: number;
  splitGroupId?: string;
  primaryTouchId?: string;
  attributedAt?: Date | string | number | null;
  qualifiedAt?: Date | string | number | null;
  expiresAt?: Date | string | number | null;
  snapshotId?: string;
  metadata?: string;
}

/** Options for constructing an AttributionException. */
export interface AttributionExceptionOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  targetKind?: string;
  targetId?: string;
  programId?: string;
  status?: AttributionExceptionStatus;
  conflictReason?: string;
  candidates?: string;
  resolutionMode?: string;
  resolutionReason?: string;
  resolvedByProfileId?: string;
  resolvedReferralIds?: string;
  resolvedAt?: Date | string | number | null;
  metadata?: string;
}

/** Options for constructing a ReferralAgreement. */
export interface ReferralAgreementOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  referrerId?: string;
  programId?: string;
  version?: number;
  status?: ReferralAgreementStatus;
  effectiveFrom?: Date | string | number | null;
  effectiveTo?: Date | string | number | null;
  commissionPlanKey?: string;
  commissionPlanVersion?: number;
  clearingDays?: number;
  approvalMode?: ReferralAgreementApprovalMode;
  executionId?: string;
  executedAgreementId?: string;
  metadata?: string;
}

/** Options for constructing a ReferralTermSnapshot. */
export interface ReferralTermSnapshotOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  referralId?: string;
  agreementId?: string;
  agreementVersion?: number;
  planKey?: string;
  planVersion?: number;
  policyKey?: string;
  policyVersion?: number;
  components?: string;
  currency?: string;
  clearingDays?: number;
  approvalMode?: ReferralAgreementApprovalMode;
  metadata?: string;
}
