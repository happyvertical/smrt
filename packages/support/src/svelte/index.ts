/**
 * @happyvertical/smrt-support/svelte
 *
 * Reusable Svelte 5 surfaces for Managed Support (issues #1926/#1930): a case
 * queue, a case detail view, and a time-entry approval queue. Presentational
 * only — hosts load data through the package services and adapt models with
 * the exported view mappers.
 *
 * @packageDocumentation
 */

import type { ComponentProps } from 'svelte';
import CaseDetail from './components/CaseDetail.svelte';
import CaseQueue from './components/CaseQueue.svelte';
import TimeEntryApprovalQueue from './components/TimeEntryApprovalQueue.svelte';

export { CaseDetail, CaseQueue, TimeEntryApprovalQueue };
export type CaseQueueProps = ComponentProps<typeof CaseQueue>;
export type CaseDetailProps = ComponentProps<typeof CaseDetail>;
export type TimeEntryApprovalQueueProps = ComponentProps<
  typeof TimeEntryApprovalQueue
>;

export {
  type CaseTimelineItemView,
  caseStatusBadgeKey,
  humanizeStatus,
  priorityBadgeKey,
  type SupportCaseView,
  type SupportTimeEntryView,
  type SupportWorkLinkView,
  timeEntryStatusBadgeKey,
  toCaseTimelineItemView,
  toSupportCaseView,
  toSupportTimeEntryView,
} from './types.js';
