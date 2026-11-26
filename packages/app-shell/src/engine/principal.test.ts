// The caller travels into the engine (#5188, slice 1, SQLite): no principal, a
// forged one or one for another tenant is refused on every op, and two callers
// of one app see only what their permissions allow.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRuntimeReportSpec } from '@happyvertical/smrt-reports';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hostOwner } from '../test/engine-principal.ts';
import {
  AppHost,
  appPermissionSlugs,
  type Command,
  enginePrincipal,
  isEnginePrincipal,
  MemoryVersionStore,
  NoPrincipalError,
  PermissionDeniedError,
} from './index.ts';
import { slugFor } from './permissions.ts';
import type { AppWorker } from './worker-handle.ts';
import { WORKER_OPS } from './worker-protocol.ts';

const dir = mkdtempSync(join(tmpdir(), 'engine-principal-'));
let host: AppHost;
// A UUID: a PostgreSQL app's rows carry their tenant in a UUID column (#5189).
const TENANT = '00000000-0000-4000-8000-0000000000a1';
const user = (userId: string, permissions: string[], tenantId = TENANT) =>
  enginePrincipal({ kind: 'user', tenantId, userId, permissions });

beforeAll(async () => {
  host = await AppHost.open(dir, {
    store: new MemoryVersionStore(),
    tenantId: TENANT,
  });
  const defs: Command[] = [
    {
      type: 'defineModel',
      name: 'Chore',
      fields: { title: { type: 'text' }, qty: { type: 'integer' } },
    },
    { type: 'defineModel', name: 'Secret', fields: { note: { type: 'text' } } },
  ];
  for (const command of defs)
    await host.execute(hostOwner(host), command, {
      author: 't',
      approved: true,
    });
  await host.execute(
    hostOwner(host),
    {
      type: 'defineReport',
      name: 'chores',
      definition: {
        spec: parseRuntimeReportSpec({
          version: 1,
          title: 'Chores',
          source: 'Chore',
          dimensions: [],
          measures: [{ fn: 'sum', field: 'qty', as: 'total' }],
        }),
      },
    },
    { author: 't', approved: true },
  );
  await host.create(hostOwner(host), 'Chore', { title: 'kept', qty: 2 });
  await host.create(hostOwner(host), 'Secret', { note: 'hidden' });
});
afterAll(async () => {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
});

const slug = (model: string, action: string) =>
  slugFor(host.def, model, action);
const reader = () =>
  user('reader', [slug('Chore', 'list'), slug('Chore', 'get')]);
const foreign = () =>
  user('x', appPermissionSlugs(host.def), 'tenant-b-not-this-app');
// biome-ignore lint/suspicious/noExplicitAny: reaching the private seams on purpose
const internals = () => host as any;

describe('principal: no call without a valid caller', () => {
  it('lists every worker op, so a new op cannot slip past this suite', () => {
    expect(WORKER_OPS.length).toBeGreaterThan(20);
  });

  it('AppHost refuses every op without a principal and with a foreign tenant', async () => {
    for (const op of WORKER_OPS) {
      await expect(internals().onApp(undefined, op), op).rejects.toBeInstanceOf(
        NoPrincipalError,
      );
      await expect(internals().onApp(null, op), op).rejects.toBeInstanceOf(
        NoPrincipalError,
      );
      await expect(internals().onApp(foreign(), op), op).rejects.toBeInstanceOf(
        PermissionDeniedError,
      );
    }
  });

  it('AppWorker.call refuses every op without a principal and with a foreign tenant', async () => {
    const app: AppWorker = internals().app;
    for (const op of WORKER_OPS) {
      // biome-ignore lint/suspicious/noExplicitAny: the point is a missing argument
      await expect(app.call(op, undefined as any), op).rejects.toBeInstanceOf(
        NoPrincipalError,
      );
      await expect(app.call(op, foreign()), op).rejects.toBeInstanceOf(
        PermissionDeniedError,
      );
    }
  });

  it('the worker itself refuses a message with no principal, a malformed one, or another tenant', async () => {
    const app: AppWorker = internals().app;
    // biome-ignore lint/suspicious/noExplicitAny: the raw thread
    const thread = (app as any).worker as import('node:worker_threads').Worker;
    const replies = new Map<number, Record<string, unknown>>();
    thread.on('message', (m: Record<string, unknown>) => {
      if (typeof m.id === 'number') replies.set(m.id, m);
    });
    const forgedKinds = [
      undefined,
      null,
      'owner',
      {},
      { kind: 'user', tenantId: TENANT }, // no user id
      { kind: 'root', tenantId: TENANT, userId: 'u', permissions: [] },
      {
        kind: 'user',
        tenantId: TENANT,
        userId: 'u',
        permissions: ['*', 7],
        allowCrossTenant: false,
        superAdminBypass: false,
      },
      {
        kind: 'user',
        tenantId: TENANT,
        userId: 'u',
        permissions: [],
        allowCrossTenant: true,
        superAdminBypass: false,
      },
    ];
    const other = {
      kind: 'system',
      tenantId: 'someone-else',
      userId: null,
      authenticated: true,
      permissions: [],
      allowCrossTenant: false,
      superAdminBypass: false,
    };
    let id = 9000;
    const sent: [number, string][] = [];
    for (const op of WORKER_OPS)
      for (const principal of [...forgedKinds, other]) {
        thread.postMessage({ id: ++id, op, args: [], principal });
        sent.push([id, principal === other ? 'forbidden' : 'any']);
      }
    for (let i = 0; i < 200 && replies.size < sent.length; i++)
      await new Promise((r) => setTimeout(r, 25));
    expect(replies.size).toBe(sent.length);
    for (const [rid, expected] of sent) {
      const r = replies.get(rid);
      expect(r?.ok).toBe(false);
      if (expected === 'forbidden') expect(r?.code).toBe('forbidden');
      else expect(['unauthorized', 'forbidden']).toContain(r?.code);
    }
    expect(host.appAlive).toBe(true);
  });

  it('a principal is frozen, and a copy or look-alike is not one', async () => {
    const p = reader();
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.permissions)).toBe(true);
    expect(() => {
      (p as { tenantId: string }).tenantId = 'x';
    }).toThrow(TypeError);
    expect(() => {
      (p.permissions as string[]).push('chores.delete');
    }).toThrow(TypeError);
    expect(isEnginePrincipal(p)).toBe(true);
    for (const copy of [{ ...p }, structuredClone(p), Object.freeze({ ...p })])
      await expect(
        host.list(copy as typeof p, 'Chore'),
        'a copy',
      ).rejects.toBeInstanceOf(NoPrincipalError);
    const sys = { ...p, kind: 'system' as const };
    await expect(
      host.list(Object.freeze(sys), 'Secret'),
    ).rejects.toBeInstanceOf(NoPrincipalError);
  });

  it('only the engine can act as the system', () => {
    expect(() =>
      enginePrincipal({
        kind: 'system' as 'user',
        tenantId: TENANT,
        userId: 'u',
      }),
    ).toThrow(NoPrincipalError);
    expect(() =>
      enginePrincipal({ kind: 'user', tenantId: '', userId: 'u' }),
    ).toThrow(NoPrincipalError);
    expect(() => enginePrincipal({ kind: 'user', tenantId: TENANT })).toThrow(
      NoPrincipalError,
    );
    expect(() =>
      enginePrincipal({
        kind: 'user',
        tenantId: TENANT,
        userId: 'u',
        permissions: ['has space'],
      }),
    ).toThrow(NoPrincipalError);
  });
});

describe('principal: two callers, each sees what its permissions allow', () => {
  it('a reader reads its model and nothing else, and cannot write', async () => {
    const p = reader();
    expect(await host.list(p, 'Chore')).toHaveLength(1);
    const id = (await host.list(p, 'Chore'))[0].id as string;
    expect((await host.get(p, 'Chore', id)).title).toBe('kept');
    expect(await host.countRows(p, 'Chore')).toBe(1);
    expect(await host.listByIds(p, 'Chore', [id])).toHaveLength(1);
    for (const attempt of [
      () => host.list(p, 'Secret'),
      () => host.get(p, 'Secret', id),
      () => host.countRows(p, 'Secret'),
      () => host.listByIds(p, 'Secret', [id]),
      () => host.readStoredRows(p, 'Secret', ['id'], 'id'),
      () => host.create(p, 'Chore', { title: 'no' }),
      () => host.update(p, 'Chore', id, { title: 'no' }),
      () => host.remove(p, 'Chore', id),
    ])
      await expect(attempt()).rejects.toMatchObject({ code: 'forbidden' });
    expect(await host.list(hostOwner(host), 'Chore')).toHaveLength(1);
  });

  it('REST: reads follow the list slug, writes follow core enforcement (403)', async () => {
    const p = reader();
    const ok = await host.rest(p, { method: 'GET', url: '/api/chores' });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toHaveLength(1);
    await expect(
      host.rest(p, { method: 'GET', url: '/api/secrets' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const denied = await host.rest(p, {
      method: 'POST',
      url: '/api/chores',
      body: JSON.stringify({ title: 'sneaky' }),
    });
    expect(denied.status).toBe(403);
    // The slugs the shell derives are the ones core checks: all of them but
    // `create` is refused, `create` alone is allowed.
    const all = appPermissionSlugs(host.def);
    const withoutCreate = user(
      'wc',
      all.filter((s) => s !== slug('Chore', 'create')),
    );
    const refused = await host.rest(withoutCreate, {
      method: 'POST',
      url: '/api/chores',
      body: JSON.stringify({ title: 'sneaky' }),
    });
    expect(refused.status).toBe(403);
    const only = user('oc', [slug('Chore', 'create')]);
    const made = await host.rest(only, {
      method: 'POST',
      url: '/api/chores',
      body: JSON.stringify({ title: 'rest ok', qty: 1 }),
    });
    expect(made.status).toBeLessThan(300);
    const id = JSON.parse(made.body).id as string;
    await host.remove(hostOwner(host), 'Chore', id);
    expect(await host.list(hostOwner(host), 'Chore')).toHaveLength(1);
  });

  it('tools are filtered to the slugs held and a tool call needs its slug', async () => {
    const p = reader();
    const names = (await host.appTools(p)).map((t) => t.name).sort();
    expect(names).toEqual(['chore_get', 'chore_list']);
    expect((await host.appTools(hostOwner(host))).length).toBeGreaterThan(8);
    expect((await host.callAppTool(p, 'chore_list', {})).isError).toBe(false);
    await expect(
      host.callAppTool(p, 'chore_create', { title: 'no' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(host.callAppTool(p, 'secret_list', {})).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('a report needs the list slug of its source model', async () => {
    const withList = reader();
    expect((await host.runReport(withList, 'chores')).rows).toHaveLength(1);
    const noList = user('nl', [slug('Secret', 'list')]);
    await expect(host.runReport(noList, 'chores')).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      host.runReport(noList, {
        version: 1,
        title: 'x',
        source: 'Chore',
        dimensions: [],
        measures: [{ fn: 'sum', field: 'qty', as: 'total' }],
        // biome-ignore lint/suspicious/noExplicitAny: a spec literal
      } as any),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('engine-only ops are refused to every user, owner included', async () => {
    for (const op of [
      'importRecords',
      'purgeArchives',
      'pruneSnapshots',
      'snapshot',
      'copyTo',
      'previewUndo',
    ] as const)
      await expect(
        internals().onApp(hostOwner(host), op),
        op,
      ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('a guest is refused: row level security is not in this slice', async () => {
    const guest = enginePrincipal({
      kind: 'guest',
      tenantId: TENANT,
      permissions: appPermissionSlugs(host.def),
    });
    await expect(host.list(guest, 'Chore')).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      host.rest(guest, { method: 'GET', url: '/api/chores' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('interleaved callers keep their own permissions', async () => {
    const p1 = reader();
    const p2 = hostOwner(host, 'two');
    const made: string[] = [];
    const runs = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        i % 2
          ? host.create(p1, 'Chore', { title: `p1-${i}` })
          : host
              .create(p2, 'Chore', { title: `p2-${i}` })
              .then((r) => made.push(r.id as string)),
      ),
    );
    expect(runs.filter((r) => r.status === 'rejected')).toHaveLength(4);
    expect(runs.filter((r) => r.status === 'fulfilled')).toHaveLength(4);
    for (const id of made) await host.remove(p2, 'Chore', id);
  });
});
