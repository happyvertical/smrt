/**
 * @happyvertical/smrt-personas/svelte
 *
 * Optional Svelte 5 UI for the persona learning loop (#1889): a minimal
 * directive review queue. Presentational only — approval/rejection are
 * delegated to callbacks a host wires to the permission-gated
 * `DirectiveApprovalService`.
 *
 * @packageDocumentation
 */

import type { ComponentProps } from 'svelte';
import DirectiveReviewQueue from './components/DirectiveReviewQueue.svelte';

export { DirectiveReviewQueue };
export type DirectiveReviewQueueProps = ComponentProps<
  typeof DirectiveReviewQueue
>;

export {
  confidencePercent,
  type DirectiveProposalView,
  type DirectiveReviewStatus,
  statusBadgeVariant,
  toDirectiveProposalView,
} from './types.js';
