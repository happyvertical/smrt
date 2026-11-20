// Worker lifecycle for many apps in one process (#5192): idle eviction, wake
// on demand, caps, in-flight protection, and the desktop left alone.
//
// WHAT THIS PROVES: the registry's policy over real AppHost workers on SQLite,
// two tenants in one shell database. WHAT IT DOES NOT: PostgreSQL, a real
// memory ceiling (the cap is a count derived from the ceiling; a worker keeps
// what it grew to, see agents/engine.md), or handing apps to another process.
import { types } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../objects/App.ts';
import { ownerTenantFor } from './accounts.ts';
import { type CloudHarness, openCloudShell } from './cloud-test-support.ts';
import { publish, subscribe } from './events.ts';
import {
  drainShell,
  getDraftSlot,
  getHost,
  hostMetrics,
  openHost,
  setDraftSlot,
  sweepIdleHosts,
} from './host.ts';
import { HostLifecycle, lifecycleFromEnv } from './host-lifecycle.ts';
import { runAs } from './owner.ts';
import { applyWaiting, openShell, type ShellHarness } from './test-support.ts';

let clock = 1_000_000;
const now = () => clock;
const IDLE = 60_000;

let cloud: CloudHarness | null = null;
let local: ShellHarness | null = null;
afterEach(async () => {
  await cloud?.close();
  await local?.close();
  cloud = null;
  local = null;
});

async function twoOwners(policy: object = {}) {
  clock = 1_000_000;
  cloud = await openCloudShell({
    lifecycle: {
      idleMs: IDLE,
      minIdleMs: 0,
      handoutMs: 20,
      now,
      capacityWaitMs: 300,
      ...policy,
    },
  });
  const { a, b } = cloud;
  for (const [owner, model] of [
    [a, 'Chore'],
    [b, 'Invoice'],
  ] as const) {
    await runAs(owner, () =>
      App.defineModel(model, { title: { type: 'text' } }),
    );
    await runAs(owner, async () => {
      await applyWaiting(owner);
    });
  }
  // Both apps were opened by the set-up: put them to sleep, count from here.
  await new Promise((r) => setTimeout(r, 80)); // the hand-outs end
  clock += IDLE * 2;
  await sweepIdleHosts();
  expect(hostMetrics().open).toBe(0);
  return { a, b, h: cloud, m0: hostMetrics() };
}

/** A call that stays inside the app until `finish()` is called. */
function holdCall(host: Awaited<ReturnType<typeof getHost>>) {
  let finish: () => void = () => {};
  const gate = new Promise<void>((r) => {
    finish = r;
  });
  const real = host.list.bind(host);
  vi.spyOn(host, 'list').mockImplementationOnce(async (...args) => {
    await gate;
    return real(...args);
  });
  return { call: host.list('Chore'), finish };
}

/** Let the hand-out leases of hosts just fetched run out. */
const settled = () => new Promise((r) => setTimeout(r, 60));

const add = (o: CloudHarness['a'], model: string, title: string) =>
  runAs(o, async () => (await getHost()).create(model, { title }));
const titles = (o: CloudHarness['a'], model: string) =>
  runAs(o, async () =>
    (await (await getHost()).list(model)).map((r) => r.title),
  );

describe('idle eviction and wake', () => {
  it('closes an app idle past the limit and wakes it like a first open', async () => {
    const { a, m0 } = await twoOwners();
    await add(a, 'Chore', 'one');
    const before = await runAs(a, () => getHost());
    expect(hostMetrics().open).toBe(1);

    expect(await sweepIdleHosts()).toBe(0); // not idle yet
    await settled();
    clock += IDLE;
    expect(await sweepIdleHosts()).toBe(1);
    expect(hostMetrics().open).toBe(0);
    expect(hostMetrics().evictions.idle).toBe(m0.evictions.idle + 1);
    expect(before.appAlive).toBe(false); // the worker is really gone

    const wakesBefore = hostMetrics().wakes;
    const after = await runAs(a, () => getHost());
    expect(after).not.toBe(before);
    expect(after.appAlive).toBe(true);
    expect(hostMetrics().wakes).toBe(wakesBefore + 1);
    expect(hostMetrics().lastWakeMs).not.toBeNull();
    expect(await titles(a, 'Chore')).toEqual(['one']); // data survived on disk
  });

  it('does not let a browser tab keep an app awake', async () => {
    const { a } = await twoOwners();
    await add(a, 'Chore', 'one');
    const seen: unknown[] = [];
    const stop = subscribe((e) => seen.push(e), a.tenantId);
    clock += IDLE / 2;
    // What a live tab does: look without calling in, and receive events.
    await runAs(a, async () => openHost());
    publish({ type: 'records', target: 'live', model: 'Chore' }, a.tenantId);
    clock += IDLE / 2;
    expect(await sweepIdleHosts()).toBe(1);
    stop();
  });

  it('never closes an app with a call inside it, and keeps its write', async () => {
    const { a } = await twoOwners();
    const host = await runAs(a, () => getHost());
    clock += IDLE * 2;
    const writing = host.create('Chore', { title: 'in flight' });
    expect(await sweepIdleHosts()).toBe(0); // the call is inside the app
    await writing;
    // The call finished just now, so the app counts as used just now.
    expect(await sweepIdleHosts()).toBe(0);
    clock += IDLE;
    expect(await sweepIdleHosts()).toBe(1);
    expect(await titles(a, 'Chore')).toEqual(['in flight']);
  });

  it('never closes an app whose draft a workflow holds', async () => {
    const { a } = await twoOwners();
    await runAs(a, async () => {
      await getHost();
      setDraftSlot({
        id: 'd',
        name: 'held',
        dir: '/nowhere',
        host: null,
        problem: null,
        hold: 'checking an import',
      });
    });
    await settled(); // only the held draft keeps it now
    clock += IDLE * 2;
    expect(await sweepIdleHosts()).toBe(0);
    await runAs(a, async () => {
      expect((await getDraftSlot())?.hold).toBe('checking an import');
      setDraftSlot(null);
    });
    await settled();
    clock += IDLE;
    expect(await sweepIdleHosts()).toBe(1);
  });
});

describe('the cap on open apps', () => {
  it('closes the app used longest ago to make room, and keeps tenants apart', async () => {
    const { a, b, m0 } = await twoOwners({ maxOpenApps: 1 });
    await add(a, 'Chore', 'ann');
    await add(b, 'Invoice', 'bob');
    expect(hostMetrics().open).toBe(1);
    expect(hostMetrics().evictions.capacity).toBeGreaterThan(
      m0.evictions.capacity,
    );
    expect(await titles(a, 'Chore')).toEqual(['ann']);
    expect(await titles(b, 'Invoice')).toEqual(['bob']);
    // The woken app is its own: the other's model is not there.
    await expect(titles(a, 'Invoice')).rejects.toThrow();
    expect(hostMetrics().open).toBe(1);
  });

  it('derives the cap from a memory ceiling', async () => {
    await twoOwners({ memoryCeilingMb: 160, appMemoryMb: 80 });
    expect(hostMetrics().maxOpen).toBe(2);
    await cloud?.close();
    cloud = null;
    await twoOwners({ maxOpenApps: 3, memoryCeilingMb: 100, appMemoryMb: 80 });
    expect(hostMetrics().maxOpen).toBe(1); // the smaller wins, never zero
  });

  it('refuses a wake when every open app is busy, rather than cutting a call', async () => {
    const { a, b } = await twoOwners({ maxOpenApps: 1 });
    const host = await runAs(a, () => getHost());
    const { call: busy, finish } = holdCall(host); // inside the app now
    await expect(runAs(b, () => getHost())).rejects.toThrow(/no room/);
    finish();
    await busy; // the busy call was not cut
    expect(host.appAlive).toBe(true);
    // Once it is done there is room again.
    expect(await titles(b, 'Invoice')).toEqual([]);
  });

  it('waits for a busy app to finish when it does so in time', async () => {
    const { a, b } = await twoOwners({ maxOpenApps: 1, capacityWaitMs: 5000 });
    const host = await runAs(a, () => getHost());
    const { call: busy, finish } = holdCall(host);
    const woken = runAs(b, () => getHost());
    setTimeout(finish, 100);
    await busy;
    expect((await woken).dataDir).toContain(b.tenantId);
  });
});

describe('a burst of wakes under a cap', () => {
  it('two sleeping apps asked for at once while a third idles in the only place', async () => {
    // The reviewer's interleaving. Old code: the first request evicts the idle
    // app, then counts the SECOND request's queued promise as an open app and
    // finds no room, while the second cannot run until the first leaves the
    // single wake slot: the first times out "no room" with no worker open.
    const { a, b, h } = await twoOwners({
      maxOpenApps: 1,
      maxConcurrentWakes: 1,
      capacityWaitMs: 400,
    });
    const user = await h.newUser('cy@example.test');
    const tenantId = await ownerTenantFor(h.db, { id: user.id, name: 'cy' });
    const c = { id: user.id, tenantId };
    await runAs(c, () => getHost()); // c idles in the only place
    await new Promise((r) => setTimeout(r, 40)); // its hand-out ends
    const [one, two] = await Promise.all([
      runAs(a, () => getHost()),
      runAs(b, () => getHost()),
    ]);
    expect(one.dataDir).toContain(a.tenantId);
    expect(two.dataDir).toContain(b.tenantId);
    expect(hostMetrics().open).toBe(1);
  });

  it('never exceeds the cap and leaks no worker with more requests than places', async () => {
    const { a, b } = await twoOwners({
      maxOpenApps: 1,
      maxConcurrentWakes: 1,
      capacityWaitMs: 4000,
    });
    let peak = 0;
    const watch = setInterval(() => {
      peak = Math.max(peak, hostMetrics().open);
    }, 1);
    const seen = new Set<Awaited<ReturnType<typeof getHost>>>();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        runAs(i % 2 ? a : b, async () => {
          const host = await getHost();
          seen.add(host);
          await host.list(i % 2 ? 'Chore' : 'Invoice');
        }),
      ),
    );
    clearInterval(watch);
    for (const r of results)
      if (r.status === 'rejected')
        expect(String(r.reason)).toMatch(/no room|try again/); // retryable only
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    expect(peak).toBeLessThanOrEqual(1);
    clock += IDLE * 2;
    await sweepIdleHosts();
    // Every worker any request was given is gone: none leaked.
    for (const host of seen) expect(host.appAlive).toBe(false);
  });
});

describe('leases', () => {
  it('a host just handed out is never closed under its caller, with no minimum idle', async () => {
    const { a, b } = await twoOwners({ maxOpenApps: 1, minIdleMs: 0 });
    const host = await runAs(a, () => getHost());
    // Another app demands the only place at once; A's hand-out holds it.
    const other = runAs(b, () => getHost());
    await host.list('Chore'); // the caller's first call: never "the host is closed"
    expect((await other).dataDir).toContain(b.tenantId);
  });

  it('an operation outlasting every timer keeps its app; others wait, then are refused', async () => {
    const { a, b } = await twoOwners({
      maxOpenApps: 1,
      minIdleMs: 0,
      capacityWaitMs: 150,
    });
    const host = await runAs(a, () => getHost());
    const { call, finish } = holdCall(host);
    await new Promise((r) => setTimeout(r, 60)); // hand-out long over
    clock += IDLE * 10;
    expect(await sweepIdleHosts()).toBe(0);
    await expect(runAs(b, () => getHost())).rejects.toThrow(/no room/);
    expect(host.appAlive).toBe(true);
    finish();
    await call;
    expect((await runAs(b, () => getHost())).dataDir).toContain(b.tenantId);
  });

  it('a call that throws gives its lease back', async () => {
    const { a } = await twoOwners({ minIdleMs: 0 });
    const host = await runAs(a, () => getHost());
    await expect(host.list('NoSuchModel')).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 40)); // hand-out over
    clock += IDLE;
    expect(await sweepIdleHosts()).toBe(1);
  });
});

describe('drain', () => {
  it('waits for calls inside, then closes everything and takes no new app', async () => {
    const { a } = await twoOwners();
    const host = await runAs(a, () => getHost());
    const writing = host.create('Chore', { title: 'last' });
    const drained = drainShell(5000);
    await writing;
    expect(await drained).toEqual({ closed: 1, busy: 0 });
    expect(host.appAlive).toBe(false);
    await expect(runAs(a, () => getHost())).rejects.toThrow(/draining/);
  });
});

describe('the wake gate', () => {
  it('runs at most the allowed wakes at once and queues the rest', async () => {
    const life = new HostLifecycle();
    life.configure({ maxConcurrentWakes: 2 });
    let running = 0;
    let peak = 0;
    const release: (() => void)[] = [];
    const wake = () =>
      life.wake(
        () =>
          new Promise<void>((resolve) => {
            running++;
            peak = Math.max(peak, running);
            release.push(() => {
              running--;
              resolve();
            });
          }),
      );
    const all = [wake(), wake(), wake(), wake()];
    await Promise.resolve();
    expect(running).toBe(2);
    expect(life.queuedWakes).toBe(2);
    while (release.length) {
      release.shift()?.();
      await new Promise((r) => setTimeout(r, 0));
    }
    await Promise.all(all);
    expect(peak).toBe(2);
    expect(life.wakes).toBe(4);
    expect(life.queuedWakes).toBe(0);
  });

  it('counts a failed wake and frees its place', async () => {
    const life = new HostLifecycle();
    life.configure({ maxConcurrentWakes: 1 });
    await expect(
      life.wake(() => Promise.reject(new Error('x'))),
    ).rejects.toThrow();
    await expect(life.wake(async () => 'ok')).resolves.toBe('ok');
    expect(life.failedWakes).toBe(1);
    expect(life.wakes).toBe(1);
  });
});

describe('the policy', () => {
  it('refuses nonsense and reads the environment', () => {
    const life = new HostLifecycle();
    expect(() => life.configure({ idleMs: 0 })).toThrow(RangeError);
    expect(() => life.configure({ maxOpenApps: -1 })).toThrow(RangeError);
    expect(lifecycleFromEnv({})).toBeUndefined();
    expect(
      lifecycleFromEnv({
        SMRT_APP_SHELL_IDLE_MS: '900000',
        SMRT_APP_SHELL_MAX_OPEN_APPS: '12',
      }),
    ).toEqual({ idleMs: 900000, maxOpenApps: 12 });
    expect(() =>
      lifecycleFromEnv({ SMRT_APP_SHELL_IDLE_MS: 'soon' }),
    ).toThrow();
  });
});

describe('the desktop is unchanged', () => {
  it('keeps one raw host forever, even with a policy configured', async () => {
    clock = 1_000_000;
    local = await openShell({
      lifecycle: { idleMs: 1, maxOpenApps: 1, minIdleMs: 0, now },
    });
    const first = await runAs(local.owner, () => getHost());
    expect(types.isProxy(first)).toBe(false);
    clock += 10 * IDLE;
    expect(await sweepIdleHosts()).toBe(0);
    const second = await runAs(local.owner, () => getHost());
    expect(second).toBe(first);
    expect(second.appAlive).toBe(true);
    expect(hostMetrics().wakes).toBe(0);
    expect(hostMetrics().evictions).toEqual({ idle: 0, capacity: 0 });
  });

  it('does the same with no policy at all, and a hosted app with none stays open', async () => {
    local = await openShell();
    const host = await runAs(local.owner, () => getHost());
    expect(types.isProxy(host)).toBe(false);
    await local.close();
    local = null;
    cloud = await openCloudShell();
    const open = await runAs(cloud.a, () => getHost());
    expect(types.isProxy(open)).toBe(false);
    expect(await sweepIdleHosts()).toBe(0);
    expect(await runAs(cloud.a, () => getHost())).toBe(open);
  });
});
