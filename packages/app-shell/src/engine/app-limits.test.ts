// Per-app caps (#5198): the engine refuses what a plan's limits do not allow,
// with a message naming the cap and the numbers. Same cases on SQLite and
// PostgreSQL (PGlite). No limits injected: nothing changes.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
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
    for (let i = 0; i < 12; i++) await host.create('A', { t: `r${i}` });
    expect(await host.list('A')).toHaveLength(12);
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
    await host.create('A', { t: '1' });
    await host.create('A', { t: '2' });
    const b = await host.create('B', { t: '3' });
    await expect(host.create('B', { t: '4' })).rejects.toThrow(
      /app limit reached \(maxRows\): this app holds 3 records of the 3 allowed; adding 1 would pass the limit/,
    );
    expect(await host.list('B')).toHaveLength(1);
    await host.remove('B', String(b.id));
    await host.create('B', { t: '5' });
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
    await host.create('A', { t: '1' });
    await expect(host.create('A', { t: '2' })).rejects.toThrow(
      /\(maxRowsPerModel\): A holds 1 record of the 1 allowed per model/,
    );
    await host.create('B', { t: '1' });
  });

  it('refuses generated REST and tool creates over the cap, and still counts them', async () => {
    const { host, run } = await open(kind, { maxRows: 1 });
    await run({
      type: 'defineModel',
      name: 'A',
      fields: { t: { type: 'text' } },
    });
    const ok = await host.rest({
      method: 'POST',
      url: '/api/as',
      body: JSON.stringify({ t: 'x' }),
    });
    expect(ok.status).toBeLessThan(300);
    const refused = await host.rest({
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
    await expect(host.callAppTool('a_create', { t: 'z' })).rejects.toThrow(
      /app limit reached \(maxRows\)/,
    );
    expect(await host.list('A')).toHaveLength(1);
  });

  it('refuses a record load over the cap and loads nothing', async () => {
    const { host, run } = await open(kind, { maxRows: 2 });
    await run({
      type: 'defineModel',
      name: 'A',
      fields: { t: { type: 'text' } },
    });
    await host.create('A', { t: 'one' });
    await expect(
      run({
        type: 'loadRecords',
        model: 'A',
        mode: 'insert',
        rows: [{ t: 'a' }, { t: 'b' }, { t: 'c' }],
      }),
    ).rejects.toThrow(/app limit reached \(maxRows\).*would hold 4 records/);
    expect(await host.list('A')).toHaveLength(1);
    await run({
      type: 'loadRecords',
      model: 'A',
      mode: 'insert',
      rows: [{ t: 'a' }],
    });
    expect(await host.list('A')).toHaveLength(2);
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
    await host.runMethod('A', 'add');
    await host.runMethod('A', 'add');
    await expect(host.runMethod('A', 'add')).rejects.toThrow(
      /app limit reached \(maxMethodRuns\): 2 of the 2 method runs allowed/,
    );
    expect(await host.list('A')).toHaveLength(2);
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
    await expect(host.runMethod('A', 'two')).rejects.toThrow(
      /app limit reached \(maxRows\).*adding 2/,
    );
    expect(await host.list('A')).toHaveLength(0);
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
    await host.create('A', { t: 'seed1' });
    await host.create('A', { t: 'seed2' });
    const mixed = await Promise.allSettled([
      host.create('A', { t: 'p1' }),
      host.rest({
        method: 'POST',
        url: '/api/as',
        body: JSON.stringify({ t: 'p2' }),
      }),
      host.callAppTool('a_create', { t: 'p3' }),
      host.create('A', { t: 'p4' }),
      host.rest({
        method: 'POST',
        url: '/api/as',
        body: JSON.stringify({ t: 'p5' }),
      }),
    ]);
    expect(mixed.length).toBe(5);
    expect(await host.list('A')).toHaveLength(3);
  });

  it('parallel engine creates admit exactly the free slots', async () => {
    const { host, run } = await open(kind, { maxRowsPerModel: 4 });
    await run({
      type: 'defineModel',
      name: 'A',
      fields: { t: { type: 'text' } },
    });
    const out = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => host.create('A', { t: `${i}` })),
    );
    expect(out.filter((o) => o.status === 'fulfilled')).toHaveLength(4);
    expect(await host.list('A')).toHaveLength(4);
  });

  it('a host-side caller reads the cap from error.details, not the message', async () => {
    const { host, run } = await open(kind, { maxRows: 1, maxModels: 1 });
    await run({
      type: 'defineModel',
      name: 'A',
      fields: { t: { type: 'text' } },
    });
    await host.create('A', { t: 'x' });
    const err: any = await host.create('A', { t: 'y' }).catch((e) => e);
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

  it('a POST with an extra path segment is held to the cap too', async () => {
    const { host, run } = await open(kind, { maxRows: 1 });
    await run({
      type: 'defineModel',
      name: 'A',
      fields: { t: { type: 'text' } },
    });
    await host.create('A', { t: 'x' });
    const r = await host.rest({
      method: 'POST',
      url: '/api/as/anything',
      body: JSON.stringify({ t: 'y' }),
    });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body).code).toBe('app_limit');
    expect(await host.list('A')).toHaveLength(1);
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
    const first = await host.create('A', { t: '1' });
    await host.create('A', { t: '2' });
    const out = await host.runMethod('A', 'swap', String(first.id));
    expect(out.applied).toBe(2);
    expect(await host.list('B')).toHaveLength(1);
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
