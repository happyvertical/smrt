import { getTestDatabase } from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import { SmrtJobCollection } from '../smrt-job.js';
import { SmrtJobDedupeSlot } from '../smrt-job-dedupe-slot.js';

const tenantA = '11111111-1111-4111-8111-111111111111';
const tenantB = '22222222-2222-4222-8222-222222222222';
for (const type of ['sqlite', 'duckdb'] as const) {
  describe(`job deterministic dedupe (${type})`, () => {
    let db: DatabaseInterface;
    afterEach(async () => {
      await db?.close?.();
    });
    async function fixture() {
      db = await getTestDatabase({ type, url: ':memory:' });
      return SmrtJobCollection.create({ db });
    }
    const data = {
      objectType: 'Probe',
      method: 'run',
      dedupeKey: 'project:1:in-flight',
    };
    it('returns the same nonterminal job, then admits a new job after cancellation', async () => {
      const jobs = await fixture();
      const defaults = new SmrtJobDedupeSlot({ db });
      expect(defaults.slotKey).toBe('');
      expect(defaults.jobId).toBeNull();
      const first = await jobs.enqueueJob(data);
      const repeated = await jobs.enqueueJob({
        ...data,
        args: { ignored: true },
      });
      expect(repeated.id).toBe(first.id);
      expect(repeated.dedupeKey).toBe(data.dedupeKey);
      await first.cancel();
      const next = await jobs.enqueueJob(data);
      expect(next.id).not.toBe(first.id);
      expect((await db.query('SELECT id FROM _smrt_jobs')).rows).toHaveLength(
        2,
      );
    });
    it('serializes simultaneous creators and guards manual retry against a newer reservation', async () => {
      const jobs = await fixture();
      const results = await Promise.all(
        Array.from({ length: 5 }, () => jobs.enqueueJob(data)),
      );
      expect(new Set(results.map((job) => job.id)).size).toBe(1);
      const first = results[0];
      await first.cancel();
      const next = await jobs.enqueueJob(data);
      await expect(first.retry()).rejects.toThrow('already reserves');
      await next.cancel();
      await first.retry();
      expect((await jobs.enqueueJob(data)).id).toBe(first.id);
    });
    it('partitions keys by tenant and rejects a forged ambient tenant', async () => {
      const jobs = await fixture();
      const a = await withTenant({ tenantId: tenantA }, () =>
        jobs.enqueueJob(data),
      );
      const b = await withTenant({ tenantId: tenantB }, () =>
        jobs.enqueueJob(data),
      );
      expect(a.id).not.toBe(b.id);
      await expect(
        withTenant({ tenantId: tenantA }, () =>
          jobs.enqueueJob({ ...data, tenantId: tenantB }),
        ),
      ).rejects.toThrow();
    });
    it('rolls back both slot and job with the caller transaction', async () => {
      await fixture();
      if (!db.transaction) throw new Error('transaction support required');
      await expect(
        db.transaction(async (tx) => {
          const jobs = await SmrtJobCollection.create({ db: tx });
          await jobs.enqueueJob(data, { transaction: tx });
          throw new Error('rollback caller');
        }),
      ).rejects.toThrow('rollback caller');
      expect((await db.query('SELECT id FROM _smrt_jobs')).rows).toHaveLength(
        0,
      );
      expect(
        (await db.query('SELECT id FROM _smrt_job_dedupe_slots')).rows,
      ).toHaveLength(0);
      const jobs = await SmrtJobCollection.create({ db });
      expect((await jobs.enqueueJob(data)).id).toBeTruthy();
    });
    it('rejects malformed keys and preserves ordinary unkeyed enqueue', async () => {
      const jobs = await fixture();
      for (const dedupeKey of ['', '  ', 'a'.repeat(513), 2]) {
        await expect(
          jobs.enqueueJob({ ...data, dedupeKey } as typeof data),
        ).rejects.toThrow('dedupeKey');
      }
      const first = await jobs.enqueueJob({ ...data, dedupeKey: null });
      const second = await jobs.enqueueJob({ ...data, dedupeKey: null });
      expect(second.id).not.toBe(first.id);
    });
  });
}
