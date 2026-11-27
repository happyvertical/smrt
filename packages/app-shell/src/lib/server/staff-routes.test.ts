// Staff on the record routes, MCP, events and pages (#5197 S3). In-process:
// SQLite shell.db and a real live host; the route modules are called directly.
// Every record operation of a staff member passes the engine's authorize.ts
// with the staff principal; every builder route refuses them.
import {
  DEFAULT_ROLE_SLUGS,
  MembershipCollection,
  MembershipStatus,
  RoleCollection,
  UserCollection,
} from '@happyvertical/smrt-users';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { load as layoutLoad } from '../../routes/+layout.server.ts';
import {
  DELETE as appDELETE,
  GET as appGET,
  POST as appPOST,
} from '../../routes/api/app/[...path]/+server.ts';
import { GET as eventsGET } from '../../routes/api/events/+server.ts';
import { GET as describeGET } from '../../routes/api/shell/describe/+server.ts';
import {
  GET as recordsGET,
  POST as recordsPOST,
} from '../../routes/api/shell/records/[model]/+server.ts';
import {
  DELETE as recordDELETE,
  GET as recordGET,
  PUT as recordPUT,
} from '../../routes/api/shell/records/[model]/[id]/+server.ts';
import {
  GET as reportGET,
  POST as reportPOST,
} from '../../routes/api/shell/reports/[name]/+server.ts';
import { GET as reportCsv } from '../../routes/api/shell/reports/[name]/csv/+server.ts';
import { load as modelPage } from '../../routes/m/[model]/+page.server.ts';
import { hostOwner } from '../../test/engine-principal.ts';
import { ModelAccessGrant } from '../objects/ModelAccessGrant.ts';
import { runCommand } from './builder.ts';
import { publish } from './events.ts';
import { hostFor } from './host.ts';
import { createShellMcpServer } from './mcp-server.ts';
import type { Principal } from './owner.ts';
import { authorizeCall, callTool, toolsFor } from './policy.ts';
import { staffDescription } from './staff-access.ts';
import {
  applyWaiting,
  openShell,
  runAs,
  type ShellHarness,
} from './test-support.ts';

let h: ShellHarness;
let staff: Principal;
let chore: string;
let secret: string;
let staffMembership: { status: MembershipStatus; save(): Promise<unknown> };

/** Grants are per model for every staff member: "no grants" is the owner granting nothing. */
async function withNoGrants<T>(fn: () => T | Promise<T>): Promise<T> {
  await runAs(h.owner, () => ModelAccessGrant.revoke('Chore', 'read'));
  try {
    return await fn();
  } finally {
    await runAs(h.owner, () => ModelAccessGrant.grant('Chore', 'read'));
  }
}

const spec = (source: string) => ({
  version: 1,
  title: source,
  source,
  dimensions: [],
  measures: [{ fn: 'count', as: 'n' }],
  chart: { type: 'table' },
});

async function member(slug: string) {
  const users = await UserCollection.create({ db: h.db });
  const key = `${slug}-${Math.random().toString(36).slice(2, 8)}`;
  const user = await users.create({ email: `${key}@x.test`, username: key });
  await user.save();
  const role = await (
    await RoleCollection.create({ db: h.db })
  ).findSystemRoleBySlug(slug);
  const m = await (await MembershipCollection.create({ db: h.db })).create({
    userId: user.id as string,
    tenantId: h.owner.tenantId,
    roleId: role?.id as string,
    status: MembershipStatus.ACTIVE,
  });
  await m.save();
  return {
    who: { id: user.id as string, tenantId: h.owner.tenantId } as Principal,
    membership: m as unknown as typeof staffMembership,
  };
}

beforeAll(async () => {
  h = await openShell();
  await runAs(h.owner, async () => {
    await runCommand(
      {
        type: 'defineModel',
        name: 'Chore',
        fields: { title: { type: 'text' } },
      },
      h.owner,
      'live',
    );
    await runCommand(
      {
        type: 'defineModel',
        name: 'Secret',
        fields: { note: { type: 'text' } },
      },
      h.owner,
      'live',
    );
  });
  await applyWaiting(h.owner);
  await runAs(h.owner, async () => {
    for (const source of ['Chore', 'Secret'])
      await runCommand(
        {
          type: 'defineReport',
          name: `${source.toLowerCase()}s`,
          definition: { label: source, spec: spec(source) },
        } as never,
        h.owner,
        'live',
      );
  });
  await applyWaiting(h.owner);
  const host = await hostFor('live');
  chore = (await host.create(hostOwner(host), 'Chore', { title: 'mop' }))
    .id as string;
  secret = (await host.create(hostOwner(host), 'Secret', { note: 'plans' }))
    .id as string;
  const s = await member(DEFAULT_ROLE_SLUGS.MEMBER);
  staff = s.who;
  staffMembership = s.membership;
  await runAs(h.owner, () => ModelAccessGrant.grant('Chore', 'read'));
});
afterAll(async () => {
  await h.close();
});

function ev(
  who: Principal | null,
  path: string,
  init: {
    method?: string;
    body?: unknown;
    params?: Record<string, string>;
  } = {},
) {
  const url = new URL(`http://localhost${path}`);
  return {
    url,
    params: init.params ?? {},
    request: new Request(url, {
      method: init.method ?? 'GET',
      headers: { origin: url.origin, 'content-type': 'application/json' },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    }),
    locals: who
      ? { user: { id: who.id }, tenantId: who.tenantId, permissions: [] }
      : { user: null, tenantId: null },
  } as never;
}
const rec = (who: Principal | null, model: string, extra = {}) =>
  ev(who, `/api/shell/records/${model}`, { params: { model }, ...extra });
const one = (who: Principal | null, model: string, id: string, extra = {}) =>
  ev(who, `/api/shell/records/${model}/${id}`, {
    params: { model, id },
    ...extra,
  });
const app = (who: Principal | null, path: string, extra = {}) =>
  ev(who, `/api/app/${path}`, { params: { path }, ...extra });
const mcp = (p: Principal) => ({
  id: p.id,
  tenantId: p.tenantId,
  kind: 'human',
  scopes: [],
});

describe('record routes as staff', () => {
  it('read only: reads the granted model, nothing from an ungranted one, writes are 403', async () => {
    const list = await recordsGET(rec(staff, 'Chore'));
    expect(list.status).toBe(200);
    expect(JSON.stringify(await list.json())).toContain('mop');
    expect((await recordGET(one(staff, 'Chore', chore))).status).toBe(200);
    for (const call of [
      () => recordsGET(rec(staff, 'Secret')),
      () => recordGET(one(staff, 'Secret', secret)),
      () =>
        recordsPOST(
          rec(staff, 'Chore', { method: 'POST', body: { title: 'x' } }),
        ),
      () =>
        recordsPOST(
          rec(staff, 'Secret', { method: 'POST', body: { note: 'x' } }),
        ),
      () =>
        recordPUT(
          one(staff, 'Chore', chore, { method: 'PUT', body: { title: 'x' } }),
        ),
      () => recordDELETE(one(staff, 'Chore', chore, { method: 'DELETE' })),
      () => recordDELETE(one(staff, 'Secret', secret, { method: 'DELETE' })),
    ]) {
      const r = await call();
      expect(r.status).toBe(403);
      expect(JSON.stringify(await r.json())).not.toContain('plans');
    }
    // a member with no grants reads nothing, and an outsider is refused
    expect(
      (await withNoGrants(() => recordsGET(rec(staff, 'Chore')))).status,
    ).toBe(403);
    expect((await recordsGET(rec(h.stranger, 'Chore'))).status).toBe(403);
    expect((await recordsGET(rec(null, 'Chore'))).status).toBe(401);
    const host = await hostFor('live');
    expect(
      (await host.list(hostOwner(host), 'Chore')).map((r) => r.title),
    ).toEqual(['mop']);
  });

  it('create and update follow their grants; delete is never reachable', async () => {
    await runAs(h.owner, () => ModelAccessGrant.grant('Chore', 'create'));
    const made = await recordsPOST(
      rec(staff, 'Chore', { method: 'POST', body: { title: 'sweep' } }),
    );
    expect(made.status).toBe(201);
    const id = ((await made.json()) as { id: string }).id;
    expect(
      (
        await recordPUT(
          one(staff, 'Chore', id, { method: 'PUT', body: { title: 'y' } }),
        )
      ).status,
    ).toBe(403);
    await runAs(h.owner, () => ModelAccessGrant.grant('Chore', 'update'));
    const put = await recordPUT(
      one(staff, 'Chore', id, { method: 'PUT', body: { title: 'sweep!' } }),
    );
    expect(put.status).toBe(200);
    expect(((await put.json()) as { title: string }).title).toBe('sweep!');
    // delete: refused even with every grant, and no approval is created
    expect(
      (await recordDELETE(one(staff, 'Chore', id, { method: 'DELETE' })))
        .status,
    ).toBe(403);
    expect(
      (await appDELETE(app(staff, `chores/${id}`, { method: 'DELETE' })))
        .status,
    ).toBe(403);
    // owner behaviour is unchanged: a delete waits as an approval
    const owner = await recordDELETE(
      one(h.owner, 'Chore', id, { method: 'DELETE' }),
    );
    expect(owner.status).toBe(202);
    expect(((await owner.json()) as { status: string }).status).toBe(
      'pending_approval',
    );
    await runAs(h.owner, async () => {
      await ModelAccessGrant.revoke('Chore', 'create');
      await ModelAccessGrant.revoke('Chore', 'update');
    });
    expect(
      (
        await recordsPOST(
          rec(staff, 'Chore', { method: 'POST', body: { title: 'z' } }),
        )
      ).status,
    ).toBe(403);
  });

  it('the owner reads and writes everything as before', async () => {
    expect((await recordsGET(rec(h.owner, 'Secret'))).status).toBe(200);
    expect((await recordGET(one(h.owner, 'Secret', secret))).status).toBe(200);
  });
});

describe('app REST passthrough as staff', () => {
  it('reads granted models only; writes need their grants', async () => {
    const ok = await appGET(app(staff, 'chores'));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('mop');
    const denied = await appGET(app(staff, 'secrets'));
    expect(denied.status).toBeGreaterThanOrEqual(400);
    expect(await denied.text()).not.toContain('plans');
    const write = await appPOST(
      app(staff, 'chores', { method: 'POST', body: { title: 'rest' } }),
    );
    expect(write.status).toBeGreaterThanOrEqual(400);
    const host = await hostFor('live');
    expect(
      (await host.list(hostOwner(host), 'Chore')).map((r) => r.title),
    ).not.toContain('rest');
    expect((await appGET(app(null, 'chores'))).status).toBe(401);
    expect((await appGET(app(h.stranger, 'chores'))).status).toBe(403);
    expect((await appGET(app(h.owner, 'secrets'))).status).toBe(200);
  });

  it('writes run as the staff principal when granted', async () => {
    await runAs(h.owner, () => ModelAccessGrant.grant('Chore', 'create'));
    const write = await appPOST(
      app(staff, 'chores', { method: 'POST', body: { title: 'rest' } }),
    );
    expect(write.status).toBeLessThan(300);
    const secretWrite = await appPOST(
      app(staff, 'secrets', { method: 'POST', body: { note: 'no' } }),
    );
    expect(secretWrite.status).toBeGreaterThanOrEqual(400);
    await runAs(h.owner, () => ModelAccessGrant.revoke('Chore', 'create'));
  });
});

describe('reports as staff', () => {
  it('runs a report of a readable model; refuses one that reaches an ungranted model; never edits', async () => {
    const ev1 = (name: string, extra = {}) =>
      ev(staff, `/api/shell/reports/${name}`, { params: { name }, ...extra });
    expect((await reportGET(ev1('chores'))).status).toBe(200);
    expect((await reportCsv(ev1('chores'))).status).toBe(200);
    expect((await reportGET(ev1('secrets'))).status).toBe(403);
    expect((await reportCsv(ev1('secrets'))).status).toBe(403);
    for (const name of ['chores', 'secrets'])
      expect(
        (
          await reportPOST(
            ev1(name, { method: 'POST', body: { action: 'remove' } }),
          )
        ).status,
      ).toBe(403);
    expect(
      (
        await reportGET(
          ev(h.owner, '/api/shell/reports/secrets', {
            params: { name: 'secrets' },
          }),
        )
      ).status,
    ).toBe(200);
  });
});

describe('builder routes as staff', () => {
  const routes = import.meta.glob('../../routes/api/**/+server.ts', {
    eager: true,
  }) as Record<
    string,
    Record<string, (e: never) => Promise<Response> | Response>
  >;
  // the record routes (tested above), liveness and sign-in, and the dual-auth receive
  const open = [
    '/api/app/[...path]',
    '/api/events',
    '/api/shell/records/',
    '/api/shell/reports/[name]',
    '/api/_runtime/',
    '/api/shell/app/receive/',
  ];

  it('refuses every other route handler: 403 for staff, 401 for nobody', async () => {
    const seen: string[] = [];
    for (const [file, mod] of Object.entries(routes)) {
      if (/\/api\/(apps|approvals|_changes|_events|_resources)\b/.test(file))
        continue; // generated
      for (const verb of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const) {
        const handler = mod[verb];
        if (!handler) continue;
        const route = file
          .replace('../../routes', '')
          .replace('/+server.ts', '');
        const isRecord =
          open.some((o) => route.startsWith(o)) &&
          !(route === '/api/shell/records/[model]/[id]' && verb === 'DELETE') &&
          !(route === '/api/app/[...path]' && verb === 'DELETE') &&
          !(route === '/api/shell/reports/[name]' && verb === 'POST') &&
          !(route === '/api/shell/reports/[name]/csv' && verb !== 'GET');
        if (isRecord) continue;
        seen.push(`${verb} ${route}`);
        const path = route
          .replace(/\[\.\.\.(\w+)\]/g, 'x')
          .replace(/\[(\w+)\]/g, 'x');
        const params = Object.fromEntries(
          [...route.matchAll(/\[(?:\.\.\.)?(\w+)\]/g)].map((m) => [m[1], 'x']),
        );
        const staffRes = await handler(
          ev(staff, path, {
            method: verb,
            params,
            body: verb === 'GET' ? undefined : {},
          }),
        );
        expect(staffRes.status, `${verb} ${route} as staff`).toBe(403);
        const anon = await handler(
          ev(null, path, {
            method: verb,
            params,
            body: verb === 'GET' ? undefined : {},
          }),
        );
        expect(anon.status, `${verb} ${route} as nobody`).toBe(401);
      }
    }
    expect(seen).toEqual(
      expect.arrayContaining([
        'GET /api/shell/describe',
        'GET /api/shell/history',
        'POST /api/shell/changes/apply',
        'POST /api/shell/undo',
        'GET /api/shell/approvals',
        'DELETE /api/shell/records/[model]/[id]',
        'DELETE /api/app/[...path]',
        'POST /api/shell/reports/[name]',
        'GET /api/shell/import',
      ]),
    );
    expect(seen.length).toBeGreaterThan(20);
  });

  it('staff never get the shell describe', async () => {
    expect((await describeGET(ev(staff, '/api/shell/describe'))).status).toBe(
      403,
    );
    expect((await describeGET(ev(h.owner, '/api/shell/describe'))).status).toBe(
      200,
    );
  });
});

describe('MCP as staff', () => {
  it('lists only the granted record tools, no shell or builder tool, no delete', async () => {
    const names = (await toolsFor(staff)).map((t) => t.name).sort();
    expect(names).toEqual(
      ['chore_count', 'chore_get', 'chore_list'].filter((n) =>
        names.includes(n),
      ),
    );
    expect(names).toEqual(expect.arrayContaining(['chore_list', 'chore_get']));
    for (const name of names) {
      expect(name).toMatch(/^chore_/);
      expect(name).not.toMatch(/_(create|update|delete)$/);
    }
    expect(
      (await withNoGrants(() => toolsFor(staff))).map((t) => t.name),
    ).toEqual([]);
    expect(await toolsFor(h.stranger)).toEqual([]);
    const owner = (await toolsFor(h.owner)).map((t) => t.name);
    expect(owner).toEqual(
      expect.arrayContaining([
        'app_definemodel',
        'secret_list',
        'chore_delete',
      ]),
    );
    const server = createShellMcpServer();
    const listed = (
      await server.listTools({ principal: mcp(staff) } as never)
    ).map((t) => t.name);
    expect(listed).toEqual(names);
  });

  it('dispatches as the staff principal: granted reads work, everything else is refused', async () => {
    const r = await callTool(staff, 'chore_list', {});
    expect(r.isError).toBeFalsy();
    expect(JSON.stringify(r.content)).toContain('mop');
    for (const tool of [
      'app_definemodel',
      'app_describe',
      'approval_pending',
      'secret_list',
      'chore_create',
      'chore_delete',
    ])
      await expect(authorizeCall(staff, tool)).rejects.toMatchObject({
        status: 403,
      });
    await expect(callTool(staff, 'secret_list', {})).rejects.toMatchObject({
      status: 403,
    });
    await withNoGrants(() =>
      expect(callTool(staff, 'chore_list', {})).rejects.toMatchObject({
        status: 403,
      }),
    );
    await expect(callTool(null, 'chore_list', {})).rejects.toMatchObject({
      status: 401,
    });
    // through the MCP server too
    const server = createShellMcpServer();
    await expect(
      server.callTool({
        name: 'app_definemodel',
        arguments: { name: 'X' },
        principal: mcp(staff),
      } as never),
    ).rejects.toMatchObject({ status: 403 });
    // a grant added later is seen without a restart
    await runAs(h.owner, () => ModelAccessGrant.grant('Chore', 'create'));
    expect((await toolsFor(staff)).map((t) => t.name)).toContain(
      'chore_create',
    );
    const made = await callTool(staff, 'chore_create', { title: 'by tool' });
    expect(made.isError).toBeFalsy();
    await runAs(h.owner, () => ModelAccessGrant.revoke('Chore', 'create'));
    await expect(
      callTool(staff, 'chore_create', { title: 'again' }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('the staff view of the app', () => {
  it('describes the granted models only: no methods, code, recipes, draft or approvals', async () => {
    const d = await staffDescription(staff);
    expect(Object.keys(d.models)).toEqual(['Chore']);
    expect(d.models.Chore.methods).toEqual({});
    expect(d.staff).toBe(true);
    expect(d.draft).toBeNull();
    expect(d.recipes).toEqual([]);
    expect(d.pendingApprovals).toBe(0);
    expect(Object.keys(d.reports ?? {})).toEqual(['chores']);
    expect(JSON.stringify(d)).not.toMatch(/Secret|plans/);
  });

  it('a staff member with no grants sees nothing', async () => {
    const d = await withNoGrants(() => staffDescription(staff));
    expect(d.models).toEqual({});
    expect(d.reports).toEqual({});
  });

  it('the layout hands staff the filtered description and the owner the full one', async () => {
    const load = layoutLoad as unknown as (e: unknown) => Promise<{
      description: { models: object; staff?: boolean } | null;
      changes: unknown;
    }>;
    const base = (who: Principal | null) => ({
      ...(ev(who, '/') as object),
      depends: () => {},
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        // the owner's own describe, as the browser would fetch it
        const url = new URL(String(input), 'http://localhost');
        if (url.pathname === '/api/shell/describe')
          return describeGET(ev(who, '/api/shell/describe') as never);
        return new Response(JSON.stringify({}), { status: 404, ...init });
      },
    });
    const asStaff = await load(base(staff));
    expect(Object.keys(asStaff.description?.models ?? {})).toEqual(['Chore']);
    expect(asStaff.changes).toBeNull();
    const none = await withNoGrants(() => load(base(staff)));
    expect(none.description?.models).toEqual({});
    const asOwner = await load(base(h.owner));
    expect(Object.keys(asOwner.description?.models ?? {}).sort()).toEqual([
      'Chore',
      'Secret',
    ]);
    const outsider = await load(base(h.stranger));
    expect(outsider.description).toBeNull();
  });

  it('a model page of an ungranted model is not reachable for staff', async () => {
    const load = modelPage as unknown as (e: unknown) => Promise<unknown>;
    const description = await staffDescription(staff);
    const event = (model: string) => ({
      ...(ev(staff, `/m/${model}`, { params: { model } }) as object),
      depends: () => {},
      parent: async () => ({ description }),
      fetch: async () => new Response('{}', { status: 500 }),
    });
    await expect(load(event('Secret'))).rejects.toMatchObject({
      status: 303,
      location: '/',
    });
    const anon = {
      ...(ev(null, '/m/Chore', { params: { model: 'Chore' } }) as object),
      depends: () => {},
      parent: async () => ({ description: null }),
      fetch,
    };
    await expect(load(anon)).rejects.toMatchObject({ status: 401 });
  });
});

describe('events as staff', () => {
  async function open(who: Principal) {
    const res = await eventsGET(ev(who, '/api/events'));
    expect(res.status).toBe(200);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = '';
    const pump = async (): Promise<boolean> => {
      const { value, done } = await reader.read();
      if (value) text += decoder.decode(value);
      return !done;
    };
    return {
      read: () => text,
      pump,
      reader,
      /** Drain until `ms` passes with nothing new. */
      async settle(ms = 150) {
        for (;;) {
          const more = await Promise.race([
            pump(),
            new Promise<boolean>((r) => setTimeout(() => r(false), ms)),
          ]);
          if (!more) return;
        }
      },
    };
  }

  it('hears only records events of models it may read; owner hears everything', async () => {
    const tenant = h.owner.tenantId;
    const s = await open(staff);
    const o = await open(h.owner);
    await s.settle();
    await o.settle();
    publish(
      { type: 'changed', target: 'live', version: 9, summary: 'secret change' },
      tenant,
    );
    publish(
      {
        type: 'approval',
        id: 'a1',
        status: 'pending',
        summary: 'Delete Secret',
      },
      tenant,
    );
    publish({ type: 'records', target: 'live', model: 'Secret' }, tenant);
    publish({ type: 'records', target: 'draft', model: 'Chore' }, tenant);
    publish({ type: 'records', target: 'live', model: 'Chore' }, tenant);
    await s.settle();
    await o.settle();
    const heard = s.read();
    expect(heard).toContain('"model":"Chore"');
    expect(heard).not.toMatch(
      /Secret|"type":"changed"|"type":"approval"|draft/,
    );
    expect(o.read()).toMatch(/"type":"changed"/);
    expect(o.read()).toMatch(/"model":"Secret"/);
    await s.reader.cancel();
    await o.reader.cancel();
  });

  it('a member with no grants hears no record events; nobody and outsiders are refused', async () => {
    await withNoGrants(async () => {
      const n = await open(staff);
      await n.settle();
      publish(
        { type: 'records', target: 'live', model: 'Chore' },
        h.owner.tenantId,
      );
      publish(
        { type: 'records', target: 'live', model: null },
        h.owner.tenantId,
      );
      await n.settle();
      expect(n.read()).not.toContain('"type":"records"');
      await n.reader.cancel();
    });
    expect((await eventsGET(ev(null, '/api/events'))).status).toBe(401);
    expect((await eventsGET(ev(h.stranger, '/api/events'))).status).toBe(403);
  });

  it('closes the stream once the member is no longer active staff', async () => {
    const { who, membership } = await member(DEFAULT_ROLE_SLUGS.MEMBER);
    await runAs(h.owner, () => ModelAccessGrant.grant('Chore', 'read'));
    const s = await open(who);
    await s.settle();
    publish(
      { type: 'records', target: 'live', model: 'Chore' },
      h.owner.tenantId,
    );
    await s.settle();
    expect(s.read()).toContain('"model":"Chore"');
    membership.status = MembershipStatus.INACTIVE;
    await membership.save();
    publish(
      { type: 'records', target: 'live', model: 'Chore' },
      h.owner.tenantId,
    );
    // the next event ends the stream: the reader sees done
    let ended = false;
    for (let i = 0; i < 20 && !ended; i++) ended = !(await s.pump());
    expect(ended).toBe(true);
  });
});
