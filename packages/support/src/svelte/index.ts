/**
 * @happyvertical/smrt-support/svelte
 *
 * Reusable Svelte 5 surfaces for Managed Support: a case queue and case
 * detail view (issue #1926), Service Target clocks and the explainable
 * routing ranking (issue #1929), and a time-entry approval queue (issue
 * #1930). Presentational only — hosts load data through the package services
 * and adapt models with the exported view mappers.
 *
 * @packageDocumentation
 */

import type { ComponentProps } from 'svelte';
import CaseDetail from './components/CaseDetail.svelte';
import CaseQueue from './components/CaseQueue.svelte';
import RoutingRationale from './components/RoutingRationale.svelte';
import TargetList from './components/TargetList.svelte';
import TimeEntryApprovalQueue from './components/TimeEntryApprovalQueue.svelte';

export {
  CaseDetail,
  CaseQueue,
  RoutingRationale,
  TargetList,
  TimeEntryApprovalQueue,
};
export type CaseQueueProps = ComponentProps<typeof CaseQueue>;
export type CaseDetailProps = ComponentProps<typeof CaseDetail>;
export type TargetListProps = ComponentProps<typeof TargetList>;
export type RoutingRationaleProps = ComponentProps<typeof RoutingRationale>;
export type TimeEntryApprovalQueueProps = ComponentProps<
  typeof TimeEntryApprovalQueue
>;

export {
  type CaseTimelineItemView,
  caseStatusBadgeKey,
  humanizeStatus,
  priorityBadgeKey,
  type RankedSpecialistView,
  type ServiceTargetView,
  type SupportCaseView,
  type SupportTimeEntryView,
  type SupportWorkLinkView,
  targetStatusBadgeKey,
  timeEntryStatusBadgeKey,
  toCaseTimelineItemView,
  toServiceTargetView,
  toSupportCaseView,
  toSupportTimeEntryView,
} from './types.js';
