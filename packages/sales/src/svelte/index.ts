/**
 * `@happyvertical/smrt-sales/svelte` — reusable sales surfaces
 * (#1924, #1931, #1933).
 *
 * Props-driven, presentational Svelte 5 components: the CRM dashboard/list/
 * board/detail set, the referrer portal (share links, referral status,
 * earnings explanation, payout history, executed agreements), and the
 * operator surfaces (attribution conflict queue, payout batch review, and the
 * commission-expense summary kept separate from client invoices).
 *
 * No component fetches data or imports model classes — hosts map rows onto
 * the exported view-model interfaces and wire the action callbacks. Monetary
 * props stay integer cents; `format.ts` converts at render time. Everything
 * works without `@happyvertical/smrt-svelte`'s `<Provider>` (only Provider-free
 * `@happyvertical/smrt-ui` primitives are used).
 *
 * @packageDocumentation
 */

import type { ComponentProps } from 'svelte';
import AttributionConflictQueue from './components/AttributionConflictQueue.svelte';
import CommissionBreakdown from './components/CommissionBreakdown.svelte';
import CommissionExpenseSummary from './components/CommissionExpenseSummary.svelte';
import ExecutedAgreementsList from './components/ExecutedAgreementsList.svelte';
import LeadList from './components/LeadList.svelte';
import OpportunityBoard from './components/OpportunityBoard.svelte';
import OpportunityDetail from './components/OpportunityDetail.svelte';
import PayoutBatchReview from './components/PayoutBatchReview.svelte';
import PayoutHistoryList from './components/PayoutHistoryList.svelte';
import ReferralLinkManager from './components/ReferralLinkManager.svelte';
import ReferralStatusList from './components/ReferralStatusList.svelte';
import ReferrerEarningsSummary from './components/ReferrerEarningsSummary.svelte';
import SalesDashboard from './components/SalesDashboard.svelte';

// Components
export {
  AttributionConflictQueue,
  CommissionBreakdown,
  CommissionExpenseSummary,
  ExecutedAgreementsList,
  LeadList,
  OpportunityBoard,
  OpportunityDetail,
  PayoutBatchReview,
  PayoutHistoryList,
  ReferralLinkManager,
  ReferralStatusList,
  ReferrerEarningsSummary,
  SalesDashboard,
};

// Component prop types
export type AttributionConflictQueueProps = ComponentProps<
  typeof AttributionConflictQueue
>;
export type CommissionBreakdownProps = ComponentProps<
  typeof CommissionBreakdown
>;
export type CommissionExpenseSummaryProps = ComponentProps<
  typeof CommissionExpenseSummary
>;
export type ExecutedAgreementsListProps = ComponentProps<
  typeof ExecutedAgreementsList
>;
export type LeadListProps = ComponentProps<typeof LeadList>;
export type OpportunityBoardProps = ComponentProps<typeof OpportunityBoard>;
export type OpportunityDetailProps = ComponentProps<typeof OpportunityDetail>;
export type PayoutBatchReviewProps = ComponentProps<typeof PayoutBatchReview>;
export type PayoutHistoryListProps = ComponentProps<typeof PayoutHistoryList>;
export type ReferralLinkManagerProps = ComponentProps<
  typeof ReferralLinkManager
>;
export type ReferralStatusListProps = ComponentProps<typeof ReferralStatusList>;
export type ReferrerEarningsSummaryProps = ComponentProps<
  typeof ReferrerEarningsSummary
>;
export type SalesDashboardProps = ComponentProps<typeof SalesDashboard>;

// Formatting helpers
export {
  EMPTY_VALUE_PLACEHOLDER,
  formatCents,
  formatDate,
  formatPercent,
} from './format.js';
export type {
  AgreementVersionView,
  AttributionAward,
  AttributionCandidateView,
  AttributionExceptionView,
  AwardValidation,
  BoardColumn,
  ClosedOpportunityOutcome,
  CommissionAdjustmentView,
  CommissionExpenseRowView,
  CommissionExpenseTotals,
  CommissionFormulaParts,
  CommissionRowView,
  CommissionTraceView,
  ConversionLinkView,
  CreateReferralLinkDraft,
  CurrencyAmount,
  DateInput,
  EarnerBalance,
  LeadListItemView,
  NextActionView,
  OpportunityCardView,
  OpportunityDetailView,
  PayoutActions,
  PayoutBatchReviewItemView,
  PayoutTimelineStep,
  PayoutView,
  PipelineStageView,
  RecordActivityDraft,
  ReferralLinkView,
  ReferralStatusView,
  SalesActivityView,
  SalesRepOptionView,
  StagePipelineSummary,
  StatusBadgeVariant,
} from './types.js';
// View models and pure helpers
export {
  AWARD_FRACTION_TOLERANCE,
  adjacentStageIds,
  agreementStatusBadgeVariant,
  buildShareUrl,
  canQualifyLead,
  commissionStatusBadgeVariant,
  equalSplitAwards,
  formatCommissionFormula,
  formatPlanRef,
  groupOpportunitiesByStage,
  isHttpUrl,
  isOverdue,
  leadStatusBadgeVariant,
  openOpportunityCount,
  openPipelineTotals,
  opportunityStatusBadgeVariant,
  payoutActionsFor,
  payoutStatusBadgeVariant,
  payoutStatusTimeline,
  pipelineValueByStage,
  referralLinkStatusBadgeVariant,
  referralStatusBadgeVariant,
  sumExpenseRowsByCurrency,
  uniqueCandidateReferrerIds,
  validateAwards,
  winRate,
} from './types.js';
