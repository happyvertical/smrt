import { getTestDatabase } from '@happyvertical/smrt-core';
import { expect, it } from 'vitest';
import { assertJobClaim } from '../job-claim.js';
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
      const [job] = await jobs.claimReady({
        workerId: 'pg-worker',
        limit: 1,
        claimFencing: true,
      });
      await db.transaction?.((tx) =>
        assertJobClaim(tx, {
          jobId: job.id as string,
          workerId: 'pg-worker',
          attempt: job.attempts,
          startedAt: job.startedAt?.toISOString() as string,
          tenantId: null,
          objectType: job.objectType,
          objectId: null,
          method: 'run',
        }),
      );
      await job.cancel();
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
