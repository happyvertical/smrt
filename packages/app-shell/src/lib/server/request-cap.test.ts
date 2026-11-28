// The plan's request cap per billing period (#5198) and the owner notice.
// Unit cases on the gate with fake stores; end to end on SQLite with the real
// plan and usage stores; the desktop is inert. NOT exercised: PostgreSQL.
import {
  getWindowForThreshold,
  type PlanThreshold,
  SubscriptionPlanCollection,
  TenantSubscriptionCollection,
} from '@happyvertical/smrt-subscriptions';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hostOwner } from '../../test/engine-principal.ts';
import { type CloudHarness, openCloudShell } from './cloud-test-support.ts';
import { getHost } from './host.ts';
import {
  dismissLimitNotices,
  readLimitNotices,
  recordLimitNotice,
  resetLimitNotices,
} from './limit-notices.ts';
import { runAs } from './owner.ts';
import {
  createRequestCapGate,
  installRequestCapGate,
  RequestCapGate,
  requestCapGate,
  resetRequestCapGate,
} from './request-cap.ts';
import { RequestMeter, resetRequestMeter } from './request-metering.ts';
import { REQUEST_COUNT_METRIC } from './storage-metering.ts';
import { openShell, type ShellHarness } from './test-support.ts';

const cap = (limit: number, over: Partial<PlanThreshold> = {}) =>
  ({
    metricKey: REQUEST_COUNT_METRIC,
    limit,
    window: 'month',
    enforcement: 'block',
    ...over,
  }) as PlanThreshold;

describe('RequestCapGate', () => {
  const T = 't1';
  const at = Date.UTC(2026, 10, 15, 12);
  function gate(
    thresholds: PlanThreshold[],
    persisted = 0,
    clock = { now: at },
    pending = 0,
  ) {
    const usage = vi.fn(async () => persisted);
    const plan = vi.fn(async () => thresholds);
    return {
      usage,
      plan,
      clock,
      g: new RequestCapGate({
        plan,
        usage,
        pending: () => pending,
        windowOf: getWindowForThreshold,
        now: () => clock.now,
        ttlMs: 30_000,
      }),
    };
  }

  it('admits up to the limit then refuses, naming the cap and the renewal date', async () => {
    const { g } = gate([cap(3)]);
    expect(await g.check(T)).toBeNull();
    expect(await g.check(T)).toBeNull();
    expect(await g.check(T)).toBeNull();
    const refused = await g.check(T);
    expect(refused).toMatchObject({
      limit: 3,
      used: 3,
      resetsAt: '2026-12-01T00:00:00.000Z',
    });
    expect(refused?.message).toMatch(
      /used 3 of the 3 requests its plan allows this month; the count renews on 2026-12-01/,
    );
  });

  it('counts what is persisted and what this process has not written yet; refusals do not burn the cap', async () => {
    const { g } = gate([cap(10)], 7, { now: at }, 2);
    expect(await g.check(T)).toBeNull(); // 9 -> 10
    expect(await g.check(T)).not.toBeNull();
    expect(await g.check(T)).not.toBeNull();
    expect((await g.check(T))?.used).toBe(10);
  });

  it('has no cap without a threshold, and reads the plan once per ttl', async () => {
    const none = gate([]);
    for (let i = 0; i < 5; i++) expect(await none.g.check(T)).toBeNull();
    expect(none.plan).toHaveBeenCalledTimes(1);
    expect(none.usage).not.toHaveBeenCalled();
  });

  it('starts a new period when the calendar window ends', async () => {
    const clock = { now: at };
    const { g, usage } = gate([cap(1)], 0, clock);
    expect(await g.check(T)).toBeNull();
    expect(await g.check(T)).not.toBeNull();
    clock.now = Date.UTC(2026, 11, 1, 0, 0, 1);
    expect(await g.check(T)).toBeNull();
    expect(usage).toHaveBeenCalledTimes(2);
  });

  it('the strictest of several caps wins; a lookup error propagates (the host admits)', async () => {
    const { g } = gate([cap(100), cap(1, { window: 'day' })]);
    expect(await g.check(T)).toBeNull();
    expect((await g.check(T))?.limit).toBe(1);
    const broken = new RequestCapGate({
      plan: async () => {
        throw new Error('db down');
      },
      usage: async () => 0,
      windowOf: getWindowForThreshold,
    });
    await expect(broken.check(T)).rejects.toThrow('db down');
  });
});

describe('owner notices', () => {
  afterEach(resetLimitNotices);
  it('keeps one notice per kind with a count, newest first, and clears on dismiss', () => {
    let t = 1_000;
    recordLimitNotice(
      'a',
      { kind: 'cap', cap: 'maxRows', message: 'rows' },
      () => t++,
    );
    recordLimitNotice('a', { kind: 'route', message: 'slow down' }, () => t++);
    recordLimitNotice(
      'a',
      { kind: 'cap', cap: 'maxRows', message: 'rows' },
      () => t++,
    );
    const seen = readLimitNotices('a', () => t);
    expect(seen.map((n) => [n.kind, n.count])).toEqual([
      ['cap', 2],
      ['route', 1],
    ]);
    expect(readLimitNotices('b')).toEqual([]);
    dismissLimitNotices('a');
    expect(readLimitNotices('a')).toEqual([]);
  });
  it('drops a notice nobody read for a day', () => {
    recordLimitNotice('a', { kind: 'route', message: 'x' }, () => 0);
    expect(readLimitNotices('a', () => 25 * 3600 * 1000)).toEqual([]);
  });
});

describe('a cloud shell with a plan cap', () => {
  let cloud: CloudHarness | null = null;
  let local: ShellHarness | null = null;
  afterEach(async () => {
    resetRequestCapGate();
    resetRequestMeter();
    resetLimitNotices();
    await cloud?.close();
    await local?.close();
    cloud = local = null;
  });

  async function plan(h: CloudHarness, tenantId: string, t: PlanThreshold[]) {
    const plans = await SubscriptionPlanCollection.create({ db: h.db });
    const p = await plans.create({
      planKey: `p-${Math.random()}`,
      name: 'Plan',
      tenantId: null,
    });
    p.setThresholds(t);
    await p.save();
    await withTenant({ tenantId }, async () => {
      const subs = await TenantSubscriptionCollection.create({ db: h.db });
      await (
        await subs.create({ tenantId, planId: String(p.id), status: 'active' })
      ).save();
    });
  }

  it('reads the cap from the plan, refuses a request with a 429, tells the owner, and counts the refusal apart', async () => {
    cloud = await openCloudShell();
    const h = cloud;
    await plan(h, h.a.tenantId, [cap(2)]);
    const meter = new RequestMeter({
      db: async () => h.db,
      profile: async () => 'cloud',
      flushMs: 3_600_000,
    });
    resetRequestMeter(meter);
    await installRequestCapGate({ db: async () => h.db });
    expect(requestCapGate()).toBeInstanceOf(RequestCapGate);

    const host = await runAs(h.a, () => getHost());
    await host.execute(
      hostOwner(host),
      { type: 'defineModel', name: 'Chore', fields: { t: { type: 'text' } } },
      { author: 't', approved: true },
    );
    const get = () =>
      host.rest(hostOwner(host), { method: 'GET', url: '/api/chores' });
    expect((await get()).status).toBe(200);
    expect((await get()).status).toBe(200);
    const over = await get();
    expect(over.status).toBe(429);
    expect(JSON.parse(over.body)).toMatchObject({
      code: 'app_limit',
      cap: 'maxRequests',
      limit: 2,
    });
    // The owner is told, and the refusal is counted as refused, not served.
    expect(readLimitNotices(h.a.tenantId).map((n) => [n.kind, n.cap])).toEqual([
      ['period', 'maxRequests'],
    ]);
    await meter.flush();
    expect(meter.pendingServed(h.a.tenantId)).toBe(0);
    // Tenant B has no plan and is never limited.
    const other = await runAs(h.b, () => getHost());
    await other.execute(
      hostOwner(other),
      { type: 'defineModel', name: 'Chore', fields: { t: { type: 'text' } } },
      { author: 't', approved: true },
    );
    for (let i = 0; i < 4; i++)
      expect(
        (
          await other.rest(hostOwner(other), {
            method: 'GET',
            url: '/api/chores',
          })
        ).status,
      ).toBe(200);
  });

  it('only a blocking threshold on api.requests is a cap', async () => {
    cloud = await openCloudShell();
    const h = cloud;
    await plan(h, h.a.tenantId, [
      cap(1, { enforcement: 'warn' }),
      cap(1, { metricKey: 'other.metric' }),
    ]);
    const g = await createRequestCapGate(h.db);
    for (let i = 0; i < 3; i++) expect(await g.check(h.a.tenantId)).toBeNull();
  });

  it('refused rows persisted earlier do not count; served rows do', async () => {
    cloud = await openCloudShell();
    const h = cloud;
    await plan(h, h.a.tenantId, [cap(5)]);
    const meter = new RequestMeter({
      db: async () => h.db,
      profile: async () => 'cloud',
      flushMs: 3_600_000,
    });
    for (let i = 0; i < 4; i++)
      meter.note({
        tenantId: h.a.tenantId,
        callerKind: 'guest',
        limited: false,
        refused: null,
      });
    for (let i = 0; i < 50; i++)
      meter.note({
        tenantId: h.a.tenantId,
        callerKind: 'guest',
        limited: false,
        refused: 'not_found',
      });
    await meter.flush();
    meter.stop();
    const g = await createRequestCapGate(h.db);
    expect(await g.check(h.a.tenantId)).toBeNull(); // 4 served + this = 5
    expect(await g.check(h.a.tenantId)).not.toBeNull();
  });

  it('the desktop builds no gate, loads no plan and is never capped', async () => {
    local = await openShell();
    await installRequestCapGate({ db: async () => local as never });
    expect(requestCapGate()).toBeUndefined();
    const host = await runAs(local.owner, () => getHost());
    await host.execute(
      hostOwner(host),
      { type: 'defineModel', name: 'Chore', fields: { t: { type: 'text' } } },
      { author: 't', approved: true },
    );
    for (let i = 0; i < 4; i++)
      expect(
        (
          await host.rest(hostOwner(host), {
            method: 'GET',
            url: '/api/chores',
          })
        ).status,
      ).toBe(200);
  });
});
