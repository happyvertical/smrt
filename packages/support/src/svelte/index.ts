/**
 * @happyvertical/smrt-support/svelte
 *
 * Reusable Svelte 5 surfaces for Managed Support (issue #1926): a case queue
 * and a case detail view. Presentational only — hosts load data through the
 * package services and adapt models with the exported view mappers.
 *
 * @packageDocumentation
 */

import type { ComponentProps } from 'svelte';
import CaseDetail from './components/CaseDetail.svelte';
import CaseQueue from './components/CaseQueue.svelte';

export { CaseDetail, CaseQueue };
export type CaseQueueProps = ComponentProps<typeof CaseQueue>;
export type CaseDetailProps = ComponentProps<typeof CaseDetail>;

export {
  type CaseTimelineItemView,
  caseStatusBadgeKey,
  humanizeStatus,
  priorityBadgeKey,
  type SupportCaseView,
  type SupportWorkLinkView,
  toCaseTimelineItemView,
  toSupportCaseView,
} from './types.js';
