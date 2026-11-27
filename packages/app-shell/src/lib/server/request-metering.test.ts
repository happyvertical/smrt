// Request metering (#5199, request half): batched counter rows per tenant and
// caller kind, tenant from the decided principal, never a throw into a request.
// SQLite shell database, no server.
import { TenantUsageMetricCollection } from '@happyvertical/smrt-subscriptions';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type CloudHarness, openCloudShell } from './cloud-test-support.ts';
import { runAs } from './owner.ts';
import { RequestMeter, UNKNOWN_CALLER_KIND } from './request-metering.ts';
import {
  monthWindow,
  REQUEST_COUNT_METRIC,
  StorageMeter,
} from './storage-metering.ts';

let h: CloudHarness;
beforeAll(async () => {
  h = await openCloudShell();
  await TenantUsageMetricCollection.create({ db: h.db });
});
afterAll(async () => {
  await h.close();
});

const meters: RequestMeter[] = [];
afterEach(() => {
  for (const m of meters.splice(0)) m.stop();
});

function meter(profile = 'cloud') {
  const m = new RequestMeter({
    db: async () => h.db,
    profile: async () => profile,
    flushMs: 3_600_000,
  });
  meters.push(m);
  return m;
}

const read = (p: typeof h.a) =>
  runAs(p, () =>
    new StorageMeter({ db: async () => h.db }).read(monthWindow(new Date())),
  );

describe('request metering', () => {
  it('batches counts per tenant and caller kind, and reads them apart', async () => {
    const m = meter();
    for (let i = 0; i < 5; i++)
      m.note({ tenantId: h.a.tenantId, callerKind: 'guest', limited: false });
    for (let i = 0; i < 3; i++)
      m.note({ tenantId: h.a.tenantId, callerKind: 'staff', limited: false });
    m.note({ tenantId: h.a.tenantId, callerKind: 'guest', limited: true });
    m.note({ tenantId: h.a.tenantId, callerKind: null, limited: false });
    m.note({ tenantId: h.b.tenantId, callerKind: 'guest', limited: false });
    await m.flush();
    const a = (await read(h.a)).requests;
    expect(a.count).toBe(10);
    expect(a.limited).toBe(1);
    expect(a.byCallerKind).toEqual({
      guest: 6,
      staff: 3,
      [UNKNOWN_CALLER_KIND]: 1,
    });
    // Tenant B sees only its own request.
    expect((await read(h.b)).requests.byCallerKind).toEqual({ guest: 1 });
    // One row per (tenant, kind, limited): five guest requests are one write.
    const rows = await runAs(h.a, async () =>
      (await TenantUsageMetricCollection.create({ db: h.db })).list({
        where: { tenantId: h.a.tenantId, metricKey: REQUEST_COUNT_METRIC },
        limit: 100,
      }),
    );
    expect(rows).toHaveLength(4);
  });

  it('writes nothing on the desktop profile and ignores a request with no tenant', async () => {
    const before = (await read(h.a)).requests.count;
    const m = meter('desktop');
    m.note({ tenantId: h.a.tenantId, callerKind: 'user', limited: false });
    await m.flush();
    const n = meter();
    n.note({ tenantId: null, callerKind: 'user', limited: false });
    await n.flush();
    expect((await read(h.a)).requests.count).toBe(before);
  });

  it('never throws into a request: a failing database drops the batch quietly', async () => {
    const m = new RequestMeter({
      db: async () => {
        throw new Error('db down');
      },
      profile: async () => 'cloud',
    });
    meters.push(m);
    expect(() =>
      m.note({ tenantId: h.a.tenantId, callerKind: 'user', limited: false }),
    ).not.toThrow();
    await expect(m.flush()).resolves.toBeUndefined();
  });
});
