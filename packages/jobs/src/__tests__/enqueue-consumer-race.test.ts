import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SmrtJobCollection } from '../smrt-job.js';

for (const type of ['sqlite', 'duckdb'] as const) {
  describe(`enqueue consumer race (${type})`, () => {
    let db: DatabaseInterface;
    afterEach(async () => {
      vi.restoreAllMocks();
      await db?.close?.();
    });
    it('returns after the insert without saving over an immediate consumer claim', async () => {
      db = await getTestDatabase({ type, url: ':memory:' });
      const jobs = await SmrtJobCollection.create({ db });
      const create = jobs.create.bind(jobs);
      vi.spyOn(jobs, 'create').mockImplementation(async (data) => {
        const job = await create(data);
        await jobs.claimReady({ workerId: 'immediate-consumer', limit: 1 });
        return job;
      });
      const job = await jobs.enqueueJob({ objectType: 'Probe', method: 'run' });
      const persisted = await jobs.get({ id: String(job.id) });
      expect(persisted?.status).toBe('running');
      expect(persisted?.attempts).toBe(1);
    });
  });
}
