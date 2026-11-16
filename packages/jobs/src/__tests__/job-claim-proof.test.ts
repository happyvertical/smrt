import { randomUUID } from 'node:crypto';
import { getTestDatabase, SmrtObject, smrt } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertAbandonedJobClaim,
  assertFailedJobDispatch,
  assertJobClaim,
  assertJobClaimForRelease,
  type JobClaim,
  JobClaimLostError,
} from '../job-claim.js';
import { JobHandle } from '../job-handle.js';
import { getJobClaim, TaskRunner } from '../runner.js';
import { SmrtJobCollection } from '../smrt-job.js';
import { SmrtWorkerCollection } from '../smrt-worker.js';
import {
  terminalSnapshot,
  transitionTerminalJob,
} from '../terminal-outcome.js';
import {
  registerLiveWorker,
  unregisterLiveWorker,
} from '../worker-liveness.js';

let captured: Readonly<JobClaim> | undefined;
@smrt()
class ClaimContextProbe extends SmrtObject {
  async execute(_args: unknown, context: unknown) {
    captured = getJobClaim(context);
    return 'done';
  }
}

describe('transaction-bound job claim proof', () => {
  let db: DatabaseInterface;
  let claim: JobClaim;
  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const jobs = await SmrtJobCollection.create({ db });
    await jobs.enqueueJob({
      objectType: 'ClaimProofProbe',
      objectId: randomUUID(),
      method: 'execute',
    });
    const [job] = await jobs.claimReady({
      workerId: 'incarnation',
      limit: 1,
      claimFencing: true,
    });
    claim = {
      jobId: job.id as string,
      workerId: 'incarnation',
      attempt: job.attempts,
      startedAt: job.startedAt?.toISOString() as string,
      tenantId: null,
      objectType: job.objectType,
      objectId: job.objectId,
      method: job.method,
    };
    await db.query('CREATE TABLE proof_writes (value TEXT)');
  });
  afterEach(async () => {
    await db.close?.();
  });

  it.each([
    'object',
    'handle',
  ])('preserves %s cancellation when a runner claims after the read', async (path) => {
    const jobs = await SmrtJobCollection.create({ db });
    const pending = await jobs.enqueueJob({
      objectType: 'ClaimProofProbe',
      method: 'execute',
      queue: 'cancel-race',
    });
    // Prepare schema before injecting the exact read -> claim -> cancel ordering.
    await jobs
      .enqueueJob({
        objectType: 'ClaimProofProbe',
        method: 'execute',
        queue: 'prepare',
      })
      .then((job) => job.cancel());
    const original = db.transaction!.bind(db);
    const spy = vi
      .spyOn(db, 'transaction')
      .mockImplementationOnce(async (callback) => {
        const [claimed] = await jobs.claimReady({
          workerId: 'racing-worker',
          queues: ['cancel-race'],
        });
        expect(claimed.id).toBe(pending.id);
        expect(claimed.attempts).toBe(1);
        return original(callback);
      });
    try {
      if (path === 'object') await pending.cancel();
      else await new JobHandle(pending.id as string, jobs).cancel();
      expect((await jobs.get({ id: pending.id as string }))?.status).toBe(
        'cancelled',
      );
      const outcomes = await db.query(
        'SELECT data FROM _smrt_job_events WHERE job_id = ?',
        pending.id,
      );
      expect(JSON.parse(String(outcomes.rows[0].data)).attempts).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('proves a claim on the transaction used for application commit', async () => {
    await db.transaction?.(async (tx) => {
      await assertJobClaim(tx, claim);
      await tx.query("INSERT INTO proof_writes VALUES ('committed')");
    });
    expect((await db.query('SELECT * FROM proof_writes')).rows).toHaveLength(1);
  });

  it('rolls back application writes when claim assertion fails', async () => {
    await expect(
      db.transaction?.(async (tx) => {
        await tx.query("INSERT INTO proof_writes VALUES ('rolled back')");
        await assertJobClaim(tx, { ...claim, attempt: 2 });
      }),
    ).rejects.toBeInstanceOf(JobClaimLostError);
    expect((await db.query('SELECT * FROM proof_writes')).rows).toEqual([]);
  });

  it.each([
    { workerId: 'replacement' },
    { attempt: 2 },
    { tenantId: randomUUID() },
    { objectId: randomUUID() },
    { objectType: 'OtherProbe' },
    { method: 'other' },
    { jobId: randomUUID() },
    { attempt: 0 },
    { workerId: '' },
  ])('denies mismatched identity %j', async (patch) => {
    await expect(
      db.transaction?.((tx) => assertJobClaim(tx, { ...claim, ...patch })),
    ).rejects.toBeInstanceOf(JobClaimLostError);
  });

  it.each([
    'running',
    'completed',
    'cancelled',
    'failed',
  ])('permits settled release for the same %s attempt', async (status) => {
    await db.query(
      'UPDATE _smrt_jobs SET status = ? WHERE id = ?',
      status,
      claim.jobId,
    );
    await db.transaction?.((tx) => assertJobClaimForRelease(tx, claim));
    if (status !== 'running') {
      await expect(
        db.transaction?.((tx) => assertJobClaim(tx, claim)),
      ).rejects.toBeInstanceOf(JobClaimLostError);
    }
    expect(
      (
        await db.query(
          'SELECT status FROM _smrt_jobs WHERE id = ?',
          claim.jobId,
        )
      ).rows[0].status,
    ).toBe(status);
  });

  it.each([
    'pending',
    'unknown',
  ])('denies release for status %s', async (status) => {
    await db.query(
      'UPDATE _smrt_jobs SET status = ? WHERE id = ?',
      status,
      claim.jobId,
    );
    await expect(
      db.transaction?.((tx) => assertJobClaimForRelease(tx, claim)),
    ).rejects.toBeInstanceOf(JobClaimLostError);
  });

  it('denies a recovered or replaced claim even after it settles', async () => {
    await db.query(
      "UPDATE _smrt_jobs SET status = 'failed', worker_id = NULL WHERE id = ?",
      claim.jobId,
    );
    await expect(
      db.transaction?.((tx) => assertJobClaimForRelease(tx, claim)),
    ).rejects.toBeInstanceOf(JobClaimLostError);
    await db.query(
      "UPDATE _smrt_jobs SET status = 'completed', worker_id = 'next', attempts = 2 WHERE id = ?",
      claim.jobId,
    );
    await expect(
      db.transaction?.((tx) => assertJobClaimForRelease(tx, claim)),
    ).rejects.toBeInstanceOf(JobClaimLostError);
  });

  it('matches non-null tenants and null object targets exactly', async () => {
    const tenantId = randomUUID();
    await db.query(
      'UPDATE _smrt_jobs SET tenant_id = ?, object_id = NULL WHERE id = ?',
      tenantId,
      claim.jobId,
    );
    await db.transaction?.((tx) =>
      assertJobClaim(tx, { ...claim, tenantId, objectId: null }),
    );
    await expect(
      db.transaction?.((tx) => assertJobClaim(tx, claim)),
    ).rejects.toBeInstanceOf(JobClaimLostError);
  });

  it('captures immutable dispatch identity from a real runner', async () => {
    const jobs = await SmrtJobCollection.create({ db });
    const job = await jobs.enqueueJob({
      objectType: 'ClaimContextProbe',
      method: 'execute',
      queue: 'context',
    });
    const runner = new TaskRunner({
      claimFencing: true,
      queues: ['context'],
      pollInterval: 10,
      retention: false,
    });
    await runner.initialize(db);
    try {
      const completed = new Promise<void>((resolve) =>
        runner.once('job:completed', () => resolve()),
      );
      await runner.start();
      await completed;
      expect(captured).toMatchObject({
        jobId: job.id,
        attempt: 1,
        objectType: 'ClaimContextProbe',
        objectId: null,
        tenantId: null,
        method: 'execute',
      });
      expect(captured?.workerId).toBeTruthy();
      expect(Object.isFrozen(captured)).toBe(true);
      await db.transaction?.((tx) =>
        assertJobClaimForRelease(tx, captured as JobClaim),
      );
    } finally {
      await runner.stop();
    }
  });

  it('preserves default retry and frozen-clock claim behavior without opt-in', async () => {
    const jobs = await SmrtJobCollection.create({ db });
    const job = await jobs.enqueueJob({
      objectType: 'ClaimProofProbe',
      method: 'execute',
      queue: 'legacy',
    });
    const now = new Date(Date.now() + 60_000);
    const [first] = await jobs.claimReady({
      workerId: 'legacy-worker',
      queues: ['legacy'],
      now,
    });
    await first.cancel();
    await first.retry();
    expect(first.startedAt).toBeNull();
    expect(
      (await jobs.listReady({ queues: ['legacy'] })).map((j) => j.id),
    ).toContain(job.id);
    const [second] = await jobs.claimReady({
      workerId: 'legacy-worker',
      queues: ['legacy'],
      now,
    });
    expect(second.startedAt?.getTime()).toBe(now.getTime());
    expect(second.attempts).toBe(1);
  });

  it('does not expose claim proofs from a runner that did not opt in', async () => {
    const jobs = await SmrtJobCollection.create({ db });
    const job = await jobs.enqueueJob({
      objectType: 'ClaimContextProbe',
      method: 'execute',
      queue: 'legacy-context',
      maxAttempts: 1,
    });
    const runner = new TaskRunner({
      queues: ['legacy-context'],
      pollInterval: 10,
      retention: false,
    });
    await runner.initialize(db);
    try {
      const failed = new Promise<Error>((resolve) =>
        runner.once('job:failed', (_job, error) => resolve(error)),
      );
      await runner.start();
      expect((await failed).message).toContain('claimFencing: true');
      expect((await jobs.get({ id: job.id as string }))?.status).toBe('failed');
    } finally {
      await runner.stop();
    }
  });

  it.each([
    0, -60_000,
  ])('fences retry and same-worker re-claim without deferral at clock delta %s', async (delta) => {
    const jobs = await SmrtJobCollection.create({ db });
    const job = await jobs.enqueueJob({
      objectType: 'ClaimProofProbe',
      method: 'execute',
      queue: 'generation',
    });
    const now = new Date(Date.now() + 120_000);
    const [first] = await jobs.claimReady({
      workerId: 'same-worker',
      queues: ['generation'],
      claimFencing: true,
      now,
    });
    const old: JobClaim = {
      jobId: first.id as string,
      workerId: 'same-worker',
      attempt: first.attempts,
      startedAt: first.startedAt?.toISOString() as string,
      tenantId: null,
      objectType: first.objectType,
      objectId: null,
      method: 'execute',
    };
    const snapshot = terminalSnapshot(first, true);
    await first.cancel();
    await first.retry();
    expect(first.startedAt).toBeNull(); // unchanged public retry semantics
    const [second] = await jobs.claimReady({
      workerId: 'same-worker',
      queues: ['generation'],
      claimFencing: true,
      now: new Date(now.getTime() + delta),
    });
    expect(second.attempts).toBe(old.attempt);
    expect(second.workerId).toBe(old.workerId);
    expect(second.startedAt?.getTime()).toBe(Date.parse(old.startedAt) + 1);
    expect(
      await transitionTerminalJob(db, {
        job: snapshot as NonNullable<typeof snapshot>,
        status: 'completed',
        completedAt: new Date(),
        expectedStatuses: ['running'],
        expectedWorkerId: 'same-worker',
      }),
    ).toBeNull();
    for (const assert of [assertJobClaim, assertJobClaimForRelease]) {
      await expect(
        db.transaction?.((tx) => assert(tx, old)),
      ).rejects.toBeInstanceOf(JobClaimLostError);
    }
  });

  it('locks only the same failed dispatch and rejects retry/reclaim and tenant mismatch', async () => {
    const jobs = await SmrtJobCollection.create({ db });
    const job = await jobs.get({ id: claim.jobId });
    if (!job) throw new Error('Missing fixture job');
    await job.cancel();
    job.status = 'failed';
    await job.save();
    await db.transaction?.((tx) => assertFailedJobDispatch(tx, claim));
    await expect(
      db.transaction?.((tx) =>
        assertFailedJobDispatch(tx, { ...claim, tenantId: randomUUID() }),
      ),
    ).rejects.toBeInstanceOf(JobClaimLostError);
    await job.retry();
    await expect(
      db.transaction?.((tx) => assertFailedJobDispatch(tx, claim)),
    ).rejects.toBeInstanceOf(JobClaimLostError);
  });

  it('rejects a later failed dispatch by a different worker even when start and attempt coincide', async () => {
    const jobs = await SmrtJobCollection.create({ db });
    const first = await jobs.get({ id: claim.jobId });
    if (!first) throw new Error('Missing fixture job');
    await first.cancel();
    await first.retry(); // matches legacy retry clearing the stored timestamp
    const [later] = await jobs.claimReady({
      workerId: 'different-incarnation',
      claimFencing: true,
      now: new Date(claim.startedAt),
    });
    expect(later.startedAt?.toISOString()).toBe(claim.startedAt);
    expect(later.attempts).toBe(claim.attempt);
    later.status = 'failed';
    await later.save();
    await expect(
      db.transaction?.((tx) => assertFailedJobDispatch(tx, claim)),
    ).rejects.toBeInstanceOf(JobClaimLostError);
    await db.transaction?.((tx) =>
      assertFailedJobDispatch(tx, {
        ...claim,
        workerId: 'different-incarnation',
      }),
    );
    await db.query(
      'UPDATE _smrt_jobs SET worker_id = NULL WHERE id = ?',
      claim.jobId,
    );
    await expect(
      db.transaction?.((tx) =>
        assertFailedJobDispatch(tx, {
          ...claim,
          workerId: 'different-incarnation',
        }),
      ),
    ).rejects.toBeInstanceOf(JobClaimLostError);
  });

  it('proves abandonment only for the exact terminal claim with no live process or fresh worker lease', async () => {
    await expect(
      db.transaction?.((tx) => assertAbandonedJobClaim(tx, claim)),
    ).rejects.toBeInstanceOf(JobClaimLostError);
    const jobs = await SmrtJobCollection.create({ db });
    const job = await jobs.get({ id: claim.jobId });
    await job?.cancel();
    registerLiveWorker(claim.workerId);
    try {
      await expect(
        db.transaction?.((tx) => assertAbandonedJobClaim(tx, claim)),
      ).rejects.toBeInstanceOf(JobClaimLostError);
    } finally {
      unregisterLiveWorker(claim.workerId);
    }
    const workers = await SmrtWorkerCollection.create({ db });
    await workers.registerWorker({
      workerKey: claim.workerId,
      leaseTtlMs: 60000,
    });
    await expect(
      db.transaction?.((tx) => assertAbandonedJobClaim(tx, claim)),
    ).rejects.toBeInstanceOf(JobClaimLostError);
    await workers.expireWorker(claim.workerId);
    await db.transaction?.((tx) => assertAbandonedJobClaim(tx, claim));
    await expect(
      db.transaction?.((tx) =>
        assertAbandonedJobClaim(tx, {
          ...claim,
          startedAt: new Date(0).toISOString(),
        }),
      ),
    ).rejects.toBeInstanceOf(JobClaimLostError);
  });

  it('rejects forged execution contexts', () => {
    expect(() => getJobClaim({ job: claim })).toThrow('TaskRunner context');
  });
});
