import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AppHost,
  checkSyntax,
  EngineError,
  MemoryVersionStore,
  runMethod,
  SANDBOX_LIMITS,
  SandboxError,
  validateWrites,
} from './index.ts';

const input = { record: null, params: {}, data: {} };
const run = (code: string, limits = {}) => runMethod(code, input, limits);

describe('sandbox (pure)', () => {
  it('returns a result and proposed writes as JSON', async () => {
    const out = await run(
      `app.create('Chore', { title: 'a' }); app.update('Chore', 'x', { done: true }); app.delete('Chore', 'y'); return { n: 1 };`,
    );
    expect(out.result).toEqual({ n: 1 });
    expect(out.writes.map((w) => w.op)).toEqual(['create', 'update', 'delete']);
  });

  it('interrupts an infinite loop quickly', async () => {
    const t0 = Date.now();
    await expect(run('while (true) {}')).rejects.toThrow(/ran too long/);
    expect(Date.now() - t0).toBeLessThan(2000);
    await expect(
      run('for (;;) { Math.random(); }', { timeoutMs: 100 }),
    ).rejects.toBeInstanceOf(SandboxError);
  });

  it('has no process, require, fetch, timers or other host globals', async () => {
    const out = await run(`
      return [
        typeof process, typeof require, typeof fetch, typeof setTimeout,
        typeof Buffer, typeof XMLHttpRequest, typeof module, typeof importScripts,
        typeof globalThis.process, typeof __input, typeof __code,
      ];`);
    expect(out.result).toEqual(Array(11).fill('undefined'));
  });

  it('cannot reach the host through constructors, this, or dynamic import', async () => {
    const out = await run(`
      const tries = [
        () => (function () {}).constructor('return typeof process')(),
        () => globalThis.constructor.constructor('return typeof process')(),
        () => (0, eval)('typeof process'),
        () => typeof this,
        () => Object.getOwnPropertyNames(globalThis).filter((k) => /process|require|fetch|__/.test(k)).join(','),
      ];
      return tries.map((f) => { try { return String(f()); } catch (e) { return 'threw'; } });`);
    expect(out.result).toEqual([
      'undefined',
      'undefined',
      'undefined',
      'undefined',
      '',
    ]);
    await expect(run(`return await import('node:fs')`)).rejects.toThrow();
  });

  it('stops a memory bomb', async () => {
    const t0 = Date.now();
    await expect(
      run(`const a = []; while (true) a.push('x'.repeat(1e6));`, {
        timeoutMs: 5000,
      }),
    ).rejects.toBeInstanceOf(SandboxError);
    await expect(
      run(`return new Array(1e9).fill(1).length;`, { timeoutMs: 5000 }),
    ).rejects.toBeInstanceOf(SandboxError);
    await expect(
      run(`let s = 'xx'; while (true) s += s;`, { timeoutMs: 5000 }),
    ).rejects.toBeInstanceOf(SandboxError);
    expect(Date.now() - t0).toBeLessThan(15_000);
  });

  it('stops each large-allocation bomb by the heap cap, long before the deadline', async () => {
    // Without the heap cap the first of these takes about 3 s here (17 s or
    // more on a CI runner): it allocates ~2 GB before WebAssembly gives up.
    const bombs = [
      `const a = []; while (true) a.push('x'.repeat(1e6));`,
      `const a = []; while (true) a.push(new Array(1e5).fill(1));`,
      `let s = 'xx'; while (true) s += s;`,
    ];
    for (const code of bombs) {
      const t = Date.now();
      await expect(run(code, { timeoutMs: 20_000 })).rejects.toBeInstanceOf(
        SandboxError,
      );
      expect(Date.now() - t).toBeLessThan(2_000);
    }
    // The sandbox still works afterwards.
    expect((await run(`return 1 + 1;`)).result).toBe(2);
  });

  it('refuses hostile nesting without breaking later methods', async () => {
    await expect(
      run(`let o = {}; for (let i = 0; i < 1e5; i++) o = { o }; return o;`),
    ).rejects.toThrow(/nested too deeply/);
    await expect(
      run(
        `let o = {}; for (let i = 0; i < 1e5; i++) o = { o }; app.create('Chore', o); return 1;`,
      ),
    ).rejects.toThrow(/nested too deeply/);
    expect((await run('return 2;')).result).toBe(2);
  });

  it('stops runaway recursion', async () => {
    await expect(
      run(`function f() { return f() + 1; } return f();`),
    ).rejects.toThrow(/method failed/);
  });

  it('refuses code that does not parse, including attempts to close the wrapper', async () => {
    expect(await checkSyntax('return 1;')).toBeNull();
    expect(await checkSyntax('return (')).toMatch(/SyntaxError/);
    expect(await checkSyntax('}); evil(); (function(){')).toMatch(
      /SyntaxError/,
    );
    await expect(run('}); return 1; (function(){')).rejects.toBeInstanceOf(
      SandboxError,
    );
  });

  it('keeps host state clean: frozen app, JSON-only boundary, no pollution', async () => {
    await expect(run(`app.create = () => 1; return 1;`)).rejects.toThrow(
      /method failed/,
    );
    const out = await run(
      `return JSON.parse('{"__proto__":{"polluted":true}}');`,
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.hasOwn(out.result as object, '__proto__')).toBe(true);
    // a method that tries to pollute its own realm cannot touch the host's
    await run(`Object.prototype.polluted = 1; return 1;`);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    await expect(run(`return Promise.resolve(1);`)).rejects.toThrow(/promise/);
  });

  it('caps the writes list and the size of what a method returns', async () => {
    await expect(
      run(
        `for (let i = 0; i < 2000; i++) app.create('Chore', { title: 'x' }); return 1;`,
        { timeoutMs: 5000 },
      ),
    ).rejects.toThrow(/at most 1000 writes/);
    await expect(
      run(`return 'x'.repeat(2e6);`, { timeoutMs: 5000 }),
    ).rejects.toThrow(/too much/);
    await expect(
      runMethod('return 1', {
        record: null,
        params: {},
        data: { Chore: [{ t: 'x'.repeat(9e6) }] },
      }),
    ).rejects.toThrow(/too much data/);
  });

  it('validateWrites checks shape, models, fields, values and count', () => {
    const models = {
      Chore: {
        fields: {
          title: { type: 'text' as const },
          points: { type: 'integer' as const },
          kind: { type: 'choice' as const, choices: ['a', 'b'] },
        },
      },
    };
    const ok = validateWrites(
      [
        { op: 'create', model: 'Chore', data: { title: 'x', points: '3' } },
        { op: 'update', model: 'Chore', id: 'i', data: { kind: 'a' } },
        { op: 'delete', model: 'Chore', id: 'i' },
      ],
      models,
    );
    expect(ok).toHaveLength(3);
    const bad = (w: unknown) => () => validateWrites([w], models);
    expect(bad({ op: 'create', model: 'Nope', data: {} })).toThrow(/no model/);
    expect(bad({ op: 'create', model: 'Chore', data: { nope: 1 } })).toThrow(
      /no field/,
    );
    expect(
      bad({ op: 'create', model: 'Chore', data: { points: 'abc' } }),
    ).toThrow(/number/);
    expect(bad({ op: 'create', model: 'Chore', data: { kind: 'z' } })).toThrow(
      /one of/,
    );
    expect(
      bad({
        op: 'create',
        model: 'Chore',
        data: JSON.parse('{"__proto__":1}'),
      }),
    ).toThrow(/no field/);
    expect(bad({ op: 'update', model: 'Chore', data: {} })).toThrow(/id/);
    expect(bad({ op: 'zap', model: 'Chore' })).toThrow(/operation/);
    expect(bad({ op: 'create', model: 'Chore', data: {}, extra: 1 })).toThrow(
      /unknown key/,
    );
    expect(bad({ op: 'create', model: 'constructor', data: {} })).toThrow(
      /no model/,
    );
    expect(() =>
      validateWrites(
        Array(SANDBOX_LIMITS.maxWrites + 1).fill({
          op: 'create',
          model: 'Chore',
          data: {},
        }),
        models,
      ),
    ).toThrow(/too many/);
  });
});

describe('sandbox through the host', () => {
  const dir = mkdtempSync(join(tmpdir(), 'engine-sandbox-'));
  let host: AppHost;
  let id = '';
  const snapshots = () => readdirSync(join(dir, 'snapshots')).length;
  const add = (name: string, code: string) =>
    host.execute(
      {
        type: 'addMethod',
        model: 'Chore',
        name,
        method: { description: name, code },
      },
      { author: 't', approved: true },
    );

  beforeAll(async () => {
    host = await AppHost.open(dir, { store: new MemoryVersionStore() });
    await host.execute(
      {
        type: 'defineModel',
        name: 'Chore',
        fields: { title: { type: 'text' }, points: { type: 'integer' } },
      },
      { author: 't' },
    );
    id = (await host.create('Chore', { title: 'a', points: 1 })).id as string;
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a method that does not parse at add time', async () => {
    const before = host.version;
    await expect(add('broken', 'return (')).rejects.toThrow(/does not parse/);
    await expect(add('inject', '}); evil(); (function(){')).rejects.toThrow(
      /does not parse/,
    );
    expect(host.version).toBe(before);
    expect(host.def.models.Chore.methods).toEqual({});
  });

  it('rejects writes to an unknown model, field or type, and applies nothing', async () => {
    await add('badModel', `app.create('Nope', { a: 1 }); return 1;`);
    await add(
      'badField',
      `app.update('Chore', record.id, { points: 5 }); app.update('Chore', record.id, { nope: 1 }); return 1;`,
    );
    await add(
      'badType',
      `app.update('Chore', record.id, { points: 'many' }); return 1;`,
    );
    await add(
      'badId',
      `app.update('Chore', 'missing', { points: 9 }); return 1;`,
    );
    const snaps = snapshots();
    for (const m of ['badModel', 'badField', 'badType', 'badId'])
      await expect(host.runMethod('Chore', m, id)).rejects.toThrow(
        /bad writes, none applied/,
      );
    expect((await host.get('Chore', id)).points).toBe(1); // the valid first write was not applied either
    expect(snapshots()).toBe(snaps);
  });

  it('takes a snapshot only when writes are applied, and before applying', async () => {
    await add('noop', `return record.points;`);
    await add(
      'bump',
      `app.update('Chore', record.id, { points: record.points + 1 }); return 'ok';`,
    );
    const snaps = snapshots();
    const noop = await host.runMethod('Chore', 'noop', id);
    expect(noop.snapshot).toBeNull();
    expect(snapshots()).toBe(snaps);
    const bump = await host.runMethod('Chore', 'bump', id);
    expect(bump.applied).toBe(1);
    expect(snapshots()).toBe(snaps + 1);
    expect((await host.get('Chore', id)).points).toBe(2);
    // the snapshot holds the state from before the write
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(bump.snapshot as string, { readOnly: true });
    expect(
      (db.prepare('select points from u_chores').get() as { points: number })
        .points,
    ).toBe(1);
    db.close();
  });

  it('rejects a huge writes list and applies none of it', async () => {
    await add(
      'flood',
      `for (let i = 0; i < 1500; i++) app.create('Chore', { title: 'x' + i }); return 1;`,
    );
    const before = (await host.list('Chore')).length;
    await expect(host.runMethod('Chore', 'flood', null)).rejects.toThrow(
      /at most 1000 writes/,
    );
    expect((await host.list('Chore')).length).toBe(before);
  });

  it('a runaway method fails cleanly and the app keeps serving', async () => {
    await add('spin', `while (true) {}`);
    await expect(host.runMethod('Chore', 'spin', id)).rejects.toThrow(
      /ran too long/,
    );
    expect((await host.list('Chore')).length).toBeGreaterThan(0);
    expect(host.appAlive).toBe(true);
  });

  it('errors are EngineErrors the shell can show', async () => {
    await expect(host.runMethod('Chore', 'spin', id)).rejects.toBeInstanceOf(
      EngineError,
    );
  });
});
