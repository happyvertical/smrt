import type { DatabaseInterface } from '@happyvertical/sql';
import { SmrtWorkerCollection } from './smrt-worker.js';
import { isWorkerAlive } from './worker-liveness.js';

/** Captured worker incarnation and attempt, never reconstructed from a later read. */
export interface JobClaim {
  jobId: string;
  workerId: string;
  attempt: number;
  /** Monotonic dispatch timestamp for this opted-in worker incarnation. */
  startedAt: string;
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
 * This does not grant tenant authority; claims come from trusted runner context
 * with claimFencing enabled. Never reuse a worker incarnation across processes.
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
    !claim.startedAt ||
    !Number.isFinite(Date.parse(claim.startedAt)) ||
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
      WHERE id = ? AND worker_id = ? AND attempts = ? AND started_at = ? AND object_type = ?
        AND method = ? AND ${tenant} AND ${target} AND ${status} RETURNING id`,
    claim.jobId,
    claim.workerId,
    claim.attempt,
    claim.startedAt,
    claim.objectType,
    claim.method,
    ...(claim.tenantId === null ? [] : [claim.tenantId]),
    ...(claim.objectId === null ? [] : [claim.objectId]),
  );
  if (result.rows.length !== 1) throw new JobClaimLostError();
}

/** A dispatch remains identifiable after recovery clears its worker ownership. */
export type JobDispatch = Omit<JobClaim, 'workerId'>;

/**
 * Lock a failed dispatch for atomic recovery/admission in a caller transaction.
 * A retry, new dispatch, tenant or target change rejects the captured snapshot.
 * This is a state fence, not an application permission or recovery authorization.
 * @param transaction - Transaction also used for the caller's checkpoint/admission.
 * @param dispatch - Exact failed dispatch observed by the trusted host.
 */
export async function assertFailedJobDispatch(
  transaction: DatabaseInterface,
  dispatch: Readonly<JobDispatch>,
): Promise<void> {
  if (
    !dispatch.startedAt ||
    !Number.isFinite(Date.parse(dispatch.startedAt)) ||
    !Number.isSafeInteger(dispatch.attempt) ||
    dispatch.attempt < 1
  )
    throw new JobClaimLostError();
  const tenant =
    dispatch.tenantId === null ? 'tenant_id IS NULL' : 'tenant_id = ?';
  const target =
    dispatch.objectId === null ? 'object_id IS NULL' : 'object_id = ?';
  const result = await transaction.query(
    `UPDATE _smrt_jobs SET updated_at = updated_at
       WHERE id = ? AND status = 'failed' AND attempts = ? AND started_at = ?
         AND object_type = ? AND method = ? AND ${tenant} AND ${target} RETURNING id`,
    dispatch.jobId,
    dispatch.attempt,
    dispatch.startedAt,
    dispatch.objectType,
    dispatch.method,
    ...(dispatch.tenantId === null ? [] : [dispatch.tenantId]),
    ...(dispatch.objectId === null ? [] : [dispatch.objectId]),
  );
  if (result.rows.length !== 1) throw new JobClaimLostError();
}

/**
 * Prove an exact terminal dispatch abandoned under TaskRunner's worker-liveness
 * contract. Use only for an application lease already bound to this claim.
 * Job cancellation alone is not settlement; a live process or fresh worker lease
 * rejects release. The job row stays locked until the caller commits.
 * Worker liveness is an unlocked observation, exactly as in stale recovery:
 * neither the worker lease row nor future renewals are locked out. Expiry is
 * not proof that a paused process or external effect physically stopped.
 * Application writes must remain claim-fenced and replayed effects idempotent.
 * @param transaction - Transaction that also CAS-releases the application lease.
 * @param claim - Persisted identity of the dispatch that acquired that lease.
 */
export async function assertAbandonedJobClaim(
  transaction: DatabaseInterface,
  claim: Readonly<JobClaim>,
): Promise<void> {
  await assertJobClaimForRelease(transaction, claim);
  const current = await transaction.query(
    'SELECT status FROM _smrt_jobs WHERE id = ?',
    claim.jobId,
  );
  if (current.rows[0]?.status === 'running') throw new JobClaimLostError();
  const workers = await SmrtWorkerCollection.create({ db: transaction });
  if (isWorkerAlive(claim.workerId, await workers.freshLeaseWorkerKeys()))
    throw new JobClaimLostError();
}
