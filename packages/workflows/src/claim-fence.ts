import type { AiRunClaimFence } from '@happyvertical/smrt-core';
import { assertJobClaim, type JobClaim } from '@happyvertical/smrt-jobs';

/**
 * Claim fencing for a workflow run worked from a background job: every
 * checkpoint save, step start and reservation asserts, inside its own
 * transaction, that this worker still holds the job's claim
 * (`getJobClaim(context)` from a runner started with `claimFencing: true`).
 * A worker whose claim was taken over is refused before it writes.
 */
export function workflowClaimFence(claim: Readonly<JobClaim>): AiRunClaimFence {
  return (tx) => assertJobClaim(tx, claim);
}
