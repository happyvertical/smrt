import { getTestDatabase } from '@happyvertical/smrt-core';
import { expect, it } from 'vitest';
import {
  assertJobClaim,
  assertJobClaimForRelease,
  JobClaimLostError,
} from '../job-claim.js';
import { SmrtJobCollection } from '../smrt-job.js';
import { SmrtJobEventCollection } from '../smrt-job-event.js';
import {
  enablePgliteJobs,
  offLoopEligible,
  resolveEngine,
} from '../worker-liveness.js';

it.runIf(Boolean(process.env.SMRT_TEST_PGLITE_MODULE))(
  'uses PostgreSQL claims and exact outcome lookup on the documented SDK PGlite fixture',
  async () => {
    const db = await getTestDatabase({
      type: 'pglite',
      classes: ['SmrtJob', 'SmrtJobEvent', 'SmrtJobDedupeSlot'],
    });
    try {
      enablePgliteJobs(db);
      expect(resolveEngine(db)).toBe('postgres');
      expect(offLoopEligible(db)).toBe(false);
      const jobs = await SmrtJobCollection.create({ db });
      await jobs.enqueueJob({ objectType: 'PgliteProof', method: 'run' });
      const now = new Date(Date.now() + 120_000);
      const [job] = await jobs.claimReady({
        now,
        workerId: 'pg-worker',
        limit: 1,
        claimFencing: true,
      });
      const claim = {
        jobId: job.id as string,
        workerId: 'pg-worker',
        attempt: job.attempts,
        startedAt: job.startedAt?.toISOString() as string,
        tenantId: null,
        objectType: job.objectType,
        objectId: null,
        method: 'run',
      };
      await db.transaction?.((tx) => assertJobClaim(tx, claim));
      await job.cancel();
      await job.retry();
      expect(job.startedAt).toBeNull();
      const [replacement] = await jobs.claimReady({
        workerId: 'pg-worker',
        limit: 1,
        claimFencing: true,
        now: new Date(now.getTime() - 60_000),
      });
      expect(replacement.startedAt?.getTime()).toBe(
        Date.parse(claim.startedAt) + 1,
      );
      for (const assert of [assertJobClaim, assertJobClaimForRelease]) {
        await expect(
          db.transaction?.((tx) => assert(tx, claim)),
        ).rejects.toBeInstanceOf(JobClaimLostError);
      }
      await replacement.cancel();
      const events = await SmrtJobEventCollection.create({ db });
      expect(
        await events.getTerminalOutcome(job.id as string, { tenantId: null }),
      ).toMatchObject({ status: 'cancelled' });
    } finally {
      await db.close?.();
    }
  },
);

it('does not change engine or ticker selection merely because a client looks like PGlite', () => {
  const client = { dumpDataDir() {} };
  const db = {
    url: ':memory:',
    client,
  } as unknown as import('@happyvertical/sql').DatabaseInterface;
  expect(resolveEngine(db)).toBe('sqlite');
  expect(offLoopEligible(db)).toBe(false);
  enablePgliteJobs(db);
  expect(resolveEngine(db)).toBe('postgres');
  expect(offLoopEligible(db)).toBe(false);
  // Transaction handles share the SDK client, so the explicit choice follows it.
  expect(resolveEngine({ ...db })).toBe('postgres');
  expect(() =>
    enablePgliteJobs({ url: ':memory:', client: {} } as typeof db),
  ).toThrow('PGlite client');
});
