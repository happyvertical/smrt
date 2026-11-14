import { randomUUID } from 'node:crypto';
import { getTestDatabase, SmrtObject, smrt } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertJobClaim,
  assertJobClaimForRelease,
  type JobClaim,
  JobClaimLostError,
} from '../job-claim.js';
import { getJobClaim, TaskRunner } from '../runner.js';
import { SmrtJobCollection } from '../smrt-job.js';

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
    const [job] = await jobs.claimReady({ workerId: 'incarnation', limit: 1 });
    claim = {
      jobId: job.id as string,
      workerId: 'incarnation',
      attempt: job.attempts,
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

  it('rejects forged execution contexts', () => {
    expect(() => getJobClaim({ job: claim })).toThrow('TaskRunner context');
  });
});
