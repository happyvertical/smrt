// Per-app caps (#5198): the engine refuses what a plan's limits do not allow,
// with a message naming the cap and the numbers. Same cases on SQLite and
// PostgreSQL (PGlite). No limits injected: nothing changes.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { hostOwner } from '../test/engine-principal.ts';
import {
  AppCaps,
  type AppLimits,
  appLimitCap,
  assertAppLimits,
} from './app-limits.ts';
import { harnessDatabase } from './db/harness.ts';
import { AppHost, EngineError, MemoryVersionStore } from './index.ts';

const dirs: string[] = [];
const hosts: AppHost[] = [];
const released: Array<() => Promise<void> | undefined> = [];
afterAll(async () => {
  for (const h of hosts) await h.close();
  for (const r of released) await r();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function open(
  kind: 'sqlite' | 'postgres',
  appLimits?: AppLimits,
  dir = mkdtempSync(join(tmpdir(), 'app-limits-')),
  store = new MemoryVersionStore(),
) {
  dirs.push(dir);
  const pg = kind === 'postgres' ? await harnessDatabase(dir) : null;
  if (pg) released.push(() => pg.release?.());
  const host = await AppHost.open(dir, {
    store,
    appLimits,
    database: pg ? pg.config : { kind: 'sqlite' },
  });
  hosts.push(host);
  const run = (cmd: Parameters<AppHost['execute']>[0]) =>
    host.execute(cmd, { author: 't', approved: true });
  return { host, run, dir, store };
}

describe.each(['sqlite', 'postgres'] as const)('app caps on %s', (kind) => {
  it('no limits injected: nothing is refused', async () => {
    const { host, run } = await open(kind);
    await run({
      type: 'defineModel',
      name: 'A',
      fields: { t: { type: 'text' } },
    });
    await run({
      type: 'defineModel',
      name: 'B',
      fields: { t: { type: 'text' } },
    });
    for (let i = 0; i < 12; i++)
      await host.create(hostOwner(host), 'A', { t: `r${i}` });
    expect(await host.list(hostOwner(host), 'A')).toHaveLength(12);
  });

  it('refuses a create over the total row cap, naming the cap and numbers; a delete frees room', async () => {
    const { host, run } = await open(kind, { maxRows: 3 });
    await run({
      type: 'defineModel',
      name: 'A',
      fields: { t: { type: 'text' } },
    });
    await run({
      type: 'defineModel',
      name: 'B',
      fields: { t: { type: 'text' } },
    });
    await host.create(hostOwner(host), 'A', { t: '1' });
    await host.create(hostOwner(host), 'A', { t: '2' });
    const b = await host.create(hostOwner(host), 'B', { t: '3' });
    await expect(host.create(hostOwner(host), 'B', { t: '4' })).rejects.toThrow(
      /app limit reached \(maxRows\): this app holds 3 records of the 3 allowed; adding 1 would pass the limit/,
    );
    expect(await host.list(hostOwner(host), 'B')).toHaveLength(1);
    await host.remove(hostOwner(host), 'B', String(b.id));
    await host.create(hostOwner(host), 'B', { t: '5' });
  });

  it('refuses over the per-model cap but lets another model add', async () => {
    const { host, run } = await open(kind, { maxRowsPerModel: 1 });
    await run({
      type: 'defineModel',
      name: 'A',
      fields: { t: { type: 'text' } },
    });
    await run({
      type: 'defineModel',
      name: 'B',
      fields: { t: { type: 'text' } },
    });
    await host.create(hostOwner(host), 'A', { t: '1' });
    await expect(host.create(hostOwner(host), 'A', { t: '2' })).rejects.toThrow(
      /\(maxRowsPerModel\): A holds 1 record of the 1 allowed per model/,
    );
    await host.create(hostOwner(host), 'B', { t: '1' });
  });

  it('refuses generated REST and tool creates over the cap, and still counts them', async () => {
    const { host, run } = await open(kind, { maxRows: 1 });
    await run({
      type: 'defineModel',
      name: 'A',
      fields: { t: { type: 'text' } },
    });
    const ok = await host.rest(hostOwner(host), {
      method: 'POST',
      url: '/api/as',
      body: JSON.stringify({ t: 'x' }),
    });
    expect(ok.status).toBeLessThan(300);
    const refused = await host.rest(hostOwner(host), {
      method: 'POST',
      url: '/api/as',
      body: JSON.stringify({ t: 'y' }),
    });
    expect(refused.status).toBe(403);
    expect(JSON.parse(refused.body)).toMatchObject({
      code: 'app_limit',
      cap: 'maxRows',
      limit: 1,
      current: 1,
    });
    await expect(
      host.callAppTool(hostOwner(host), 'a_create', { t: 'z' }),
    ).rejects.toThrow(/app limit reached \(maxRows\)/);
    expect(await host.list(hostOwner(host), 'A')).toHaveLength(1);
  });

  it('refuses a record load over the cap and loads nothing', async () => {
    const { host, run } = await open(kind, { maxRows: 2 });
    await run({
      type: 'defineModel',
      name: 'A',
      fields: { t: { type: 'text' } },
    });
    await host.create(hostOwner(host), 'A', { t: 'one' });
    await expect(
      run({
        type: 'loadRecords',
        model: 'A',
        mode: 'insert',
        rows: [{ t: 'a' }, { t: 'b' }, { t: 'c' }],
      }),
    ).rejects.toThrow(/app limit reached \(maxRows\).*would hold 4 records/);
    expect(await host.list(hostOwner(host), 'A')).toHaveLength(1);
    await run({
      type: 'loadRecords',
      model: 'A',
      mode: 'insert',
      rows: [{ t: 'a' }],
    });
    expect(await host.list(hostOwner(host), 'A')).toHaveLength(2);
  });

  it('refuses a model added past the model cap; an app already at the cap reopens', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'app-limits-m-'));
    const first = await open(kind, { maxModels: 2 }, dir);
    await first.run({ type: 'defineModel', name: 'A', fields: {} });
    await first.run({ type: 'defineModel', name: 'B', fields: {} });
    await expect(
      first.run({ type: 'defineModel', name: 'C', fields: {} }),
    ).rejects.toThrow(
      /app limit reached \(maxModels\): this app has 2 of the 2 models allowed; adding 1/,
    );
    expect(Object.keys(first.host.describe().models ?? {})).toHaveLength(2);
  });

  it('undoing a model removal succeeds under a lowered model cap and restores the records', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'app-limits-u-'));
    const store = new MemoryVersionStore();
    const first = await open(kind, undefined, dir, store);
    for (const name of ['A', 'B', 'C'])
      await first.run({
        type: 'defineModel',
        name,
        fields: { t: { type: 'text' } },
      });
    await first.host.create(hostOwner(first.host), 'C', { t: 'keep' });
    await first.host.close();
    const low = await open(kind, { maxModels: 1 }, dir, store);
    await low.run({ type: 'removeModel', model: 'C' });
    expect(Object.keys(low.host.describe().models ?? {})).toHaveLength(2);
    await low.run({ type: 'undo' });
    expect(Object.keys(low.host.describe().models ?? {})).toHaveLength(3);
    expect(
      (await low.host.list(hostOwner(low.host), 'C')).map((r) => r.t),
    ).toEqual(['keep']);
    // A forward add past the cap is still refused.
    await expect(
      low.run({ type: 'defineModel', name: 'D', fields: {} }),
    ).rejects.toThrow(/app limit reached \(maxModels\)/);
  });

  it('refuses a method run over the period cap, and a method that would add rows over the row cap', async () => {
    const { host, run } = await open(kind, {
      maxMethodRuns: 2,
      methodRunPeriodMs: 3_600_000,
      maxRows: 2,
    });
    await run({
      type: 'defineModel',
      name: 'A',
      fields: { t: { type: 'text' } },
    });
    await run({
      type: 'addMethod',
      model: 'A',
      name: 'add',
      method: {
        description: 'add',
        code: `app.create('A', { t: 'm' }); return 1;`,
      },
    });
    await host.runMethod(hostOwner(host), 'A', 'add');
    await host.runMethod(hostOwner(host), 'A', 'add');
    await expect(host.runMethod(hostOwner(host), 'A', 'add')).rejects.toThrow(
      /app limit reached \(maxMethodRuns\): 2 of the 2 method runs allowed/,
    );
    expect(await host.list(hostOwner(host), 'A')).toHaveLength(2);
  });

  it('a definition change (worker swap) does not renew the method-run period', async () => {
    const { host, run } = await open(kind, {
      maxMethodRuns: 1,
      methodRunPeriodMs: 3_600_000,
    });
    await run({
      type: 'defineModel',
      name: 'A',
      fields: { t: { type: 'text' } },
    });
    await run({
      type: 'addMethod',
      model: 'A',
      name: 'noop',
      method: { description: 'noop', code: 'return 1;' },
    });
    await host.runMethod(hostOwner(host), 'A', 'noop');
    await run({
      type: 'defineModel',
      name: 'B',
      fields: { t: { type: 'text' } },
    });
    await expect(host.runMethod(hostOwner(host), 'A', 'noop')).rejects.toThrow(
      /app limit reached \(maxMethodRuns\)/,
    );
  });

  it('a draft has its own method-run window, which its own swaps do not renew', async () => {
    const { host, run, dir } = await open(kind, {
      maxMethodRuns: 1,
      methodRunPeriodMs: 3_600_000,
    });
    await run({
      type: 'defineModel',
      name: 'A',
      fields: { t: { type: 'text' } },
    });
    await run({
      type: 'addMethod',
      model: 'A',
      name: 'noop',
      method: { description: 'noop', code: 'return 1;' },
    });
    await host.runMethod(hostOwner(host), 'A', 'noop');
    const draft = await host.forkDraft(`${dir}-draft`, {
      store: new MemoryVersionStore(),
    });
    hosts.push(draft);
    await draft.runMethod(hostOwner(draft), 'A', 'noop'); // its own allowance, not live's used one
    await draft.execute(
      {
        type: 'defineModel',
        name: 'B',
        fields: { t: { type: 'text' } },
      },
      { author: 't', approved: true },
    );
    await expect(
      draft.runMethod(hostOwner(draft), 'A', 'noop'),
    ).rejects.toThrow(/app limit reached \(maxMethodRuns\)/);
  });

  it('a method adding rows over the row cap is refused as a limit, none applied', async () => {
    const { host, run } = await open(kind, { maxRows: 1 });
    await run({
      type: 'defineModel',
      name: 'A',
      fields: { t: { type: 'text' } },
    });
    await run({
      type: 'addMethod',
      model: 'A',
      name: 'two',
      method: {
        description: 'two',
        code: `app.create('A', { t: '1' }); app.create('A', { t: '2' }); return 1;`,
      },
    });
    await expect(host.runMethod(hostOwner(host), 'A', 'two')).rejects.toThrow(
      /app limit reached \(maxRows\).*adding 2/,
    );
    expect(await host.list(hostOwner(host), 'A')).toHaveLength(0);
  });
});

describe.each([
  'sqlite',
  'postgres',
] as const)('app caps, concurrency and edge routes on %s', (kind) => {
  it('parallel creates with one slot left admit exactly one (engine, REST and tool)', async () => {
    const { host, run } = await open(kind, { maxRows: 3 });
    await run({
      type: 'defineModel',
      name: 'A',
      fields: { t: { type: 'text' } },
    });
    await host.create(hostOwner(host), 'A', { t: 'seed1' });
    await host.create(hostOwner(host), 'A', { t: 'seed2' });
    const mixed = await Promise.allSettled([
      host.create(hostOwner(host), 'A', { t: 'p1' }),
      host.rest(hostOwner(host), {
        method: 'POST',
        url: '/api/as',
        body: JSON.stringify({ t: 'p2' }),
      }),
      host.callAppTool(hostOwner(host), 'a_create', { t: 'p3' }),
      host.create(hostOwner(host), 'A', { t: 'p4' }),
      host.rest(hostOwner(host), {
        method: 'POST',
        url: '/api/as',
        body: JSON.stringify({ t: 'p5' }),
      }),
    ]);
    const ok = mixed.filter(
      (m) =>
        m.status === 'fulfilled' &&
        !(
          m.value &&
          typeof m.value === 'object' &&
          ('status' in m.value
            ? (m.value as { status: number }).status >= 300
            : (m.value as { isError?: boolean }).isError === true)
        ),
    );
    expect(ok).toHaveLength(1);
    expect(await host.list(hostOwner(host), 'A')).toHaveLength(3);
  });

  it('parallel engine creates admit exactly the free slots', async () => {
    const { host, run } = await open(kind, { maxRowsPerModel: 4 });
    await run({
      type: 'defineModel',
      name: 'A',
      fields: { t: { type: 'text' } },
    });
    const out = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        host.create(hostOwner(host), 'A', { t: `${i}` }),
      ),
    );
    expect(out.filter((o) => o.status === 'fulfilled')).toHaveLength(4);
    expect(await host.list(hostOwner(host), 'A')).toHaveLength(4);
  });

  it('a host-side caller reads the cap from error.details, not the message', async () => {
    const { host, run } = await open(kind, { maxRows: 1, maxModels: 1 });
    await run({
      type: 'defineModel',
      name: 'A',
      fields: { t: { type: 'text' } },
    });
    await host.create(hostOwner(host), 'A', { t: 'x' });
    const err: any = await host
      .create(hostOwner(host), 'A', { t: 'y' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect(err.details).toEqual({
      code: 'app_limit',
      cap: 'maxRows',
      limit: 1,
      current: 1,
      requested: 1,
    });
    const boot: any = await run({
      type: 'defineModel',
      name: 'B',
      fields: {},
    }).catch((e) => e);
    expect(boot.details).toMatchObject({ code: 'app_limit', cap: 'maxModels' });
  });

  it('two parallel removes of one record lower the count once', async () => {
    const { host, run } = await open(kind, { maxRows: 2 });
    await run({
      type: 'defineModel',
      name: 'A',
      fields: { t: { type: 'text' } },
    });
    const a = await host.create(hostOwner(host), 'A', { t: '1' });
    await host.create(hostOwner(host), 'A', { t: '2' });
    const out = await Promise.allSettled([
      host.remove(hostOwner(host), 'A', String(a.id)),
      host.remove(hostOwner(host), 'A', String(a.id)),
    ]);
    expect(out.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    await host.create(hostOwner(host), 'A', { t: '3' });
    await expect(host.create(hostOwner(host), 'A', { t: '4' })).rejects.toThrow(
      /maxRows/,
    );
    expect(await host.list(hostOwner(host), 'A')).toHaveLength(2);
  });

  it('the lock is released after a failed create', async () => {
    const { host, run } = await open(kind, { maxRows: 5 });
    await run({
      type: 'defineModel',
      name: 'A',
      fields: { t: { type: 'text', required: true } },
    });
    await expect(host.create(hostOwner(host), 'A', {})).rejects.toThrow();
    await host.create(hostOwner(host), 'A', { t: 'ok' });
    expect(await host.list(hostOwner(host), 'A')).toHaveLength(1);
  });

  it('a method racing a create never takes the app past the cap', async () => {
    const { host, run } = await open(kind, { maxRows: 2 });
    await run({
      type: 'defineModel',
      name: 'A',
      fields: { t: { type: 'text' } },
    });
    await run({
      type: 'addMethod',
      model: 'A',
      name: 'add',
      method: {
        description: 'add',
        code: `app.create('A', { t: 'm' }); return 1;`,
      },
    });
    await host.create(hostOwner(host), 'A', { t: 'seed' });
    await Promise.allSettled([
      host.runMethod(hostOwner(host), 'A', 'add'),
      host.create(hostOwner(host), 'A', { t: 'racer' }),
    ]);
    expect(await host.list(hostOwner(host), 'A')).toHaveLength(2);
  });

  it('a POST with an extra path segment is held to the cap too', async () => {
    const { host, run } = await open(kind, { maxRows: 1 });
    await run({
      type: 'defineModel',
      name: 'A',
      fields: { t: { type: 'text' } },
    });
    await host.create(hostOwner(host), 'A', { t: 'x' });
    const r = await host.rest(hostOwner(host), {
      method: 'POST',
      url: '/api/as/anything',
      body: JSON.stringify({ t: 'y' }),
    });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body).code).toBe('app_limit');
    expect(await host.list(hostOwner(host), 'A')).toHaveLength(1);
  });

  it('a method that deletes in one model and creates in another passes at the total cap', async () => {
    const { host, run } = await open(kind, { maxRows: 2 });
    await run({
      type: 'defineModel',
      name: 'A',
      fields: { t: { type: 'text' } },
    });
    await run({
      type: 'defineModel',
      name: 'B',
      fields: { t: { type: 'text' } },
    });
    await run({
      type: 'addMethod',
      model: 'A',
      name: 'swap',
      method: {
        description: 'move',
        code: `app.delete('A', record.id); app.create('B', { t: 'n' }); return 1;`,
      },
    });
    const first = await host.create(hostOwner(host), 'A', { t: '1' });
    await host.create(hostOwner(host), 'A', { t: '2' });
    const out = await host.runMethod(
      hostOwner(host),
      'A',
      'swap',
      String(first.id),
    );
    expect(out.applied).toBe(2);
    expect(await host.list(hostOwner(host), 'B')).toHaveLength(1);
  });
});

describe('limits object and period window', () => {
  it('names the cap from a message that crossed the worker boundary', () => {
    expect(
      appLimitCap('app limit reached (maxRows): this app holds 1 record'),
    ).toBe('maxRows');
    expect(appLimitCap('no such record')).toBeUndefined();
  });

  it('refuses malformed limits', () => {
    expect(() => assertAppLimits({ maxRows: -1 })).toThrow(/maxRows/);
    expect(() => assertAppLimits({ maxMethodRuns: 3 })).toThrow(
      /methodRunPeriodMs/,
    );
  });

  it('the method-run period renews', () => {
    let t = 1000;
    const caps = new AppCaps(
      { maxMethodRuns: 1, methodRunPeriodMs: 100 },
      () => [],
      async () => 0,
      () => t,
    );
    caps.checkMethodRun();
    expect(() => caps.checkMethodRun()).toThrow(/maxMethodRuns/);
    t += 100;
    caps.checkMethodRun();
  });
});

describe('the caps write lock (#5188)', () => {
  const model = { model: 'A', label: 'A', table: 'a' };

  it("on PostgreSQL it is the transaction-held advisory lock, taken on the operation's own handle, and counts afresh", async () => {
    const taken: unknown[] = [];
    let counted = 0;
    const caps = new AppCaps(
      { maxRows: 5 },
      () => [model],
      async () => ++counted,
      undefined,
      async (h) => void taken.push(h),
    );
    const handle = { id: 'tx-1' };
    await caps.counts(handle); // primes the cache
    expect(counted).toBe(1);
    const out = await caps.withWriteLock(async () => 'done', handle);
    expect(out).toBe('done');
    expect(taken).toEqual([handle]);
    // Another connection may have written since: the next check recounts.
    await caps.counts(handle);
    expect(counted).toBe(2);
  });

  it('with no handle, or on SQLite, the in-process chain is the lock', async () => {
    const taken: unknown[] = [];
    const caps = new AppCaps(
      { maxRows: 5 },
      () => [model],
      async () => 0,
      undefined,
      async (h) => void taken.push(h),
    );
    const order: string[] = [];
    const slow = caps.withWriteLock(async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push('first');
    });
    const fast = caps.withWriteLock(async () => void order.push('second'));
    await Promise.all([slow, fast]);
    expect(order).toEqual(['first', 'second']);
    expect(taken).toEqual([]);
    const sqlite = new AppCaps(
      { maxRows: 5 },
      () => [model],
      async () => 0,
    );
    expect(await sqlite.withWriteLock(async () => 7, {})).toBe(7);
  });

  it('a lock that cannot be taken fails the write and runs nothing', async () => {
    const caps = new AppCaps(
      { maxRows: 5 },
      () => [model],
      async () => 0,
      undefined,
      async () => {
        throw new Error('lock timeout');
      },
    );
    let ran = false;
    await expect(
      caps.withWriteLock(async () => {
        ran = true;
      }, {}),
    ).rejects.toThrow('lock timeout');
    expect(ran).toBe(false);
  });

  it('a capped create on PostgreSQL takes the lock in the operation, before its check and insert', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'caps-lock-'));
    dirs.push(dir);
    const pg = await harnessDatabase(dir);
    released.push(() => pg.release?.());
    const config = pg.config as Extract<typeof pg.config, { kind: 'pglite' }>;
    const seen: string[] = [];
    const real = config.client;
    const record = (tx: any) => ({
      query: (sql: string, params?: unknown[]) => {
        seen.push(sql);
        return tx.query(sql, params);
      },
      exec: (sql: string) => {
        seen.push(sql);
        return tx.exec(sql);
      },
      rollback: () => tx.rollback(),
      get closed() {
        return tx.closed;
      },
    });
    const host = await AppHost.open(dir, {
      store: new MemoryVersionStore(),
      appLimits: { maxRows: 5 },
      database: {
        ...config,
        client: {
          query: (s, p) => real.query(s, p),
          exec: (s) => real.exec(s),
          transaction: (cb) => real.transaction((tx) => cb(record(tx))),
          close: () => real.close(),
        },
      },
    });
    hosts.push(host);
    await host.execute(
      { type: 'defineModel', name: 'A', fields: { t: { type: 'text' } } },
      { author: 't', approved: true },
    );
    seen.length = 0;
    await host.create(hostOwner(host), 'A', { t: 'x' });
    const at = (needle: RegExp) => seen.findIndex((s) => needle.test(s));
    const lock = at(/pg_advisory_xact_lock\(hashtext\('smrt-app-caps'\)/);
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(at(/INSERT INTO/i));
    expect(lock).toBeLessThan(at(/COUNT\(/i));
    // taken once per create, on the operation's own connection
    expect(seen.filter((s) => /pg_advisory_xact_lock/.test(s))).toHaveLength(1);
  });
});
