// The cloud profile's process-wide connection budget and what an owner is told
// when a database fails (#5464). WHAT THIS PROVES: the budget's accounting and
// refusal, that a failed open gives its connections back, and that a driver's
// text never reaches the owner. WHAT IT DOES NOT: a real server's connection
// limit (PostgreSQL is the on-demand workflow's); the "postgres" configs below
// point at a port nothing listens on, so no connection is ever made.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importPGlite } from '@happyvertical/sql/pglite';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { DatabaseConfig, PGliteClient } from '../../engine/db/index.ts';
import { UNTRUSTED_MESSAGE } from '../../engine/errors.ts';
import { EngineError, WorkerCrashedError } from '../../engine/index.ts';
import { AppWorker } from '../../engine/worker-handle.ts';
import { returnedFailure } from './approvals.ts';
import { addChangeCard, flushChecks } from './changes.ts';
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
import { errorResponse, HttpError } from './http.ts';
import { runAs } from './owner.ts';
import {
  GENERIC_OWNER_ERROR,
  ownerMessage,
  ownerToolText,
} from './owner-errors.ts';

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

describe('a failed app tool', () => {
  it("hides driver text in its result and keeps the app's own messages", () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const t of [
      'connect ECONNREFUSED 10.0.3.7:5432',
      'password authentication failed for user "svc_app"',
      'remaining connection slots are reserved for roles with the SUPERUSER attribute',
    ])
      expect(ownerToolText(t, 'x')).toBe('x');
    expect(ownerToolText('title is required', 'x')).toBe('title is required');
    expect(
      returnedFailure('tool', {
        isError: true,
        content: [{ text: 'connect ECONNREFUSED db.internal.example:5432' }],
      }),
    ).toBe('the tool reported an error');
    log.mockRestore();
  });
});

describe('ownerMessage', () => {
  it('keeps our own messages and hides a driver error, logging the detail', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(ownerMessage(new EngineError('no such model', 'not_found'))).toBe(
      'no such model',
    );
    expect(ownerMessage(new HttpError(400, 'bad input'))).toBe('bad input');
    const driver = new Error(
      'connect ECONNREFUSED db.internal.example:5432 as svc_app',
    );
    expect(ownerMessage(driver)).toBe(GENERIC_OWNER_ERROR);
    // The engine wraps worker and driver text in an EngineError: still hidden.
    const wrapped = EngineError.untrusted(driver.message, 'refused');
    expect(ownerMessage(wrapped)).toBe(UNTRUSTED_MESSAGE);
    const res = errorResponse(wrapped);
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).not.toMatch(
      /db\.internal|svc_app/,
    );
    const crashed = new WorkerCrashedError(
      `the app stopped: ${driver.message}`,
      true,
    );
    expect(ownerMessage(crashed)).toBe(UNTRUSTED_MESSAGE);
    expect(ownerMessage(driver, 'it failed')).toBe('it failed');
    expect(log).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('db.internal.example'),
    );
    log.mockRestore();
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
      // And what an owner would be shown names no server.
      const body = await errorResponse(err).text();
      expect(body).not.toMatch(/db\.internal|svc_app/);
    }
    log.mockRestore();
  });
});

describe('a draft that cannot open', () => {
  it('tells the owner a fixed sentence and keeps the driver text in the log', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { PGlite } = await importPGlite();
    const pg = (await PGlite.create()) as PGliteClient;
    let broken = false;
    // The side schema's queries fail the way a lost connection does.
    const client = new Proxy(pg, {
      get(target, prop) {
        const v = Reflect.get(target, prop, target);
        if (typeof v !== 'function') return v;
        // PGlite keeps private fields: always call it on the instance itself.
        if (prop !== 'query' && prop !== 'exec') return v.bind(target);
        return (sql: string, ...rest: unknown[]) => {
          if (broken && `${sql}${JSON.stringify(rest)}`.includes('__d'))
            throw new Error(
              'connect ECONNREFUSED db.internal.example:5432 (user svc_app)',
            );
          return v.call(target, sql, ...rest);
        };
      },
    }) as PGliteClient;
    h = await openCloudShell({
      appDatabase: {
        config: (schema): DatabaseConfig => ({
          kind: 'pglite',
          schema,
          client,
        }),
        provision: async (schema) => {
          await pg.exec(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
        },
      },
    });
    await runAs(h.a, () =>
      addChangeCard({
        commands: [{ type: 'defineModel', name: 'Later', fields: {} } as never],
        source: 'api',
      }),
    );
    await flushChecks();
    await closeHost(); // a restart: the draft is adopted again
    broken = true;
    const slot = await runAs(h.a, () => getDraftSlot());
    await closeHost();
    expect(slot?.problem).toBeTruthy();
    expect(slot?.problem).not.toMatch(/db\.internal|svc_app|ECONNREFUSED/);
    expect(
      log.mock.calls.some((c) => String(c[1]).includes('db.internal.example')),
    ).toBe(true);
    log.mockRestore();
    await pg.close().catch(() => {});
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
    const failure = await bad.ready.catch((e) => e);
    // The worker's text names a server: the engine marks it as not ours to show.
    expect(failure).toBeInstanceOf(EngineError);
    expect(failure.untrusted).toBe(true);
    expect(ownerMessage(failure)).toBe(UNTRUSTED_MESSAGE);
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
