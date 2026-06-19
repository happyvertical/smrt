import {
  getTestDatabase,
  ObjectRegistry,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_JOB_RETRIES,
  TenantJobCapExceededError,
} from '../background-policy.js';
import { JobBuilder } from '../job-builder.js';
import { withBackgroundJobs } from '../object-extension.js';
import { SmrtJobCollection } from '../smrt-job.js';

@smrt()
class CapProbe extends SmrtObject {
  async work(): Promise<string> {
    return 'done';
  }
}

afterEach(() => {
  ObjectRegistry.clearCollectionCache?.();
});

/**
 * Regression for S5 audit #1402 (MED): a single tenant must not be able to
 * enqueue an unbounded number of jobs and exhaust the shared worker pool.
 */
describe('per-tenant job creation cap', () => {
  function builder(collection: SmrtJobCollection, cap: number) {
    return new JobBuilder(
      'CapProbe',
      'probe-1',
      'work',
      {},
      collection,
    ).tenantJobCap(cap);
  }

  it('blocks enqueue once the tenant is at its in-flight cap', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const collection = await SmrtJobCollection.create({ db });

    await withTenant({ tenantId: 'tenant-cap' }, async () => {
      await builder(collection, 2).enqueue();
      await builder(collection, 2).enqueue();

      await expect(builder(collection, 2).enqueue()).rejects.toBeInstanceOf(
        TenantJobCapExceededError,
      );
    });

    const count = await collection.countInFlightForTenant('tenant-cap');
    expect(count).toBe(2);
  });

  it('does not cap global (no tenant context) jobs', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const collection = await SmrtJobCollection.create({ db });

    await builder(collection, 1).enqueue();
    // Second global job exceeds the numeric cap but must still succeed,
    // because the cap applies only to tenant-owned jobs.
    await expect(builder(collection, 1).enqueue()).resolves.toBeDefined();
  });

  it('does not count terminal jobs toward the cap', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const collection = await SmrtJobCollection.create({ db });

    const job = await withTenant({ tenantId: 'tenant-cap' }, async () =>
      builder(collection, 1)
        .enqueue()
        .then((h) => h.getJob()),
    );
    job.status = 'completed';
    await job.save();

    // The completed job no longer counts, so a new one is allowed.
    await withTenant({ tenantId: 'tenant-cap' }, async () => {
      await expect(builder(collection, 1).enqueue()).resolves.toBeDefined();
    });
  });
});

/**
 * Regression for S5 audit #1402 (Codex, round 3): `background()` returns a lazy
 * proxy cast to `JobBuilder`, but the proxy did not implement `tenantJobCap()`,
 * so `doc.background(...).tenantJobCap(0).enqueue()` threw
 * `TypeError: tenantJobCap is not a function`. The proxy must mirror the
 * fluent method AND forward the override to the real builder at enqueue().
 */
describe('lazy background() proxy forwards tenantJobCap', () => {
  const CapBgProbe = withBackgroundJobs(CapProbe);

  it('exposes tenantJobCap() on the proxy (no TypeError)', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const probe = new CapBgProbe({ db });
    await probe.initialize();

    const proxy = probe.background('work', {});
    expect(typeof proxy.tenantJobCap).toBe('function');
    // Chaining returns the same fluent proxy.
    expect(proxy.tenantJobCap(5)).toBe(proxy);
  });

  it('forwards an explicit cap so the proxy path enforces it', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const probe = new CapBgProbe({ db });
    await probe.initialize();

    await withTenant({ tenantId: 'proxy-cap-tenant' }, async () => {
      await probe.background('work', {}).tenantJobCap(1).enqueue();
      // Second enqueue under the same tenant exceeds the forwarded cap of 1.
      await expect(
        probe.background('work', {}).tenantJobCap(1).enqueue(),
      ).rejects.toBeInstanceOf(TenantJobCapExceededError);
    });
  });

  it('disables the cap when tenantJobCap(0) is forwarded', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const probe = new CapBgProbe({ db });
    await probe.initialize();

    await withTenant({ tenantId: 'proxy-uncapped-tenant' }, async () => {
      // 0 disables the cap for trusted internal callers — many enqueues succeed.
      await probe.background('work', {}).tenantJobCap(0).enqueue();
      await expect(
        probe.background('work', {}).tenantJobCap(0).enqueue(),
      ).resolves.toBeDefined();
    });
  });
});

/**
 * The ScheduleRunner used to call `jobCollection.create()` directly, bypassing
 * the builder's per-tenant cap entirely (S5 audit #1402). Both paths now route
 * through `SmrtJobCollection.enqueueJob()`, which the ScheduleRunner invokes
 * with the schedule's tenant passed EXPLICITLY (it fires with no ambient tenant
 * context). These tests pin that path: the cap is enforced from an explicit
 * tenantId with no `withTenant()` wrapper, and the retry ceiling is clamped.
 */
describe('centralized enqueueJob (ScheduleRunner path)', () => {
  function scheduledJob(tenantId: string | null) {
    return {
      tenantId,
      queue: 'agents',
      objectType: 'CapProbe',
      objectId: 'probe-1',
      method: 'work',
      args: {},
      priority: 75,
      maxAttempts: 3,
    };
  }

  it('enforces the per-tenant cap from an explicit tenantId (no ambient context)', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const collection = await SmrtJobCollection.create({ db });

    // No withTenant(): mirrors the ScheduleRunner, which has no ambient context
    // and relies on the explicit tenantId on the job data.
    await collection.enqueueJob(scheduledJob('sched-tenant'), {
      tenantJobCap: 2,
    });
    await collection.enqueueJob(scheduledJob('sched-tenant'), {
      tenantJobCap: 2,
    });

    await expect(
      collection.enqueueJob(scheduledJob('sched-tenant'), { tenantJobCap: 2 }),
    ).rejects.toBeInstanceOf(TenantJobCapExceededError);

    expect(await collection.countInFlightForTenant('sched-tenant')).toBe(2);
  });

  it('exempts global (null tenant) scheduled jobs from the cap', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const collection = await SmrtJobCollection.create({ db });

    await collection.enqueueJob(scheduledJob(null), { tenantJobCap: 1 });
    await expect(
      collection.enqueueJob(scheduledJob(null), { tenantJobCap: 1 }),
    ).resolves.toBeDefined();
  });

  it('clamps an over-ceiling maxAttempts on the centralized path', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const collection = await SmrtJobCollection.create({ db });

    const job = await collection.enqueueJob({
      tenantId: null,
      queue: 'agents',
      objectType: 'CapProbe',
      objectId: 'probe-1',
      method: 'work',
      args: {},
      maxAttempts: 10_000,
    });

    expect(job.maxAttempts).toBe(MAX_JOB_RETRIES);
  });
});
