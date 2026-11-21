// The cloud profile's process-wide connection budget and what an owner is told
// when a database fails (#5464). WHAT THIS PROVES: the budget's accounting and
// refusal, and that a failed open gives its connections back. WHAT IT DOES NOT: a real server's connection
// limit (PostgreSQL is the on-demand workflow's); the "postgres" configs below
// point at a port nothing listens on, so no connection is ever made.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createSqliteChangeEngine } from '../../engine/change-engine.ts';
import type { DatabaseConfig } from '../../engine/db/index.ts';
import { CapacityError } from '../../engine/errors.ts';
import { AppHost, MemoryVersionStore } from '../../engine/index.ts';
import { AppWorker } from '../../engine/worker-handle.ts';
import { type CloudHarness, openCloudShell } from './cloud-test-support.ts';
import {
  closeHost,
  configureShell,
  getDraftSlot,
  getHost,
  hostMetrics,
  shellProfile,
  withConnections,
} from './host.ts';
import {
  appAllowance,
  ConnectionBudgetError,
  HOST_OVERHEAD,
  HostLifecycle,
} from './host-lifecycle.ts';
import { runAs } from './owner.ts';

describe('HostLifecycle connection budget', () => {
  it('refuses at once when the budget is spent, and a release returns it', () => {
    const l = new HostLifecycle();
    l.configure({ maxAppConnections: 4 });
    const a = l.takeConnections(2);
    l.takeConnections(2);
    expect(l.connectionsInUse).toBe(4);
    expect(() => l.takeConnections(2)).toThrow(/no database connections left/);
    a();
    a(); // a second release changes nothing
    expect(l.connectionsInUse).toBe(2);
    expect(() => l.takeConnections(2)).not.toThrow();
  });

  it('derives the budget from maxOpenApps: a fixed allowance per app', () => {
    const l = new HostLifecycle();
    l.configure({ maxOpenApps: 2 });
    expect(l.metrics(0).maxConnections).toBe(2 * appAllowance());
    l.takeConnections(2 * appAllowance());
    expect(() => l.takeConnections(1)).toThrow(ConnectionBudgetError);
  });

  it('scales the derived budget with the pool size the config asks for', () => {
    const l = new HostLifecycle();
    l.configure({ maxOpenApps: 1 });
    // Pools of 10: a live pool, a draft pool and a swap's pool, plus overhead.
    const b = l.workerBudget;
    b.take(10);
    b.take(10);
    b.take(10);
    l.takeConnections(HOST_OVERHEAD.live + HOST_OVERHEAD.draft);
    expect(l.metrics(0).maxConnections).toBe(appAllowance(10));
    expect(() => b.take(10)).toThrow(ConnectionBudgetError);
  });

  it('limits nothing without a policy or without any cap', () => {
    const l = new HostLifecycle();
    for (let i = 0; i < 50; i++) l.takeConnections(10);
    l.configure({ idleMs: 1000 });
    for (let i = 0; i < 50; i++) l.takeConnections(10);
  });

  it('refuses a bad value and forgets the count on reset', () => {
    const l = new HostLifecycle();
    expect(() => l.configure({ maxAppConnections: 0 })).toThrow(RangeError);
    l.configure({ maxAppConnections: 2 });
    const release = l.takeConnections(2);
    l.configure({ maxAppConnections: 2 });
    release(); // an old release must not push the new count below zero
    expect(l.connectionsInUse).toBe(0);
    l.takeConnections(2);
    expect(l.connectionsInUse).toBe(2);
  });
});

let h: CloudHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const NOWHERE = 'postgres://svc_app@db.internal.example:1/apps';
const unreachable = (max: number) => ({
  config: (schema: string): DatabaseConfig => ({
    kind: 'postgres',
    schema,
    connection: { url: NOWHERE, max },
  }),
  provision: async () => {},
});

describe('a hosted app on the budget', () => {
  it('is refused at once when its pool does not fit, and says so plainly', async () => {
    h = await openCloudShell({
      appDatabase: unreachable(2),
      lifecycle: { maxAppConnections: 1 },
    });
    const started = Date.now();
    await expect(runAs(h.a, () => getHost())).rejects.toThrow(
      /no database connections left/,
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(hostMetrics().connections).toBe(0);
  });

  it('gives the connections back when the open fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    h = await openCloudShell({
      appDatabase: unreachable(2),
      lifecycle: { maxAppConnections: 4 },
    });
    for (let i = 0; i < 2; i++) {
      // Not the budget's refusal: the open itself fails (nothing listens).
      const err = await runAs(h.a, () => getHost()).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(String(err.message)).not.toMatch(/no database connections left/);
      expect(hostMetrics().connections).toBe(0);
    }
    log.mockRestore();
  });
});

describe('every worker reserves its pool for as long as it lives', () => {
  let dir: string;
  let url: string;
  const config = (max?: number): DatabaseConfig => ({
    kind: 'postgres',
    schema: 'app_x',
    connection: { url: NOWHERE, ...(max ? { max } : {}) },
  });
  const open = (
    budget: HostLifecycle,
    database: DatabaseConfig,
    dataDir = 'ok',
  ) =>
    new AppWorker(url, {
      dataDir,
      def: {} as never,
      version: 1,
      database,
      limits: { connections: budget.workerBudget },
    });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'budget-worker-'));
    url = join(dir, 'stub.mjs');
    // A worker that boots (or fails to, or crashes) without any database, and
    // reports the pool size it was given.
    writeFileSync(
      url,
      `import { parentPort, workerData as w } from 'node:worker_threads';
       if (w.dataDir === 'crash') process.exit(1);
       parentPort.on('message', () => {}); // stays alive until terminated
       if (w.dataDir === 'fail')
         parentPort.postMessage({ ready: false, error: 'connect ECONNREFUSED db.internal' });
       else parentPort.postMessage({ ready: true, pool: w.database.connection.max });`,
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reserves at start, sizes the pool as reserved, and returns on terminate', async () => {
    const l = new HostLifecycle();
    l.configure({ maxAppConnections: 10 });
    const w = open(l, config()); // names no pool: the budget's size is used
    expect(((await w.ready) as { pool?: number }).pool).toBe(
      l.workerBudget.poolSize,
    );
    expect(l.connectionsInUse).toBe(l.workerBudget.poolSize);
    await w.terminate();
    expect(l.connectionsInUse).toBe(0);
  });

  it('counts a second worker of the same app (a swap, a report) while it lives', async () => {
    const l = new HostLifecycle();
    l.configure({ maxAppConnections: 5 });
    const live = open(l, config(2));
    await live.ready;
    const next = open(l, config(2));
    await next.ready;
    expect(l.connectionsInUse).toBe(4);
    // The third does not fit: refused at once, nothing kept.
    expect(() => open(l, config(2))).toThrow(ConnectionBudgetError);
    expect(l.connectionsInUse).toBe(4);
    await live.terminate();
    expect(l.connectionsInUse).toBe(2);
    await next.terminate();
    expect(l.connectionsInUse).toBe(0);
  });

  it('returns the pool when the boot fails and when the thread crashes', async () => {
    const l = new HostLifecycle();
    l.configure({ maxAppConnections: 10 });
    const bad = open(l, config(3), 'fail');
    await expect(bad.ready).rejects.toThrow();
    await bad.terminate();
    const crashed = open(l, config(3), 'crash');
    await expect(crashed.ready).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 50));
    expect(l.connectionsInUse).toBe(0);
  });

  it('does not count PGlite or SQLite workers', async () => {
    const l = new HostLifecycle();
    l.configure({ maxAppConnections: 1 });
    const w = new AppWorker(url, {
      dataDir: 'ok',
      def: {} as never,
      version: 1,
      limits: { connections: l.workerBudget },
    });
    expect(l.connectionsInUse).toBe(0);
    await w.terminate();
  });
});

describe('a host reserves its overhead until it is gone', () => {
  const fake = () => {
    const calls: string[] = [];
    const host = {
      close: async () => void calls.push('close'),
      discardIfEmpty: async () => true,
      discard: async () => host.close(),
    };
    return { host: host as never, calls };
  };
  const setup = async () => {
    h = await openCloudShell({ lifecycle: { maxAppConnections: 10 } });
    await shellProfile();
    // Any request configures the shell's cloud profile and lifecycle.
    return config();
  };
  const config = (): DatabaseConfig => ({
    kind: 'postgres',
    schema: 'app_x',
    connection: { url: NOWHERE, max: 2 },
  });

  it.each([
    'close',
    'discard',
    'discardIfEmpty',
  ] as const)('returns it on %s', async (how) => {
    const db = await setup();
    const { host } = fake();
    const opened = await withConnections(db, 'live', async () => host);
    expect(hostMetrics().connections).toBe(HOST_OVERHEAD.live);
    await (opened as unknown as Record<string, () => Promise<unknown>>)[how]();
    expect(hostMetrics().connections).toBe(0);
  });

  it('keeps it when discardIfEmpty finds changes, and returns it on a failed open', async () => {
    const db = await setup();
    const { host } = fake();
    (
      host as unknown as { discardIfEmpty: () => Promise<boolean> }
    ).discardIfEmpty = async () => false;
    const opened = await withConnections(db, 'draft', async () => host);
    expect(await opened.discardIfEmpty()).toBe(false);
    expect(hostMetrics().connections).toBe(HOST_OVERHEAD.draft);
    await opened.close();
    await expect(
      withConnections(db, 'live', async () => {
        throw new Error('no');
      }),
    ).rejects.toThrow('no');
    expect(hostMetrics().connections).toBe(0);
  });

  it('is refused at once when the overhead does not fit, and not counted off a server', async () => {
    h = await openCloudShell({ lifecycle: { maxAppConnections: 1 } });
    await shellProfile();
    const pg: DatabaseConfig = {
      kind: 'postgres',
      schema: 'app_x',
      connection: { url: NOWHERE },
    };
    await expect(
      withConnections(pg, 'live', async () => fake().host),
    ).rejects.toThrow(ConnectionBudgetError);
    await withConnections({ kind: 'sqlite' }, 'live', async () => fake().host);
    expect(hostMetrics().connections).toBe(0);
  });
});

describe('no connections left during a publish check', () => {
  it('surfaces as a retryable refusal, not a stored replay_failed blocker', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'budget-check-'));
    const engine = createSqliteChangeEngine();
    const as = { author: 't', approved: true };
    const live = await AppHost.open(join(dir, 'live'), {
      store: new MemoryVersionStore(),
    });
    await live.execute({ type: 'defineModel', name: 'Chore', fields: {} }, as);
    const built = await engine.rebuild({ id: 'o' }, live, {
      draftDir: join(dir, 'draft'),
      store: new MemoryVersionStore(),
      commands: [
        {
          key: 'a',
          command: {
            type: 'addField',
            model: 'Chore',
            field: 'size',
            definition: { type: 'integer' },
          },
        },
      ],
      author: 't',
    });
    const spy = vi
      .spyOn(live, 'previewPublish')
      .mockRejectedValue(new ConnectionBudgetError());
    const err = await engine
      .checkBatch({ id: 'o' }, live, built.draft)
      .catch((e) => e);
    spy.mockRestore();
    expect(err).toBeInstanceOf(CapacityError);
    expect(err.code).toBe('refused');
    expect(err.message).toMatch(/try again/);
    await built.draft.close().catch(() => {});
    await live.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
});

type Inner = {
  database: DatabaseConfig;
  app: AppWorker;
  def: Record<string, unknown>;
  version: number;
  workerUrl: string;
  swap(d: unknown, v: number, m?: unknown): Promise<unknown>;
};

async function stubHost(budget = 2) {
  const dir = mkdtempSync(join(tmpdir(), 'budget-swap-'));
  const stub = join(dir, 'stub.mjs');
  writeFileSync(
    stub,
    `import { parentPort, workerData as w } from 'node:worker_threads';
     if (w.def && w.def.die) process.exit(1); // gone before it is ready
     parentPort.on('message', () => {});
     parentPort.postMessage({ ready: true });`,
  );
  const l = new HostLifecycle();
  l.configure({ maxAppConnections: budget });
  const host = await AppHost.open(join(dir, 'live'), {
    store: new MemoryVersionStore(),
    workerUrl: stub,
    workerLimits: { connections: l.workerBudget },
  });
  // Make the host a server PostgreSQL one (the stub never connects anywhere).
  const inner = host as unknown as Inner;
  inner.database = {
    kind: 'postgres',
    schema: 'app_x',
    connection: { url: NOWHERE, max: 2 },
  };
  await host.restartApp();
  expect(l.connectionsInUse).toBe(2);
  return {
    l,
    host,
    inner,
    done: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const MIGRATION = { steps: [{}], direction: 'up', version: 1 };

describe('a migrating swap holds its pool across the retire', () => {
  it('cannot be left without an app by another taking the freed connections', async () => {
    const { l, host, inner, done } = await stubHost();
    // Another app, report or rehearsal asks for connections the moment the
    // old worker is gone.
    let stolen = false;
    const retire = inner.app.retire.bind(inner.app);
    inner.app.retire = async (ms?: number) => {
      await retire(ms);
      try {
        l.takeConnections(2);
        stolen = true;
      } catch {
        /* the budget is still held: nothing to take */
      }
    };
    await inner.swap(inner.def, inner.version, MIGRATION).catch(() => {});
    expect(stolen).toBe(false);
    expect(host.appAlive).toBe(true);
    expect(l.connectionsInUse).toBe(2);
    await done();
    expect(l.connectionsInUse).toBe(0);
  });

  it('keeps it when the replacement dies before it is ready, for the rollback', async () => {
    const { l, host, inner, done } = await stubHost();
    let stolen = false;
    const terminate = AppWorker.prototype.terminate;
    const spy = vi
      .spyOn(AppWorker.prototype, 'terminate')
      .mockImplementation(async function (this: AppWorker) {
        const r = await terminate.call(this);
        try {
          l.takeConnections(2); // another app, once the dead one is cleared
          stolen = true;
        } catch {
          /* still held */
        }
        return r;
      });
    const err = await inner
      .swap({ ...inner.def, die: true }, inner.version + 1, MIGRATION)
      .catch((e) => e);
    spy.mockRestore();
    expect(err).toBeInstanceOf(Error);
    expect(stolen).toBe(false);
    expect(host.appAlive).toBe(true); // the old app is back
    expect(l.connectionsInUse).toBe(2);
    await done();
    expect(l.connectionsInUse).toBe(0);
  });

  it('surfaces a worker that cannot start as itself, not as a failed change', async () => {
    const { host, inner, done } = await stubHost(4); // room for a second pool
    inner.workerUrl = 'not-a-path.mjs'; // refused synchronously by the thread API
    const err = (await inner
      .swap(inner.def, inner.version)
      .catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(String(err.message)).not.toMatch(/did not start with this change/);
    expect(host.appAlive).toBe(true); // the running app was never touched
    inner.workerUrl = (host as unknown as { workerUrl: string }).workerUrl;
    await done();
  });
});
