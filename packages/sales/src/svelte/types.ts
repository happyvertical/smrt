/**
 * Presentational view models and pure helpers for the sales Svelte surfaces.
 *
 * The components are props-driven and presentational: hosts map their model
 * rows (CRM, referrals, commissions) onto these plain view-model interfaces
 * and wire the action callbacks. Only STATUS UNIONS are imported from the
 * sibling TS modules — type-only, so the compiled Svelte bundle never gains a
 * runtime dependency on the model/collection code. Monetary fields stay
 * integer cents in every view model; conversion to display strings happens at
 * render time via `format.ts`.
 *
 * Dashboard math, award validation, and status flows live here as exported
 * pure functions so they are unit-testable without mounting components.
 *
 * @module
 */

import type {
  CommissionAdjustmentKind,
  CommissionBasis,
  CommissionPayoutStatus,
  CommissionStatus,
  EarnerBalance,
  PayoutMethod,
} from '../commissions/index.js';
import type { LeadStatus, OpportunityStatus } from '../crm/index.js';
import type {
  AttributionAward,
  AttributionExceptionStatus,
  ReferralAgreementApprovalMode,
  ReferralAgreementStatus,
  ReferralLinkStatus,
  ReferralStatus,
  ReferralTouchKind,
} from '../referrals/index.js';
import { formatCents, formatPercent } from './format.js';

// Re-export (type-only) the shapes components accept directly, so hosts can
// type their mappers against the svelte barrel alone.
export type { AttributionAward, EarnerBalance };

/** Date-ish view-model field: hosts may pass `Date`s or ISO strings. */
export type DateInput = Date | string | null;

/** Badge variant vocabulary (structurally matches `@happyvertical/smrt-ui`). */
export type StatusBadgeVariant =
  | 'default'
  | 'primary'
  | 'success'
  | 'warning'
  | 'error'
  | 'info';

// ─────────────────────────────────────────────────────────────────────────────
// CRM view models
// ─────────────────────────────────────────────────────────────────────────────

/** One assignable sales representative for owner pickers. */
export interface SalesRepOptionView {
  id: string;
  name: string;
}

/** Open next action attached to a lead/opportunity. */
export interface NextActionView {
  summary: string;
  dueAt?: DateInput;
}

/** Row of {@link LeadList}. */
export interface LeadListItemView {
  id: string;
  name: string;
  contactName?: string;
  email?: string;
  phone?: string;
  organizationName?: string;
  /** Human label for the acquisition source (`sourceKind`/`sourceId`). */
  sourceLabel?: string;
  ownerRepId?: string;
  ownerName?: string;
  status: LeadStatus;
  /** Set on terminal `merged` leads — id of the surviving lead. */
  mergedIntoId?: string;
  /** Earliest open next action, if any. */
  nextAction?: NextActionView | null;
}

/** Pipeline stage (ordered) for board columns and stage pickers. */
export interface PipelineStageView {
  id: string;
  name: string;
  /** Default win probability of the stage (0–1). */
  probability?: number;
  /** Terminal-won stage. */
  isWon?: boolean;
  /** Terminal-lost stage. */
  isLost?: boolean;
}

/** Opportunity card for {@link OpportunityBoard} and dashboard math. */
export interface OpportunityCardView {
  id: string;
  name: string;
  stageId: string;
  ownerName?: string;
  expectedValueCents: number;
  currency: string;
  /** Win probability (0–1). */
  probability: number;
  status: OpportunityStatus;
}

/** Activity/next-action row for the {@link OpportunityDetail} timeline. */
export interface SalesActivityView {
  id: string;
  /** Open-string kind (`note`, `call`, `stage_change`, …). */
  activityKind: string;
  summary: string;
  dueAt?: DateInput;
  completedAt?: DateInput;
  actorName?: string;
}

/** Recorded downstream conversion link (client/project/contract/…). */
export interface ConversionLinkView {
  id: string;
  targetKind: string;
  targetId: string;
  note?: string;
  /** Optional host-provided navigation target for the downstream record. */
  href?: string;
}

/** Header/facts view for {@link OpportunityDetail}. */
export interface OpportunityDetailView {
  id: string;
  name: string;
  status: OpportunityStatus;
  stageId: string;
  stageName?: string;
  ownerName?: string;
  expectedValueCents: number;
  currency: string;
  /** Win probability (0–1). */
  probability: number;
  expectedCloseAt?: DateInput;
  /** Outcome note (conventionally set when closing lost). */
  outcomeReason?: string;
  wonAt?: DateInput;
  lostAt?: DateInput;
}

/** Terminal outcome accepted by `OpportunityDetail`'s `onClose`. */
export type ClosedOpportunityOutcome = Exclude<OpportunityStatus, 'open'>;

/** Draft passed to `OpportunityDetail`'s `onRecordActivity`. */
export interface RecordActivityDraft {
  activityKind: string;
  summary: string;
  /** ISO date (`YYYY-MM-DD`) from the date input, when scheduled. */
  dueAt?: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Referral view models
// ─────────────────────────────────────────────────────────────────────────────

/** Row of {@link ReferralLinkManager}. */
export interface ReferralLinkView {
  id: string;
  code: string;
  label?: string;
  targetUrl?: string;
  clickCount: number;
  status: ReferralLinkStatus;
}

/** Draft passed to `ReferralLinkManager`'s `onCreate`. */
export interface CreateReferralLinkDraft {
  targetUrl: string;
  label?: string;
}

/** Row of {@link ReferralStatusList} (referrer portal). */
export interface ReferralStatusView {
  id: string;
  status: ReferralStatus;
  targetKind: string;
  /** Optional human label for the qualifying target. */
  targetLabel?: string;
  /** Credit share of this referral (0–1; `1` when unsplit). */
  creditFraction: number;
  /** Present when the referral shares credit with siblings. */
  splitGroupId?: string;
  programName?: string;
  attributedAt?: DateInput;
  qualifiedAt?: DateInput;
  expiresAt?: DateInput;
}

/** One competing touch inside an {@link AttributionExceptionView}. */
export interface AttributionCandidateView {
  touchId: string;
  referrerId: string;
  referrerName?: string;
  kind: ReferralTouchKind;
  /** ISO-8601 timestamp of the candidate touch. */
  occurredAt: string;
}

/** Conflict-review row for {@link AttributionConflictQueue}. */
export interface AttributionExceptionView {
  id: string;
  status: AttributionExceptionStatus;
  targetKind: string;
  targetId: string;
  targetLabel?: string;
  programName?: string;
  conflictReason: string;
  candidates: AttributionCandidateView[];
  /** Resolved-audit fields (set once `status === 'resolved'`). */
  resolutionMode?: string;
  resolutionReason?: string;
  resolvedByName?: string;
  resolvedAt?: DateInput;
}

// ─────────────────────────────────────────────────────────────────────────────
// Commission / settlement view models
// ─────────────────────────────────────────────────────────────────────────────

/** Append-only adjustment rendered under its commission row. */
export interface CommissionAdjustmentView {
  id: string;
  adjustmentKind: CommissionAdjustmentKind;
  /** Signed integer cents — clawbacks are negative. */
  amountCents: number;
  currency: string;
  reason: string;
  createdAt?: DateInput;
}

/** Snapshotted calculation explanation for one commission row. */
export interface CommissionTraceView {
  planKey: string;
  planVersion: number;
  componentKey: string;
}

/** Row of {@link CommissionBreakdown} — the explainable-amount surface. */
export interface CommissionRowView {
  id: string;
  /** Earning-event kind (`conversion`, `invoice_payment`, …). */
  eventKind: string;
  /** Human label for the earning source (`sourceKind`/`sourceId`). */
  sourceLabel?: string;
  basis: CommissionBasis;
  baseAmountCents: number;
  /** Rate applied (0–1; `0` for fixed-basis components). */
  rate: number;
  /** Split share applied (0–1; `1` when unsplit). */
  shareFraction: number;
  amountCents: number;
  currency: string;
  status: CommissionStatus;
  /** When the clearing window ends and the earning can mature. */
  clearingEndsAt?: DateInput;
  /** Parsed calculation-trace references (plan key@version, component). */
  trace?: CommissionTraceView | null;
  /** Adjustments appended against this commission. */
  adjustments?: CommissionAdjustmentView[];
}

/** Settlement batch for {@link PayoutHistoryList} / {@link PayoutBatchReview}. */
export interface PayoutView {
  id: string;
  periodStart?: DateInput;
  periodEnd?: DateInput;
  commissionTotalCents: number;
  /** Signed integer cents. */
  adjustmentTotalCents: number;
  /** Net batch total (commission + adjustments), signed. */
  totalAmountCents: number;
  currency: string;
  payoutMethod: PayoutMethod;
  status: CommissionPayoutStatus;
  paymentReference?: string;
  providerRef?: string;
  paidAt?: DateInput;
  notes?: string;
}

/** Payout row with the earner identity, for operator review. */
export interface PayoutBatchReviewItemView extends PayoutView {
  earnerName?: string;
}

/** Agreement version row for {@link ExecutedAgreementsList}. */
export interface AgreementVersionView {
  id: string;
  version: number;
  status: ReferralAgreementStatus;
  effectiveFrom?: DateInput;
  effectiveTo?: DateInput;
  planKey: string;
  planVersion: number;
  clearingDays: number;
  approvalMode: ReferralAgreementApprovalMode;
  /** Executed-artifact evidence, when the agreement has been executed. */
  artifactUrl?: string;
  artifactHash?: string;
}

/** Pre-aggregated operator reconciliation row for {@link CommissionExpenseSummary}. */
export interface CommissionExpenseRowView {
  /** Stable row key (e.g. `2026-06:USD` or a program/plan id). */
  id: string;
  /** Human label for the row (period, program, plan, …). */
  label: string;
  currency: string;
  /** Accrued commission expense in the period (integer cents). */
  commissionExpenseCents: number;
  /** Signed unsettled/settled adjustments in the period. */
  adjustmentCents: number;
  /** Amount settled to earners via payouts in the period. */
  payoutCents: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Status → badge-variant mappers (pure)
// ─────────────────────────────────────────────────────────────────────────────

/** Badge variant for a Lead lifecycle status. */
export function leadStatusBadgeVariant(status: LeadStatus): StatusBadgeVariant {
  switch (status) {
    case 'new':
      return 'info';
    case 'working':
      return 'primary';
    case 'qualified':
      return 'success';
    case 'disqualified':
      return 'error';
    default:
      return 'default';
  }
}

/** Badge variant for an Opportunity lifecycle status. */
export function opportunityStatusBadgeVariant(
  status: OpportunityStatus,
): StatusBadgeVariant {
  switch (status) {
    case 'won':
      return 'success';
    case 'lost':
      return 'error';
    default:
      return 'info';
  }
}

/** Badge variant for a Referral lifecycle status. */
export function referralStatusBadgeVariant(
  status: ReferralStatus,
): StatusBadgeVariant {
  switch (status) {
    case 'attributed':
      return 'info';
    case 'qualified':
      return 'success';
    case 'disqualified':
      return 'error';
    case 'expired':
      return 'warning';
    case 'under_review':
      return 'warning';
    default:
      return 'default';
  }
}

/** Badge variant for a ReferralLink status. */
export function referralLinkStatusBadgeVariant(
  status: ReferralLinkStatus,
): StatusBadgeVariant {
  return status === 'active' ? 'success' : 'default';
}

/** Badge variant for a Commission settlement-chain status. */
export function commissionStatusBadgeVariant(
  status: CommissionStatus,
): StatusBadgeVariant {
  switch (status) {
    case 'earned':
      return 'info';
    case 'approved':
      return 'primary';
    case 'payable':
      return 'warning';
    case 'paid':
      return 'success';
    default:
      return 'default';
  }
}

/** Badge variant for a CommissionPayout batch status. */
export function payoutStatusBadgeVariant(
  status: CommissionPayoutStatus,
): StatusBadgeVariant {
  switch (status) {
    case 'approved':
      return 'info';
    case 'processing':
      return 'warning';
    case 'completed':
      return 'success';
    case 'failed':
    case 'rejected':
      return 'error';
    default:
      return 'default';
  }
}

/** Badge variant for a ReferralAgreement version status. */
export function agreementStatusBadgeVariant(
  status: ReferralAgreementStatus,
): StatusBadgeVariant {
  switch (status) {
    case 'active':
      return 'success';
    case 'superseded':
      return 'warning';
    case 'terminated':
      return 'error';
    default:
      return 'default';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CRM helpers (pure)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Whether the qualify action applies to a lead in `status` — mirrors the
 * `new|working → qualified` transitions guarded by the Lead model.
 */
export function canQualifyLead(status: LeadStatus): boolean {
  return status === 'new' || status === 'working';
}

/** Whether a next action is overdue relative to `now` (default: current time). */
export function isOverdue(
  dueAt: DateInput | undefined,
  now: Date = new Date(),
): boolean {
  if (dueAt == null || dueAt === '') return false;
  const due = dueAt instanceof Date ? dueAt : new Date(dueAt);
  if (Number.isNaN(due.getTime())) return false;
  return due.getTime() < now.getTime();
}

/** A per-currency integer-cents total (pipeline sums never mix currencies). */
export interface CurrencyAmount {
  currency: string;
  amountCents: number;
}

/** Count of opportunities still `open`. */
export function openOpportunityCount(
  opportunities: OpportunityCardView[],
): number {
  return opportunities.filter((o) => o.status === 'open').length;
}

/**
 * Total expected value of OPEN opportunities, grouped per currency (sorted by
 * currency code) — currencies are never summed together.
 */
export function openPipelineTotals(
  opportunities: OpportunityCardView[],
): CurrencyAmount[] {
  const totals = new Map<string, number>();
  for (const opportunity of opportunities) {
    if (opportunity.status !== 'open') continue;
    totals.set(
      opportunity.currency,
      (totals.get(opportunity.currency) ?? 0) + opportunity.expectedValueCents,
    );
  }
  return [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, amountCents]) => ({ currency, amountCents }));
}

/** Per-stage open-pipeline summary for the dashboard tiles. */
export interface StagePipelineSummary {
  stageId: string;
  stageName: string;
  openCount: number;
  totals: CurrencyAmount[];
}

/**
 * Open-pipeline expected value per stage, in the given stage order. Terminal
 * stages report zero (their opportunities are no longer `open`).
 */
export function pipelineValueByStage(
  stages: PipelineStageView[],
  opportunities: OpportunityCardView[],
): StagePipelineSummary[] {
  return stages.map((stage) => {
    const open = opportunities.filter(
      (o) => o.stageId === stage.id && o.status === 'open',
    );
    return {
      stageId: stage.id,
      stageName: stage.name,
      openCount: open.length,
      totals: openPipelineTotals(open),
    };
  });
}

/**
 * Win rate over CLOSED opportunities: `won / (won + lost)`, or `null` when
 * nothing has closed yet (so the tile can render a placeholder, not `0%`).
 */
export function winRate(opportunities: OpportunityCardView[]): number | null {
  let won = 0;
  let lost = 0;
  for (const opportunity of opportunities) {
    if (opportunity.status === 'won') won += 1;
    else if (opportunity.status === 'lost') lost += 1;
  }
  const closed = won + lost;
  return closed === 0 ? null : won / closed;
}

/** One rendered board column: a stage and its opportunities. */
export interface BoardColumn {
  stage: PipelineStageView;
  opportunities: OpportunityCardView[];
}

/**
 * Group opportunities into the given stage order for the board. Opportunities
 * pointing at a stage not present in `stages` are omitted — the board renders
 * exactly the columns it is given.
 */
export function groupOpportunitiesByStage(
  stages: PipelineStageView[],
  opportunities: OpportunityCardView[],
): BoardColumn[] {
  return stages.map((stage) => ({
    stage,
    opportunities: opportunities.filter((o) => o.stageId === stage.id),
  }));
}

/** Neighbouring stage ids for keyboard-accessible next/prev stage movement. */
export function adjacentStageIds(
  stages: PipelineStageView[],
  stageId: string,
): { prevStageId: string | null; nextStageId: string | null } {
  const index = stages.findIndex((stage) => stage.id === stageId);
  if (index === -1) return { prevStageId: null, nextStageId: null };
  return {
    prevStageId: index > 0 ? stages[index - 1].id : null,
    nextStageId: index < stages.length - 1 ? stages[index + 1].id : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Referral helpers (pure)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Share URL for a referral code: `<shareBaseUrl>/<code>` (trailing slashes on
 * the base are normalised; the code is URL-encoded).
 */
export function buildShareUrl(shareBaseUrl: string, code: string): string {
  const base = shareBaseUrl.replace(/\/+$/, '');
  return `${base}/${encodeURIComponent(code)}`;
}

/** Loose http(s) URL check used to gate the create-link form. */
export function isHttpUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim());
}

/**
 * Tolerance for award credit fractions summing to 1.0 — mirrors
 * `AttributionService.assertAwards` (±0.0001).
 */
export const AWARD_FRACTION_TOLERANCE = 0.0001;

/** Result of {@link validateAwards} for inline form validation. */
export interface AwardValidation {
  valid: boolean;
  /** Raw sum of the entered fractions. */
  totalFraction: number;
  /** Human-readable problem when invalid. */
  message?: string;
}

/**
 * Validate an award draft the way `AttributionService.resolveException` will:
 * at least one award, distinct referrers, every fraction in (0, 1], and the
 * fractions summing to 1.0 (±{@link AWARD_FRACTION_TOLERANCE}).
 */
export function validateAwards(awards: AttributionAward[]): AwardValidation {
  if (awards.length === 0) {
    return {
      valid: false,
      totalFraction: 0,
      message: 'At least one award is required.',
    };
  }
  const seen = new Set<string>();
  let sum = 0;
  for (const award of awards) {
    if (!award.referrerId) {
      return {
        valid: false,
        totalFraction: sum,
        message: 'Every award needs a referrer.',
      };
    }
    if (seen.has(award.referrerId)) {
      return {
        valid: false,
        totalFraction: sum,
        message: 'Each referrer may receive at most one award.',
      };
    }
    seen.add(award.referrerId);
    if (
      !Number.isFinite(award.creditFraction) ||
      award.creditFraction <= 0 ||
      award.creditFraction > 1
    ) {
      return {
        valid: false,
        totalFraction: sum,
        message: 'Each credit fraction must be greater than 0 and at most 1.',
      };
    }
    sum += award.creditFraction;
  }
  if (Math.abs(sum - 1) > AWARD_FRACTION_TOLERANCE) {
    return {
      valid: false,
      totalFraction: sum,
      message: `Credit fractions must sum to 100% — currently ${formatPercent(sum)}.`,
    };
  }
  return { valid: true, totalFraction: sum };
}

/** Distinct candidate referrer ids, in first-seen order. */
export function uniqueCandidateReferrerIds(
  candidates: AttributionCandidateView[],
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.referrerId)) continue;
    seen.add(candidate.referrerId);
    ids.push(candidate.referrerId);
  }
  return ids;
}

/**
 * Seed an equal split across `referrerIds`, rounded to 4 decimal places with
 * the LAST share adjusted so the set sums to exactly 1.0 (mirrors the
 * AttributionService split convention).
 */
export function equalSplitAwards(referrerIds: string[]): AttributionAward[] {
  const count = referrerIds.length;
  if (count === 0) return [];
  const share = Math.round(10000 / count) / 10000;
  return referrerIds.map((referrerId, index) => ({
    referrerId,
    creditFraction:
      index === count - 1
        ? Math.round((1 - share * (count - 1)) * 10000) / 10000
        : share,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Commission / settlement helpers (pure)
// ─────────────────────────────────────────────────────────────────────────────

/** `planKey@vN` display reference for snapshotted plan versions. */
export function formatPlanRef(planKey: string, planVersion: number): string {
  return `${planKey}@v${planVersion}`;
}

/** Inputs for the explainable `base × rate × share = amount` formula line. */
export interface CommissionFormulaParts {
  basis: CommissionBasis;
  baseAmountCents: number;
  rate: number;
  shareFraction: number;
  amountCents: number;
  currency: string;
}

/**
 * Render the snapshotted calculation as a one-line formula. Fixed-basis
 * components have no rate factor (`rate` is recorded as `0`), so the line
 * becomes `base (fixed) × share = amount`.
 */
export function formatCommissionFormula(
  parts: CommissionFormulaParts,
  locale?: string,
): string {
  const base = formatCents(parts.baseAmountCents, parts.currency, locale);
  const share = formatPercent(parts.shareFraction, locale);
  const amount = formatCents(parts.amountCents, parts.currency, locale);
  if (parts.basis === 'fixed') {
    return `${base} (fixed) × ${share} = ${amount}`;
  }
  return `${base} × ${formatPercent(parts.rate, locale)} × ${share} = ${amount}`;
}

/** One step of a payout status timeline. */
export interface PayoutTimelineStep {
  status: CommissionPayoutStatus;
  state: 'done' | 'current' | 'upcoming';
}

/**
 * Linear settlement timeline for a payout batch. The happy path is
 * `pending → approved → processing → completed`; for a `failed` batch the
 * terminal marker replaces `completed`, and a `rejected` batch collapses to
 * the decline it actually took (`pending → rejected`).
 */
export function payoutStatusTimeline(
  status: CommissionPayoutStatus,
): PayoutTimelineStep[] {
  const path: CommissionPayoutStatus[] =
    status === 'rejected'
      ? ['pending', 'rejected']
      : status === 'failed'
        ? ['pending', 'approved', 'processing', 'failed']
        : ['pending', 'approved', 'processing', 'completed'];
  const index = path.indexOf(status);
  return path.map((step, i) => ({
    status: step,
    state: i < index ? 'done' : i === index ? 'current' : 'upcoming',
  }));
}

/** Which operator actions apply to a payout batch in a given status. */
export interface PayoutActions {
  canApprove: boolean;
  canMarkProcessing: boolean;
  canComplete: boolean;
  canFail: boolean;
  canReject: boolean;
}

/**
 * Action gating for {@link PayoutBatchReview}, mirroring the CommissionPayout
 * transition guard: `pending → approved → processing → completed | failed`,
 * with `failed` reachable from `approved`/`processing` and the terminal
 * decline `rejected` reachable from `pending`/`approved`.
 */
export function payoutActionsFor(
  status: CommissionPayoutStatus,
): PayoutActions {
  return {
    canApprove: status === 'pending',
    canMarkProcessing: status === 'approved',
    canComplete: status === 'processing',
    canFail: status === 'approved' || status === 'processing',
    canReject: status === 'pending' || status === 'approved',
  };
}

/** Per-currency totals of {@link CommissionExpenseRowView} rows. */
export interface CommissionExpenseTotals {
  currency: string;
  commissionExpenseCents: number;
  adjustmentCents: number;
  payoutCents: number;
  /** `expense + adjustments − payouts`: outstanding accrued liability. */
  netAccruedCents: number;
}

/**
 * Sum reconciliation rows per currency (sorted by currency code). Currencies
 * are never summed together.
 */
export function sumExpenseRowsByCurrency(
  rows: CommissionExpenseRowView[],
): CommissionExpenseTotals[] {
  const byCurrency = new Map<
    string,
    { expense: number; adjustments: number; payouts: number }
  >();
  for (const row of rows) {
    const entry = byCurrency.get(row.currency) ?? {
      expense: 0,
      adjustments: 0,
      payouts: 0,
    };
    entry.expense += row.commissionExpenseCents;
    entry.adjustments += row.adjustmentCents;
    entry.payouts += row.payoutCents;
    byCurrency.set(row.currency, entry);
  }
  return [...byCurrency.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, { expense, adjustments, payouts }]) => ({
      currency,
      commissionExpenseCents: expense,
      adjustmentCents: adjustments,
      payoutCents: payouts,
      netAccruedCents: expense + adjustments - payouts,
    }));
}
