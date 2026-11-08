import { getTestDatabase } from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import { SmrtJobCollection } from '../smrt-job.js';

const upper = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
const lower = upper.toLowerCase();
for (const type of ['sqlite', 'duckdb'] as const) {
  describe(`keyed tenant UUID spelling (${type})`, () => {
    let db: DatabaseInterface;
    afterEach(async () => {
      await db?.close?.();
    });
    async function fixture() {
      db = await getTestDatabase({ type, url: ':memory:' });
      return SmrtJobCollection.create({ db });
    }
    const data = { dedupeKey: 'resource', objectType: 'Probe', method: 'run' };
    it('rejects noncanonical explicit or ambient UUID spelling before slot/job mutation', async () => {
      const jobs = await fixture();
      for (const tenantId of [upper, `{${lower}}`, lower.replaceAll('-', '')]) {
        await expect(jobs.enqueueJob({ ...data, tenantId })).rejects.toThrow(
          /canonical lowercase hyphenated UUID/,
        );
        await expect(
          withTenant({ tenantId }, () => jobs.enqueueJob(data)),
        ).rejects.toThrow(/canonical lowercase hyphenated UUID/);
      }
      expect((await db.query('SELECT id FROM _smrt_jobs')).rows).toHaveLength(
        0,
      );
      expect(
        (await db.query('SELECT id FROM _smrt_job_dedupe_slots')).rows,
      ).toHaveLength(0);
    });
    it('keeps one slot for canonical UUID inputs through native hydration, cancellation and retry', async () => {
      const jobs = await fixture();
      const first = await jobs.enqueueJob({ ...data, tenantId: lower });
      expect(first.tenantId).toBe(lower);
      await expect(
        jobs.enqueueJob({ ...data, tenantId: upper }),
      ).rejects.toThrow(/canonical lowercase hyphenated UUID/);
      expect((await jobs.enqueueJob({ ...data, tenantId: lower })).id).toBe(
        first.id,
      );
      await first.cancel();
      await first.retry();
      expect(first.status).toBe('pending');
      expect((await jobs.enqueueJob({ ...data, tenantId: lower })).id).toBe(
        first.id,
      );
    });
    it('preserves legacy nonkeyed UUID input behavior', async () => {
      const jobs = await fixture();
      const job = await jobs.enqueueJob({
        ...data,
        dedupeKey: null,
        tenantId: upper,
      });
      expect(job.tenantId).toBe(upper);
      const loaded = await jobs.get({ id: String(job.id) }, { cache: false });
      expect(loaded?.tenantId).toBe(type === 'duckdb' ? lower : upper);
    });
  });
}

describe('opaque tenant identities remain case sensitive', () => {
  let db: DatabaseInterface;
  afterEach(async () => {
    await db?.close?.();
  });
  it('keeps distinct exact-case opaque IDs instead of globally lowercasing tenant strings', async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const jobs = await SmrtJobCollection.create({ db });
    const data = { dedupeKey: 'resource', objectType: 'Probe', method: 'run' };
    const a = await jobs.enqueueJob({ ...data, tenantId: 'Tenant-A' });
    const b = await jobs.enqueueJob({ ...data, tenantId: 'tenant-a' });
    expect(a.id).not.toBe(b.id);
    expect((await jobs.enqueueJob({ ...data, tenantId: 'Tenant-A' })).id).toBe(
      a.id,
    );
    expect((await jobs.enqueueJob({ ...data, tenantId: 'tenant-a' })).id).toBe(
      b.id,
    );
  });
});
