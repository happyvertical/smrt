import type { AiRunClaimFence } from '@happyvertical/smrt-core';
import {
  assertJobClaim,
  assertJobClaimForRelease,
  type JobClaim,
} from '@happyvertical/smrt-jobs';

/**
 * Claim fencing for a workflow run worked from a background job: every
 * checkpoint save, step start, reservation, event and status change asserts,
 * inside its own transaction, that this worker still holds the job's claim
 * (`getJobClaim(context)` from a runner started with `claimFencing: true`).
 * A worker whose claim was taken over is refused before it writes.
 */
export function workflowClaimFence(claim: Readonly<JobClaim>): AiRunClaimFence {
  return (tx) => assertJobClaim(tx, claim);
}

/**
 * The fence of the stop a worker writes when its job's signal aborts: the
 * job may already be settled (cancelled, timed out), so this one accepts the
 * worker's own attempt in any state and refuses only a claim another worker
 * took over (`WorkflowRunOptions.stopFence`).
 */
export function workflowStopFence(claim: Readonly<JobClaim>): AiRunClaimFence {
  return (tx) => assertJobClaimForRelease(tx, claim);
}
