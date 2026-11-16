import { getTestDatabase } from '@happyvertical/smrt-core';
import { expect, it } from 'vitest';
import { SmrtJobCollection } from '../smrt-job.js';
import { SmrtJobEventCollection } from '../smrt-job-event.js';
import {
  terminalSnapshot,
  transitionTerminalJob,
} from '../terminal-outcome.js';
import { enablePgliteJobs } from '../worker-liveness.js';

const tenantId = '11111111-1111-4111-8111-111111111111';

for (const engine of ['sqlite', 'pglite'] as const) {
  it.skipIf(engine === 'pglite' && !process.env.SMRT_TEST_PGLITE_MODULE)(
    `accepts a stale pending snapshot without opt-in fencing (${engine})`,
    async () => {
      const db = await getTestDatabase({
        type: engine,
        ...(engine === 'sqlite' ? { url: ':memory:' } : {}),
        classes: ['SmrtJob', 'SmrtJobEvent'],
      });
      try {
        if (engine === 'pglite') enablePgliteJobs(db);
        const jobs = await SmrtJobCollection.create({ db });
        const events = await SmrtJobEventCollection.create({ db });
        const job = await jobs.create({
          tenantId,
          queue: 'reports',
          objectType: 'SmrtDataSurfaceActionTask',
          method: 'run',
        });
        const snapshot = terminalSnapshot(job);
        if (!snapshot) throw new Error('Expected persisted job');
        await db.query(
          `UPDATE _smrt_jobs
              SET status = 'running', attempts = 2, worker_id = 'worker-a'
            WHERE id = ?`,
          job.id,
        );

        // Exact compatibility case from terminal-outcome-postgres.optional:
        // worker ownership is checked, but dispatch fencing was not requested.
        expect(
          await transitionTerminalJob(db, {
            job: snapshot,
            status: 'cancelled',
            completedAt: new Date(),
            expectedStatuses: ['running'],
            expectedWorkerId: 'worker-a',
          }),
        ).not.toBeNull();
        expect((await jobs.get({ id: job.id }))?.status).toBe('cancelled');
        expect(
          (await events.listTerminalOutcomes({ tenantId })).outcomes,
        ).toMatchObject([{ status: 'cancelled', attempts: 2 }]);

        expect(
          await transitionTerminalJob(db, {
            job: {
              ...snapshot,
              tenantId: '22222222-2222-4222-8222-222222222222',
            },
            status: 'failed',
            completedAt: new Date(),
            expectedStatuses: ['cancelled'],
            failureKind: 'execution',
          }),
        ).toBeNull();
        expect(
          (await events.listTerminalOutcomes({ tenantId })).outcomes,
        ).toHaveLength(1);
      } finally {
        await db.close?.();
      }
    },
  );
}
