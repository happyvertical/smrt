// Wake and idle-close metering (#5199): host.ts samples a tenant's storage and
// worker activity when its app wakes and when it is closed for idleness, on the
// host's tenant, cloud only. SQLite shell database, a fake size probe; the
// registry's workers are real. Request counts and caller kind are #5195's.
import { TenantUsageMetricCollection } from '@happyvertical/smrt-subscriptions';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hostOwner } from '../../test/engine-principal.ts';
import { App } from '../objects/App.ts';
import { type CloudHarness, openCloudShell } from './cloud-test-support.ts';
import { getHost, hostMetrics, sweepIdleHosts } from './host.ts';
import { runAs } from './owner.ts';
import {
  APP_AWAKE_METRIC,
  APP_WAKE_METRIC,
  monthWindow,
  resetStorageMeter,
  STORAGE_BYTES_METRIC,
  StorageMeter,
  type StorageProbe,
} from './storage-metering.ts';
import { applyWaiting, openShell, type ShellHarness } from './test-support.ts';

const IDLE = 60_000;
let clock = Date.UTC(2026, 10, 10, 12, 0, 0);
let cloud: CloudHarness | null = null;
let local: ShellHarness | null = null;

afterEach(async () => {
  resetStorageMeter(null);
  await cloud?.close();
  await local?.close();
  cloud = null;
  local = null;
  vi.restoreAllMocks();
});

function fakeProbe(bytes = 4096): StorageProbe {
  return { measure: async () => ({ bytes, backend: 'sqlite' }) };
}

async function openCloud(meter: () => StorageMeter) {
  cloud = await openCloudShell({
    lifecycle: { idleMs: IDLE, minIdleMs: 0, handoutMs: 20, now: () => clock },
  });
  await TenantUsageMetricCollection.create({ db: cloud.db }); // migrated table
  const m = meter();
  resetStorageMeter(m);
  return cloud;
}

const rows = (h: CloudHarness, tenantId: string, metricKey: string) =>
  runAs({ id: 'x', tenantId }, async () =>
    (await TenantUsageMetricCollection.create({ db: h.db })).list({
      where: { tenantId, metricKey },
      limit: 100,
    }),
  );

async function sleepApp() {
  await new Promise((r) => setTimeout(r, 80)); // hand-out leases end
  clock += IDLE * 2;
  await sweepIdleHosts();
}

describe('wake and idle-close sampling', () => {
  it('records a wake, then an idle close with its awake span and a storage sample', async () => {
    const meter = new StorageMeter({ probe: fakeProbe(), now: () => clock });
    const h = await openCloud(() => meter);
    const { a, b } = h;
    await runAs(a, () => App.defineModel('Chore', { title: { type: 'text' } }));
    await runAs(a, () => applyWaiting(a));
    await vi.waitFor(async () =>
      expect((await rows(h, a.tenantId, APP_WAKE_METRIC)).length).toBe(1),
    );
    const wake = (await rows(h, a.tenantId, APP_WAKE_METRIC))[0];
    expect(wake.quantity).toBe(1);
    expect(wake.source).toBe('app-shell.worker');
    expect(wake.getDimensions()).toMatchObject({ event: 'wake' });

    const sampled = (await rows(h, a.tenantId, STORAGE_BYTES_METRIC)).length;
    clock += 60 * 60 * 1000; // a new storage bucket, so the close's sample is its own row
    await sleepApp();
    expect(hostMetrics().open).toBe(0);
    await vi.waitFor(async () =>
      expect((await rows(h, a.tenantId, APP_AWAKE_METRIC)).length).toBe(1),
    );
    const close = (await rows(h, a.tenantId, APP_AWAKE_METRIC))[0];
    expect(close.quantity).toBeGreaterThanOrEqual(IDLE * 2);
    expect(close.getDimensions()).toMatchObject({
      event: 'close',
      why: 'idle',
    });
    // the close sampled storage, tagged with the host's tenant
    await vi.waitFor(async () =>
      expect((await rows(h, a.tenantId, STORAGE_BYTES_METRIC)).length).toBe(
        sampled + 1,
      ),
    );
    const latest = (await rows(h, a.tenantId, STORAGE_BYTES_METRIC)).sort(
      (x, y) => y.windowStart.getTime() - x.windowStart.getTime(),
    )[0];
    expect(latest.quantity).toBe(4096);
    expect(latest.getDimensions()).toMatchObject({ backend: 'sqlite' });
    // the other tenant never woke: nothing of it was written
    expect(await rows(h, b.tenantId, APP_WAKE_METRIC)).toHaveLength(0);
    expect(await rows(h, b.tenantId, APP_AWAKE_METRIC)).toHaveLength(0);
    expect(await rows(h, b.tenantId, STORAGE_BYTES_METRIC)).toHaveLength(0);

    // waking again is a second wake row
    await runAs(a, () => getHost());
    await vi.waitFor(async () =>
      expect((await rows(h, a.tenantId, APP_WAKE_METRIC)).length).toBe(2),
    );
    const usage = await runAs(a, () =>
      meter.read(monthWindow(new Date(clock))),
    );
    expect(usage.worker.wakes).toBe(2);
    expect(usage.worker.awakeMs).toBe(close.quantity);
  });

  it('is inert on the desktop: no write, no db handle, the app still opens', async () => {
    const db = vi.fn(async () => {
      throw new Error('desktop must not reach the usage table');
    });
    const meter = new StorageMeter({ probe: fakeProbe(), db });
    const wake = vi.spyOn(meter, 'onWake');
    const close = vi.spyOn(meter, 'onClose');
    resetStorageMeter(meter);
    local = await openShell();
    const host = await getHost();
    expect(host).toBeTruthy();
    await new Promise((r) => setTimeout(r, 30));
    // host.ts never even called the writer for the desktop's app
    expect(wake).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    // and the writer's own profile guard holds if it were called
    await meter.onWake('some-tenant', 5);
    await meter.onClose('some-tenant', 5, 'idle');
    expect(db).not.toHaveBeenCalled();
  });

  it('a failing writer does not break wake, calls, or close', async () => {
    const meter = new StorageMeter({
      probe: {
        measure: async () => {
          throw new Error('probe down');
        },
      },
      db: async () => {
        throw new Error('usage db down');
      },
    });
    vi.spyOn(meter, 'onWake').mockRejectedValue(new Error('writer down'));
    const h = await openCloud(() => meter);
    const { a } = h;
    await runAs(a, () => App.defineModel('Chore', { title: { type: 'text' } }));
    await runAs(a, () => applyWaiting(a));
    const created = await runAs(a, async () =>
      (await getHost()).create(hostOwner(await getHost()), 'Chore', {
        title: 'one',
      }),
    );
    expect(created).toBeTruthy();
    await sleepApp();
    expect(hostMetrics().open).toBe(0); // the close finished
    const again = await runAs(a, async () =>
      (await getHost()).list(hostOwner(await getHost()), 'Chore'),
    );
    expect(again).toHaveLength(1);
    expect(await rows(h, a.tenantId, APP_WAKE_METRIC)).toHaveLength(0);
    expect(await rows(h, a.tenantId, APP_AWAKE_METRIC)).toHaveLength(0);
  });

  it('a rejecting onWake alone does not break the wake', async () => {
    const meter = new StorageMeter({ probe: fakeProbe(), now: () => clock });
    vi.spyOn(meter, 'onWake').mockRejectedValue(new Error('writer down'));
    const h = await openCloud(() => meter);
    const { a } = h;
    await runAs(a, () => App.defineModel('Chore', { title: { type: 'text' } }));
    await runAs(a, () => applyWaiting(a));
    expect(await runAs(a, () => getHost())).toBeTruthy();
    expect(meter.onWake).toHaveBeenCalled();
    expect(await rows(h, a.tenantId, APP_WAKE_METRIC)).toHaveLength(0);
  });
});
