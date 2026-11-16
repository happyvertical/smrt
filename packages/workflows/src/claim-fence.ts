import {
  type AiRunClaimFence,
  aiRunEngine,
  lockAiRunChain,
} from '@happyvertical/smrt-core';
import {
  assertJobClaim,
  assertJobClaimForRelease,
  type JobClaim,
  JobClaimLostError,
  SmrtJobCollection,
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
 * worker's own attempt in any state, and refuses a claim another worker took
 * over and a job that a newer job of the same run (same dedupe key; stale
 * recovery keeps the worker on the failed row) replaced
 * (`WorkflowRunOptions.stopFence`). It locks the durable run's chain, root
 * first (the page's lock order, so a settle on the same chain cannot
 * deadlock with it), before it looks for a newer job: a resume commits the
 * run's status and its new job together while holding that row, so the look
 * sees the new job once the resume has committed (on PostgreSQL each
 * statement reads what committed before it).
 */
export function workflowStopFence(claim: Readonly<JobClaim>): AiRunClaimFence {
  return async (tx, durableRunId) => {
    await assertJobClaimForRelease(tx, claim);
    // Root first down to the durable run: `FOR UPDATE` on PostgreSQL.
    await lockAiRunChain(
      { db: tx, engine: aiRunEngine(tx), now: new Date() },
      durableRunId,
    );
    // A no-op write on the durable row, already locked: on DuckDB it makes
    // a concurrent resume's write of that row conflict; SQLite serializes
    // its writers anyway.
    await tx.query(
      'UPDATE _smrt_ai_runs SET retain = retain WHERE id = ?',
      durableRunId,
    );
    const jobs = await SmrtJobCollection.create({ db: tx });
    const own = await jobs.get({ id: claim.jobId });
    if (!own?.dedupeKey) return;
    const active = await jobs.list({
      where: {
        objectType: claim.objectType,
        dedupeKey: own.dedupeKey,
        tenantId: claim.tenantId,
        status: ['pending', 'running'],
      },
    });
    if (active.some((job) => String(job.id) !== claim.jobId)) {
      throw new JobClaimLostError();
    }
  };
}
