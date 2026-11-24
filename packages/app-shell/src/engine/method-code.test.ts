// The method-code entitlement gate (#5194, decision on #5597): a host with a
// gate that says no neither runs, adds nor changes method code, on every path
// that reaches the sandbox; formulas, records and unrelated changes keep
// working; code already stored stays (inert) and the app still boots. No gate
// (the desktop) means no lookup. SQLite; the gate is a plain function.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { hostOwner } from '../test/engine-principal.ts';
import { type AppDefinition, EMPTY_APP } from './definition.ts';
import {
  AppHost,
  type Command,
  EngineError,
  METHOD_CODE_DENIED,
  MemoryVersionStore,
} from './index.ts';
import { introducedCode, methodCodeTarget } from './method-code.ts';
import { WORKER_OPS } from './worker-protocol.ts';

const dirs: string[] = [];
const hosts: AppHost[] = [];
afterAll(async () => {
  for (const h of hosts) await h.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const METHOD = {
  description: 'add a row',
  code: `app.create('Order', { title: 'made by code' }); return 7;`,
};

async function open(
  gate?: (tenantId: string) => boolean | Promise<boolean>,
  store = new MemoryVersionStore(),
  dir = mkdtempSync(join(tmpdir(), 'method-code-')),
) {
  dirs.push(dir);
  const host = await AppHost.open(dir, { store, methodCode: gate });
  hosts.push(host);
  const run = (cmd: Command) =>
    host.execute(hostOwner(host), cmd, { author: 't', approved: true });
  return { host, run, store, dir };
}

/** An app with an Order model, a formula and (when `withMethod`) a method, made while entitled. */
async function seeded(withMethod = true) {
  let allowed = true;
  const gate = vi.fn(async () => allowed);
  const w = await open(gate);
  await w.run({
    type: 'defineModel',
    name: 'Order',
    fields: { title: { type: 'text' }, qty: { type: 'integer' } },
  });
  await w.run({
    type: 'addField',
    model: 'Order',
    field: 'double',
    definition: {
      type: 'integer',
      calculated: { op: 'mul', left: { col: 'qty' }, right: { value: 2 } },
    },
  } as Command);
  if (withMethod)
    await w.run({
      type: 'addMethod',
      model: 'Order',
      name: 'stamp',
      method: METHOD,
    });
  return {
    ...w,
    gate,
    setAllowed(v: boolean) {
      allowed = v;
    },
  };
}

const denied = (e: unknown) =>
  e instanceof EngineError &&
  e.code === 'refused' &&
  e.details?.code === METHOD_CODE_DENIED;

describe('method code without the entitlement', () => {
  it('refuses runMethod, the method tool and a method REST route; nothing runs', async () => {
    const w = await seeded();
    w.setAllowed(false);
    const owner = hostOwner(w.host);
    const seed = await w.host.create(owner, 'Order', { title: 's', qty: 1 });
    const before = await w.host.list(owner, 'Order');
    const run = await w.host.runMethod(owner, 'Order', 'stamp').catch((e) => e);
    expect(denied(run)).toBe(true);
    expect(run.message).toMatch(/Order\.stamp\(\)/);
    expect(run.message).toMatch(/not enabled for this workspace/);
    expect(run.message).toMatch(/formulas keep working/);
    const tool = await w.host
      .callAppTool(owner, 'order_stamp', { id: seed.id })
      .catch((e) => e);
    expect(denied(tool)).toBe(true);
    const rest = await w.host
      .rest(owner, { method: 'POST', url: '/api/orders/stamp' })
      .catch((e) => e);
    expect(denied(rest)).toBe(true);
    expect(await w.host.list(owner, 'Order')).toEqual(before);
  });

  it('refuses to add or change a method before the code is parsed', async () => {
    const w = await seeded(false);
    w.setAllowed(false);
    // Not valid JavaScript: a parse error would show if it reached the parser.
    const add = await w
      .run({
        type: 'addMethod',
        model: 'Order',
        name: 'broken',
        method: { description: 'x', code: 'this is not (valid' },
      })
      .catch((e) => e);
    expect(denied(add)).toBe(true);
    expect(Object.keys(w.host.def.models.Order.methods ?? {})).toEqual([]);
  });

  it('keeps formulas, records, tools and unrelated changes working', async () => {
    const w = await seeded();
    w.setAllowed(false);
    const owner = hostOwner(w.host);
    const row = await w.host.create(owner, 'Order', { title: 'a', qty: 4 });
    expect(row.double).toBe(8);
    expect(await w.host.list(owner, 'Order')).toHaveLength(1);
    const made = await w.host.callAppTool(owner, 'order_create', {
      title: 'b',
      qty: 1,
    });
    expect(JSON.stringify(made)).toContain('b');
    expect(
      (await w.host.rest(owner, { method: 'GET', url: '/api/orders' })).status,
    ).toBe(200);
    // An unrelated structural change goes through; the stored method stays.
    await w.run({
      type: 'addField',
      model: 'Order',
      field: 'note',
      definition: { type: 'text' },
    });
    expect(w.host.def.models.Order.methods?.stamp.code).toBe(METHOD.code);
    expect(w.host.def.models.Order.fields.note).toBeDefined();
  });

  it('an app that lost the entitlement still boots and serves data; only its method is refused', async () => {
    const w = await seeded();
    await w.host.create(hostOwner(w.host), 'Order', { title: 'kept', qty: 1 });
    await w.host.close();
    hosts.splice(hosts.indexOf(w.host), 1);
    const again = await open(() => false, w.store, w.dir);
    expect(again.host.def.models.Order.methods?.stamp.code).toBe(METHOD.code);
    const owner = hostOwner(again.host);
    expect(await again.host.list(owner, 'Order')).toHaveLength(1);
    expect(
      denied(
        await again.host.runMethod(owner, 'Order', 'stamp').catch((e) => e),
      ),
    ).toBe(true);
  });

  it('a failed lookup refuses (unavailable), it never reads as yes', async () => {
    const w = await seeded();
    const owner = hostOwner(w.host);
    w.gate.mockRejectedValueOnce(new Error('db down'));
    const r = await w.host.runMethod(owner, 'Order', 'stamp').catch((e) => e);
    expect(r).toBeInstanceOf(EngineError);
    expect(r.code).toBe('unavailable');
    expect(r.message).toMatch(/could not be checked/);
    expect(await w.host.list(owner, 'Order')).toHaveLength(0);
    // A non-boolean answer is not a yes either.
    w.gate.mockResolvedValueOnce('yes' as never);
    expect(
      denied(await w.host.runMethod(owner, 'Order', 'stamp').catch((e) => e)),
    ).toBe(true);
  });

  it('a template that carries code is refused before it is parsed', async () => {
    const w = await open(() => false);
    const template = {
      format: 1,
      exportedAt: new Date().toISOString(),
      definition: {
        ...EMPTY_APP,
        models: {
          Order: {
            label: 'Order',
            fields: { title: { type: 'text' } },
            // Not valid JavaScript: a parse error would show if it got that far.
            methods: {
              stamp: { description: 'x', code: 'this is not (valid' },
            },
          },
        },
      },
    } as never;
    const r = await w
      .run({ type: 'importTemplate', data: template })
      .catch((e) => e);
    expect(denied(r)).toBe(true);
    expect(w.host.version).toBe(0);
    // A template with no code imports without the entitlement.
    const plain = structuredClone(template) as { definition: AppDefinition };
    plain.definition.models.Order.methods = {};
    await w.run({ type: 'importTemplate', data: plain as never });
    expect(Object.keys(w.host.def.models)).toEqual(['Order']);
  });
});

describe('code that is not reached through a run', () => {
  it('a method named like a framework hook never runs on a record load or save', async () => {
    const w = await seeded(false);
    await w.run({
      type: 'addMethod',
      model: 'Order',
      name: 'initialize',
      method: {
        description: 'hook',
        code: `app.create('Order', { title: 'hijack' }); return 1;`,
      },
    });
    w.setAllowed(false);
    const owner = hostOwner(w.host);
    await w.host.create(owner, 'Order', { title: 'a', qty: 1 });
    const rows = await w.host.list(owner, 'Order');
    await w.host.get(owner, 'Order', String(rows[0].id));
    expect((await w.host.list(owner, 'Order')).map((r) => r.title)).toEqual([
      'a',
    ]);
  });

  it('an undo that would bring stored code back needs the entitlement, like a change', async () => {
    const w = await seeded(true);
    await w.run({ type: 'removeModel', model: 'Order' });
    expect(w.host.def.models.Order).toBeUndefined();
    w.setAllowed(false);
    const r = await w.run({ type: 'undo' }).catch((e) => e);
    expect(denied(r)).toBe(true);
    expect(w.host.def.models.Order).toBeUndefined();
    w.setAllowed(true);
    await w.run({ type: 'undo' });
    expect(w.host.def.models.Order.methods?.stamp.code).toBe(METHOD.code);
  });
});

describe('method code with the entitlement', () => {
  it('runs a method, by call, tool and add, asking the gate with the host tenant', async () => {
    const w = await seeded();
    const owner = hostOwner(w.host);
    const r = await w.host.runMethod(owner, 'Order', 'stamp');
    expect(r.result).toBe(7);
    expect(await w.host.list(owner, 'Order')).toHaveLength(1);
    const made = await w.host.create(owner, 'Order', { title: 'x', qty: 1 });
    const t = await w.host.callAppTool(owner, 'order_stamp', { id: made.id });
    expect(JSON.stringify(t)).not.toContain('isError":true');
    expect(await w.host.list(owner, 'Order')).toHaveLength(3);
    expect(w.gate).toHaveBeenCalledWith(w.host.tenantId);
  });

  it('follows a change of plan on the next call, no reopen', async () => {
    const w = await seeded();
    const owner = hostOwner(w.host);
    await w.host.runMethod(owner, 'Order', 'stamp');
    w.setAllowed(false);
    expect(
      denied(await w.host.runMethod(owner, 'Order', 'stamp').catch((e) => e)),
    ).toBe(true);
    w.setAllowed(true);
    await w.host.runMethod(owner, 'Order', 'stamp');
    expect(await w.host.list(owner, 'Order')).toHaveLength(2);
  });

  it('is not asked for a call that cannot run code', async () => {
    const w = await seeded();
    w.gate.mockClear();
    const owner = hostOwner(w.host);
    await w.host.create(owner, 'Order', { title: 'x', qty: 1 });
    await w.host.list(owner, 'Order');
    await w.host.callAppTool(owner, 'order_list', {});
    await w.host.rest(owner, { method: 'GET', url: '/api/orders' });
    expect(w.gate).not.toHaveBeenCalled();
  });
});

describe('no gate (the desktop and other profiles)', () => {
  it('runs, adds and changes method code with no lookup', async () => {
    const w = await open();
    await w.run({
      type: 'defineModel',
      name: 'Order',
      fields: { title: { type: 'text' } },
    });
    await w.run({
      type: 'addMethod',
      model: 'Order',
      name: 'stamp',
      method: METHOD,
    });
    const owner = hostOwner(w.host);
    expect((await w.host.runMethod(owner, 'Order', 'stamp')).result).toBe(7);
    const [row] = await w.host.list(owner, 'Order');
    const t = await w.host.callAppTool(owner, 'order_stamp', { id: row.id });
    expect(JSON.stringify(t)).not.toContain('isError":true');
    expect(await w.host.list(owner, 'Order')).toHaveLength(2);
  });
});

describe('drafts and publish', () => {
  it('a forked draft inherits the gate; publish refuses code the plan no longer allows', async () => {
    const w = await seeded(false);
    const draftDir = `${w.dir}-draft1`;
    const draft = await w.host.forkDraft(hostOwner(w.host), draftDir, {
      store: new MemoryVersionStore(),
    });
    hosts.push(draft);
    // The draft refuses new code while the plan does not grant it ...
    w.setAllowed(false);
    expect(
      denied(
        await draft
          .execute(
            hostOwner(draft),
            {
              type: 'addMethod',
              model: 'Order',
              name: 'stamp',
              method: METHOD,
            },
            { author: 't', approved: true },
          )
          .catch((e) => e),
      ),
    ).toBe(true);
    // ... and takes it while it does; then the plan is lost before publish.
    w.setAllowed(true);
    await draft.execute(
      hostOwner(draft),
      { type: 'addMethod', model: 'Order', name: 'stamp', method: METHOD },
      { author: 't', approved: true },
    );
    w.setAllowed(false);
    const preview = await w.host.previewPublish(draft).catch((e) => e);
    expect(denied(preview)).toBe(true);
    expect(preview.message).toMatch(/Order\.stamp\(\)/);
    expect(w.host.def.models.Order.methods ?? {}).toEqual({});
    // Granted again: the same draft previews (the publish path is the same check).
    w.setAllowed(true);
    const ok = await w.host.previewPublish(draft);
    expect(ok.methods.map((m) => [m.name, m.change])).toEqual([
      ['stamp', 'added'],
    ]);
  });

  it('a draft change that leaves existing code alone publishes without the entitlement', async () => {
    const w = await seeded(true);
    w.setAllowed(false);
    const draft = await w.host.forkDraft(hostOwner(w.host), `${w.dir}-draft2`, {
      store: new MemoryVersionStore(),
    });
    hosts.push(draft);
    await draft.execute(
      hostOwner(draft),
      {
        type: 'addField',
        model: 'Order',
        field: 'note',
        definition: { type: 'text' },
      },
      { author: 't', approved: true },
    );
    const ok = await w.host.previewPublish(draft);
    expect(ok.methods.map((m) => m.change)).toEqual(['unchanged']);
  });
});

describe('what reaches the sandbox', () => {
  const def = {
    ...EMPTY_APP,
    models: {
      Order: {
        label: 'Order',
        fields: { title: { type: 'text' } },
        methods: { stamp: { description: 'x', code: 'return 1;' } },
      },
    },
  } as AppDefinition;

  it('only runMethod, the method tools and a method route name a method', () => {
    const args: Record<string, unknown[]> = {
      runMethod: ['Order', 'stamp'],
      callTool: ['order_stamp', {}],
      rest: [{ method: 'POST', url: '/api/orders/stamp' }],
    };
    const hits = WORKER_OPS.filter((op) =>
      methodCodeTarget(def, op, args[op] ?? ['Order', 'stamp']),
    );
    expect([...hits].sort()).toEqual(['callTool', 'rest', 'runMethod']);
  });

  it('does not name a method for CRUD tools, routes, or a model without that method', () => {
    expect(methodCodeTarget(def, 'callTool', ['order_list', {}])).toBeNull();
    expect(
      methodCodeTarget(def, 'rest', [{ method: 'GET', url: '/api/orders' }]),
    ).toBeNull();
    expect(methodCodeTarget(def, 'runMethod', ['Order', 'nope'])).toBeNull();
    expect(methodCodeTarget(def, 'runMethod', ['Nope', 'stamp'])).toBeNull();
  });

  it('a CRUD route whose name collides with a method is not a method call', () => {
    const clash = structuredClone(def);
    clash.models.Order.methods = {
      orders: { description: 'x', code: 'return 1;' },
    };
    for (const url of ['/api/orders', '/api/orders/abc', '/api/orders/count'])
      expect(
        methodCodeTarget(clash, 'rest', [{ method: 'GET', url }]),
      ).toBeNull();
    expect(
      methodCodeTarget(clash, 'rest', [{ method: 'POST', url: '/api/orders' }]),
    ).toBeNull();
    // The action position still names the method, and only on its own model.
    expect(
      methodCodeTarget(clash, 'rest', [
        { method: 'POST', url: '/api/orders/orders' },
      ]),
    ).toEqual({ model: 'Order', method: 'orders' });
    expect(
      methodCodeTarget(clash, 'rest', [
        { method: 'POST', url: '/api/others/orders' },
      ]),
    ).toBeNull();
  });

  it('introducedCode lists new and changed code, never unchanged or removed', () => {
    const changed = structuredClone(def);
    changed.models.Order.methods = {
      stamp: { description: 'x', code: 'return 2;' },
      fresh: { description: 'y', code: 'return 3;' },
    };
    expect(introducedCode(def, def)).toEqual([]);
    expect(introducedCode(def, changed)).toEqual([
      'Order.stamp()',
      'Order.fresh()',
    ]);
    expect(introducedCode(changed, def)).toEqual(['Order.stamp()']);
    expect(introducedCode(def, EMPTY_APP)).toEqual([]);
  });
});
