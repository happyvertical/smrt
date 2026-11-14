import type { DatabaseInterface } from '@happyvertical/sql';

/** Captured worker incarnation and attempt, never reconstructed from a later read. */
export interface JobClaim {
  jobId: string;
  workerId: string;
  attempt: number;
  tenantId: string | null;
  objectType: string;
  objectId: string | null;
  method: string;
}

/** The captured execution can no longer authorize a caller's transaction. */
export class JobClaimLostError extends Error {
  constructor() {
    super('Job claim is no longer current');
    this.name = 'JobClaimLostError';
  }
}

/**
 * Lock and prove a live claim inside the caller's transaction. Keep subsequent
 * application writes on this same transaction and propagate any rejection.
 * This does not grant tenant authority; claims come from trusted runner context.
 *
 * @param transaction - Caller-owned transaction, not a pool/root connection.
 * @param claim - Identity captured when the runner dispatched this attempt.
 */
export async function assertJobClaim(
  transaction: DatabaseInterface,
  claim: Readonly<JobClaim>,
): Promise<void> {
  await assertClaim(transaction, claim, false);
}

/**
 * Authorize release of an application lease after its original promise settles.
 * Accepts the same running or terminal attempt, including cancellation after
 * Stop. Rejects pending/recovered/reclaimed jobs. Does not change job status or
 * expire the runner's process lease: return from the handler to park its job.
 *
 * @param transaction - Transaction that also clears the application's lease.
 * @param claim - The original captured claim, retained through settlement.
 */
export async function assertJobClaimForRelease(
  transaction: DatabaseInterface,
  claim: Readonly<JobClaim>,
): Promise<void> {
  await assertClaim(transaction, claim, true);
}

async function assertClaim(
  transaction: DatabaseInterface,
  claim: Readonly<JobClaim>,
  settled: boolean,
): Promise<void> {
  if (
    !claim.jobId ||
    !claim.workerId ||
    !claim.objectType ||
    !claim.method ||
    !Number.isSafeInteger(claim.attempt) ||
    claim.attempt < 1
  )
    throw new JobClaimLostError();
  const tenant =
    claim.tenantId === null ? 'tenant_id IS NULL' : 'tenant_id = ?';
  const target =
    claim.objectId === null ? 'object_id IS NULL' : 'object_id = ?';
  const status = settled
    ? "status IN ('running', 'cancelled', 'completed', 'failed')"
    : "status = 'running'";
  // An UPDATE locks the row on PostgreSQL and serializes SQLite writers; a
  // SELECT alone would leave a gap between ownership proof and domain commit.
  const result = await transaction.query(
    `UPDATE _smrt_jobs SET updated_at = updated_at
      WHERE id = ? AND worker_id = ? AND attempts = ? AND object_type = ?
        AND method = ? AND ${tenant} AND ${target} AND ${status} RETURNING id`,
    claim.jobId,
    claim.workerId,
    claim.attempt,
    claim.objectType,
    claim.method,
    ...(claim.tenantId === null ? [] : [claim.tenantId]),
    ...(claim.objectId === null ? [] : [claim.objectId]),
  );
  if (result.rows.length !== 1) throw new JobClaimLostError();
}
