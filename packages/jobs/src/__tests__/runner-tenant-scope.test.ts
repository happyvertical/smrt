import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskRunner } from '../runner.js';
import { SmrtJobCollection } from '../smrt-job.js';

const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';
for (const type of ['sqlite', 'duckdb'] as const) {
  describe(`worker tenant scope (${type})`, () => {
    let db: DatabaseInterface;
    afterEach(async () => {
      await db?.close?.();
    });
    it('bounds claims before ownership mutation and treats empty scopes as none', async () => {
      db = await getTestDatabase({ type, url: ':memory:' });
      const jobs = await SmrtJobCollection.create({ db });
      for (const tenantId of [a, b, null])
        await jobs.enqueueJob({
          tenantId,
          queue: 'isolated',
          objectType: 'Probe',
          method: 'run',
        });
      expect(
        await jobs.claimReady({ workerId: 'none', tenantIds: [] }),
      ).toHaveLength(0);
      const claimed = await jobs.claimReady({
        workerId: 'allowed',
        tenantIds: [a],
        queues: ['isolated'],
      });
      expect(claimed.map((job) => job.tenantId)).toEqual([a]);
      expect(
        (await jobs.listReady({ tenantIds: [b] })).map((job) => job.tenantId),
      ).toEqual([b]);
      expect(
        (await jobs.listReady({ tenantIds: [null] })).map(
          (job) => job.tenantId,
        ),
      ).toEqual([null]);
    });
    it('leaves foreign tenant and foreign queue orphan rows untouched', async () => {
      db = await getTestDatabase({ type, url: ':memory:' });
      const jobs = await SmrtJobCollection.create({ db });
      const own = await jobs.enqueueJob({
        tenantId: a,
        queue: 'isolated',
        objectType: 'Probe',
        method: 'run',
      });
      const foreign = await jobs.enqueueJob({
        tenantId: b,
        queue: 'isolated',
        objectType: 'Probe',
        method: 'run',
      });
      const otherQueue = await jobs.enqueueJob({
        tenantId: a,
        queue: 'other',
        objectType: 'Probe',
        method: 'run',
      });
      await db.query(
        "UPDATE _smrt_jobs SET status = 'running', worker_id = 'dead-worker'",
      );
      const none = new TaskRunner({ tenantIds: [], queues: ['isolated'] });
      await none.initialize(db);
      await (
        none as unknown as { recoverStaleJobs(): Promise<void> }
      ).recoverStaleJobs();
      expect((await jobs.get({ id: String(own.id) }))?.status).toBe('running');
      const runner = new TaskRunner({ tenantIds: [a], queues: ['isolated'] });
      await runner.initialize(db);
      await (
        runner as unknown as { recoverStaleJobs(): Promise<void> }
      ).recoverStaleJobs();
      expect((await jobs.get({ id: String(own.id) }))?.status).toBe('failed');
      expect((await jobs.get({ id: String(foreign.id) }))?.status).toBe(
        'running',
      );
      expect((await jobs.get({ id: String(otherQueue.id) }))?.status).toBe(
        'running',
      );
    });
  });
}
