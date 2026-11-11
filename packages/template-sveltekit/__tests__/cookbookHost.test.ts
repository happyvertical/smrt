import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  createSqliteOwnerApprovalStore,
  LOCAL_MCP_TOKEN_PRINCIPAL,
  OwnerApprovalAuthority,
} from '@happyvertical/smrt-app-runtime';
import type { SmrtSvelteKitRuntime } from '@happyvertical/smrt-app-runtime/sveltekit';
import { readAssistantTurnStream } from '@happyvertical/smrt-chat/assistant-turn';
import { Customer } from '@happyvertical/smrt-commerce';
import {
  field,
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { APIGenerator } from '@happyvertical/smrt-core/generators/rest';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { createAgentCliService } from '@happyvertical/smrt-inference/server';
import {
  Profile as ProfileBase,
  ProfileTypeCollection,
} from '@happyvertical/smrt-profiles';
import { buildCookbookShell } from '@happyvertical/smrt-svelte/cookbook/server';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { Cookbook } from '@happyvertical/smrt-types';
import {
  MembershipCollection,
  MembershipStatus,
  PermissionCollection,
  PermissionResolver,
  RoleCollection,
  RolePermissionCollection,
  TenantCollection,
  UserCollection,
  UserStatus,
} from '@happyvertical/smrt-users';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import type { RequestEvent } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCookbookHost, loadCookbookModelPage } from '../host/server.js';
import { createCookbookHostState } from '../host/state.js';

@smrt({
  packageName: '@fixture/host',
  tableName: 'host_memos',
  collection: 'host_memos',
  api: { public: true },
  mcp: { include: ['list', 'get', 'create', 'delete'] },
})
class HostMemo extends SmrtObject {
  @field() title = '';
}
// Same empty replacement the public generator emits; retain provider STI ancestry.
@smrt({ packageName: '@fixture/host', name: 'Profile' })
class Profile extends ProfileBase {}
void HostMemo;
void Customer;
void Profile;
const CUSTOMER = '@happyvertical/smrt-commerce:Customer';
const PROFILE = '@happyvertical/smrt-profiles:Profile';
const MEMO = '@fixture/host:HostMemo';
class HostMemos extends SmrtCollection<HostMemo> {
  static readonly _itemClass = HostMemo;
}
ObjectRegistry.registerCollection(MEMO, HostMemos);
const catalog = {
  recipes: [
    {
      id: 'host.customers',
      label: 'Customers',
      models: [CUSTOMER, PROFILE],
      nav: [{ model: CUSTOMER, label: 'Customers' }],
      requires: [],
    },
    {
      id: 'host.memos',
      label: 'Memos',
      models: [MEMO],
      nav: [{ model: MEMO, label: 'Memos' }],
      requires: [],
    },
  ],
  models: [
    { id: CUSTOMER, name: 'Customer', packageId: 'commerce' },
    { id: PROFILE, name: 'Profile', packageId: 'profiles' },
    { id: MEMO, name: 'HostMemo', packageId: 'host' },
  ],
};
const cookbook: Cookbook = {
  $schema: 'https://s-m-r-t.dev/schemas/cookbook/v1.json',
  version: 1,
  recipes: ['host.customers'],
  features: [],
  policies: [],
};
let origin = 'http://127.0.0.1:4999';
type Host = ReturnType<typeof createCookbookHost>;
let host: Host;
let db: Awaited<ReturnType<typeof getTestDatabase>>;
let owner: { id: string; profileId: string };
let tenantId: string;
let permissions: string[];
let profileTypeId: string;
let response: (
  messages: Array<{ role: string; content: string }>,
  options: { tools?: Array<{ function: { name: string } }> },
) => unknown;
const errors: unknown[] = [];
let stateDirectory: string;
let http: Server | undefined;
let issued: Array<{
  token: string;
  holder?: string;
  scopes: readonly string[];
  expiresInSeconds?: number;
}>;
let revoked: string[];
let tokens: Map<string, { holder?: string; scopes: readonly string[] }>;

function event(
  path: string,
  method = 'GET',
  body?: unknown,
  authenticated = true,
): RequestEvent {
  const url = new URL(path, origin);
  return {
    url,
    request: new Request(url, {
      method,
      headers: {
        origin,
        host: url.host,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    params: { path: path.replace('/api/assistant/', '') },
    locals: authenticated
      ? { user: owner, tenantId, permissions }
      : { user: null },
  } as unknown as RequestEvent;
}
async function request(e: RequestEvent, handler: (e: RequestEvent) => unknown) {
  return host.handle({
    event: e,
    resolve: async (e) => (await handler(e)) as Response,
  });
}
async function chat(path: string, body?: unknown, method = 'POST') {
  return request(event(`/api/assistant/${path}`, method, body), (e) =>
    host.assistant.handle(e),
  );
}
async function thread() {
  const r = await chat('threads', { title: 'Host test' });
  expect(r.status, JSON.stringify(errors)).toBe(201);
  return (await r.json()).thread.id as string;
}
async function turn(id: string, content: string) {
  const r = await chat(`threads/${id}/messages`, {
    content,
    clientRequestId: randomUUID(),
  });
  expect(r.status, JSON.stringify(errors)).toBe(200);
  const events: Array<Record<string, unknown>> = [];
  try {
    await readAssistantTurnStream(r, (e) => {
      events.push(e as unknown as Record<string, unknown>);
    });
  } catch (error) {
    throw new Error(
      `${String(error)}; fixture errors: ${JSON.stringify(errors)}`,
    );
  }
  return events;
}
const tool = (name: string, args: unknown) => ({
  content: '',
  finishReason: 'tool_calls',
  toolCalls: [
    {
      id: randomUUID(),
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    },
  ],
});
const text = () => ({ content: 'Done.', finishReason: 'stop' });
async function mcp(
  method = 'tools/list',
  params?: unknown,
  token = 'owner-token-fixture-123456789',
) {
  const e = event(
    '/mcp',
    'POST',
    {
      jsonrpc: '2.0',
      id: 1,
      method,
      params: {
        ...((params as object) ?? {}),
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
          [CLIENT_INFO_META_KEY]: { name: 'host-test', version: '1' },
          [CLIENT_CAPABILITIES_META_KEY]: {},
        },
      },
    },
    false,
  );
  e.request.headers.set('authorization', `Bearer ${token}`);
  e.request.headers.delete('accept');
  e.request.headers.set('mcp-protocol-version', '2026-07-28');
  e.request.headers.set('mcp-method', method);
  if (method === 'tools/call')
    e.request.headers.set(
      'mcp-name',
      String((params as { name: string }).name),
    );
  const r = await request(e, host.mcp);
  const raw = await r.text();
  if (r.status === 200) expect(raw, `MCP response ${r.status}`).not.toBe('');
  return { status: r.status, body: raw ? JSON.parse(raw) : null };
}

beforeEach(async () => {
  enableTenancy();
  origin = 'http://127.0.0.1:4999';
  stateDirectory = await mkdtemp(join(tmpdir(), 'cookbook-host-cli-'));
  const bin = join(stateDirectory, 'bin');
  await mkdir(bin);
  const stub = await readFile(
    new URL(
      '../../inference/src/agent-cli/test-fixtures/stub-cli.mjs',
      import.meta.url,
    ),
    'utf8',
  );
  const fixture = stub.replace(
    '#!/usr/bin/env node',
    `#!${process.execPath}\nif (process.argv.includes('--version')) { console.log('1.2.3'); process.exit(0); }\nif (process.argv.slice(2).join(' ') === 'auth status') { console.log('{"loggedIn":true}'); process.exit(0); }\nif (process.argv.slice(2).join(' ') === 'login status') { console.log('Logged in using ChatGPT'); process.exit(0); }`,
  );
  for (const binary of ['claude', 'codex'])
    await writeFile(join(bin, binary), fixture, { mode: 0o700 });
  const cli = createAgentCliService({
    env: Object.fromEntries([
      ['HOME', stateDirectory],
      ['PATH', `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`],
    ]),
    platform: process.platform,
    home: stateDirectory,
    loginShell: false,
    systemDirs: [],
  });
  issued = [];
  revoked = [];
  tokens = new Map();
  errors.length = 0;
  db = await getTestDatabase();
  const tenants = await TenantCollection.create({ db });
  const tenant = await tenants.create({ name: 'Host business' });
  await tenant.save();
  tenantId = tenant.id!;
  const profileType = await (
    await ProfileTypeCollection.create({ db })
  ).getOrCreateBySlug('person', { name: 'Person' });
  profileTypeId = profileType.id!;
  const profile = await (
    await ObjectRegistry.getCollection(PROFILE, { db })
  ).create({ name: 'Owner', typeId: profileTypeId });
  await profile.save();
  const user = await (await UserCollection.create({ db })).create({
    profileId: profile.id!,
    email: `${randomUUID()}@test.invalid`,
    status: UserStatus.ACTIVE,
  });
  await user.save();
  owner = { id: user.id!, profileId: profile.id! };
  response = text;
  const runtime = {
    init: async () => {},
    resolvedRuntime: async () => ({ profile: 'local' }),
    database: async () => db,
    databaseConfig: () => db,
    classOptions: () => ({ db }),
    secretMasterKey: async () => null,
    signInLocalOwner: async () => {
      throw new Error('Owner-link is covered by runtime and app smoke tests');
    },
    handle: async ({
      event: e,
      resolve,
    }: {
      event: RequestEvent;
      resolve(e: RequestEvent): Promise<Response>;
    }) =>
      withTenant(
        { tenantId, userId: owner.id, permissions: new Set(permissions) },
        () => resolve(e),
      ),
    runAsPrincipal: async (
      p: { id: string; tenantId: string; scopes?: string[] },
      run: (p: unknown) => Promise<unknown>,
    ) => {
      const live = (
        await (
          await PermissionResolver.create({ db })
        ).resolvePermissions(p.id, p.tenantId)
      ).permissions;
      const scopes = [...live].filter((s) => !p.scopes || p.scopes.includes(s));
      return withTenant(
        { tenantId: p.tenantId, userId: p.id, permissions: new Set(scopes) },
        () => run({ ...p, scopes }),
      );
    },
    verifyLocalMcpToken: async (token: string) =>
      token === 'owner-token-fixture-123456789'
        ? Object.freeze({
            ...owner,
            tenantId,
            scopes: Object.freeze([...permissions]),
            kind: 'human',
            tenantBinding: 'direct',
            [LOCAL_MCP_TOKEN_PRINCIPAL]: true,
          })
        : null,
    resolveMcpPrincipal: async () => null,
    localRuntime: async () => ({
      paths: { root: stateDirectory },
      mcpTokens: {
        issue: async (input: {
          holder?: string;
          scopes: readonly string[];
          expiresInSeconds?: number;
        }) => {
          const value = { ...input, token: randomUUID() + randomUUID() };
          issued.push(value);
          tokens.set(value.token, input);
          return value;
        },
        revokeHolder: async (holder: string) => {
          revoked.push(holder);
          for (const [token, value] of tokens)
            if (value.holder === holder) tokens.delete(token);
          return 'revoked';
        },
      },
    }),
    sessionCookie: { name: 'session' },
  } as unknown as SmrtSvelteKitRuntime;
  runtime.verifyLocalMcpToken = async (token) => {
    const scopes =
      token === 'owner-token-fixture-123456789'
        ? permissions
        : tokens.get(token)?.scopes.filter((s) => permissions.includes(s));
    return scopes
      ? Object.freeze({
          id: owner.id,
          tenantId,
          scopes: Object.freeze([...scopes]),
          kind: 'human',
          tenantBinding: 'direct',
          [LOCAL_MCP_TOKEN_PRINCIPAL]: true as const,
        })
      : null;
  };
  host = createCookbookHost({
    onboarding: true,
    runtime,
    cli,
    app: { cookbook, catalog },
    assistant: {
      ai: {
        chat: async (m: unknown, o: unknown) =>
          response(m as never, o as never),
      } as never,
      onError: (e) => {
        errors.push(String(e));
      },
    },
  });
  const roles = await RoleCollection.create({ db });
  await roles.seedSystemRoles({ seedPermissions: true });
  const role = await roles.findSystemRoleBySlug('owner');
  const membership = await (await MembershipCollection.create({ db })).create({
    userId: owner.id,
    tenantId,
    roleId: role!.id!,
    status: MembershipStatus.ACTIVE,
  });
  await membership.save();
  permissions = [
    ...(
      await (
        await PermissionResolver.create({ db })
      ).resolvePermissions(owner.id, tenantId)
    ).permissions,
  ];
  await host.init();
});
afterEach(async () => {
  if (http) {
    http.closeAllConnections();
    await new Promise<void>((resolve) => http!.close(() => resolve()));
    http = undefined;
  }
  host?.dispose();
  disableTenancy();
  await db?.close?.();
  await rm(stateDirectory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('local cookbook host composition (SQLite, fake model, no providers)', () => {
  it.each([
    'claude-code',
    'codex',
  ] as const)('runs %s through the real host MCP route with short-lived scoped credentials and no API fallback', async (engine) => {
    http = createServer(async (incoming, outgoing) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        const e = event(
          '/mcp',
          'POST',
          JSON.parse(Buffer.concat(chunks).toString('utf8')),
          false,
        );
        for (const [name, value] of Object.entries(incoming.headers))
          if (typeof value === 'string') e.request.headers.set(name, value);
        const result = await request(e, host.mcp);
        outgoing.writeHead(result.status, Object.fromEntries(result.headers));
        outgoing.end(await result.text());
      } catch {
        outgoing.writeHead(500);
        outgoing.end();
      }
    });
    await new Promise<void>((resolve) => http!.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    const selection = await request(
      event('/api/connect-ai', 'POST', { action: 'select', engine }),
      host.connectAi.POST,
    );
    expect(selection.status).toBe(200);
    const listing = await mcp();
    const name = listing.body.result.tools.find((t: { name: string }) =>
      /customer_list$/.test(t.name),
    )?.name;
    expect(name).toBeTruthy();
    response = () => {
      throw new Error('An API fallback is forbidden');
    };
    const seen = await turn(await thread(), `tool ${name} {}`);
    expect(
      seen.some((e) => e.type === 'error'),
      JSON.stringify({ errors, seen }),
    ).toBe(false);
    expect(
      seen.some(
        (e) =>
          e.type === 'step' &&
          ['tool_call', 'tool_result'].includes(
            (e.step as { kind: string }).kind,
          ),
      ),
    ).toBe(true);
    expect(issued).toHaveLength(1);
    expect(issued[0].expiresInSeconds).toBe(900);
    expect(issued[0].scopes).toContain('customers.read');
    expect(issued[0].scopes).toContain('recipes.enable');
    expect(revoked).toEqual([issued[0].holder]);
    expect(tokens.size).toBe(0);
    expect(JSON.stringify(seen).includes(issued[0].token)).toBe(false);
  });
  it('gates REST, MCP and navigation together; preference disable closes them', async () => {
    const rest = new APIGenerator(
      { basePath: '/api', authMiddleware: () => async (req) => req },
      { db, tenantId },
    ).generateHandler();
    expect(
      (await request(event('/api/host_memos'), (e) => rest(e.request))).status,
    ).toBe(404);
    const listing = await mcp();
    expect(listing.status).toBe(200);
    expect(
      listing.body.result.tools.some((t: { name: string }) =>
        t.name.includes('customer'),
      ),
    ).toBe(true);
    expect(
      listing.body.result.tools.some((t: { name: string }) =>
        t.name.includes('hostmemo'),
      ),
    ).toBe(false);
    const state = await request(
      event('/api/cookbook/prebuilt'),
      host.prebuilt,
    ).then((r) => r.json());
    expect(
      (
        await request(
          event('/api/cookbook/prebuilt', 'POST', {
            enabled: false,
            revision: state.revision,
          }),
          host.prebuilt,
        )
      ).status,
    ).toBe(200);
    expect((await mcp()).body.result.tools).toEqual([]);
    expect(
      (await request(event('/'), async (e) => json(await host.load(e)))).status,
    ).toBe(200);
    const app = await host.cookbookApp(tenantId);
    expect(app.cookbook.recipes).toEqual([]);
    expect((await mcp('tools/list', undefined, 'invalid')).status).toBe(401);
  });

  it('persists an external MCP delete and resumes it once through the owner route after host restart', async () => {
    const state = await createCookbookHostState(db, catalog, cookbook);
    await state.refresh(tenantId);
    const before = state.engineFor({ tenantId })!.state();
    const after = structuredClone(before);
    after.revision++;
    after.cookbook.recipes.push('host.memos');
    await state.commit({
      context: { surface: 'assistant', tenantId, userId: owner.id },
      before,
      after,
      audit: {
        context: { surface: 'assistant', tenantId, userId: owner.id },
        tool: 'recipes.enable',
        outcome: 'changed',
        summary: 'Enable fixture',
      },
    });
    const customers = await ObjectRegistry.getCollection(MEMO, { db });
    const customer = await customers.create({ title: 'Held memo' });
    await customer.save();
    const listing = await mcp();
    const name = listing.body.result.tools.find(
      (t: { name: string }) =>
        t.name.includes('hostmemo') && t.name.includes('delete'),
    )?.name;
    expect(name).toBeTruthy();
    const held = await mcp('tools/call', {
      name,
      arguments: { id: customer.id },
    });
    expect(held.body.result, JSON.stringify(held.body)).toBeTruthy();
    const pending = JSON.parse(held.body.result.content[0].text);
    expect(pending).toMatchObject({
      status: 'approval_required',
      outcomeTool: 'owner_approval_outcome',
    });
    expect(await customers.get(customer.id!)).toBeTruthy();
    const runtime = host.runtime;
    host.dispose();
    host = createCookbookHost({ runtime, app: { cookbook, catalog } });
    await host.init();
    const rows = await (await chat('approvals', undefined, 'GET')).json();
    expect(rows.approvals).toContainEqual(
      expect.objectContaining({ id: pending.approvalId, status: 'pending' }),
    );
    const decision = await chat(`approvals/${pending.approvalId}/decide`, {
      approve: true,
    });
    expect(decision.status).toBe(200);
    expect((await decision.json()).approval.status).toBe('succeeded');
    expect(await customers.get(customer.id!)).toBeFalsy();
    expect(
      (await chat(`approvals/${pending.approvalId}/decide`, { approve: true }))
        .status,
    ).toBe(409);
    const outcome = await mcp('tools/call', {
      name: 'owner_approval_outcome',
      arguments: { id: pending.approvalId },
    });
    expect(JSON.parse(outcome.body.result.content[0].text)).toMatchObject({
      status: 'succeeded',
    });
  });

  it('recovers an approved but unconsumed external call after restart without replaying its outcome', async () => {
    const state = await createCookbookHostState(db, catalog, cookbook);
    await state.refresh(tenantId);
    const before = state.engineFor({ tenantId })!.state();
    const after = structuredClone(before);
    after.revision++;
    after.cookbook.recipes.push('host.memos');
    await state.commit({
      context: { surface: 'assistant', tenantId, userId: owner.id },
      before,
      after,
      audit: {
        context: { surface: 'assistant', tenantId },
        tool: 'recipes.enable',
        outcome: 'changed',
        summary: 'Fixture enable',
      },
    });
    const memos = await ObjectRegistry.getCollection(MEMO, { db });
    const memo = await memos.create({ title: 'Recover this call' });
    await memo.save();
    const held = await mcp('tools/call', {
      name: 'hostmemo_delete',
      arguments: { id: memo.id },
    });
    const pending = JSON.parse(held.body.result.content[0].text);
    const authority = new OwnerApprovalAuthority(
      await createSqliteOwnerApprovalStore(db),
      async (actor) => actor.id === owner.id && actor.tenantId === tenantId,
    );
    await authority.decide(
      { id: owner.id, tenantId },
      pending.approvalId,
      true,
    ); // Crash boundary before dispatch.
    const runtime = host.runtime;
    host.dispose();
    host = createCookbookHost({ runtime, app: { cookbook, catalog } });
    await host.init();
    const outcome = await mcp('tools/call', {
      name: 'owner_approval_outcome',
      arguments: { id: pending.approvalId },
    });
    expect(JSON.parse(outcome.body.result.content[0].text).status).toBe(
      'succeeded',
    );
    expect(await memos.get(memo.id!)).toBeNull();
    const replacement = await memos.create({
      id: memo.id,
      title: 'Do not replay',
    });
    await replacement.save();
    await mcp('tools/call', {
      name: 'owner_approval_outcome',
      arguments: { id: pending.approvalId },
    });
    expect((await memos.get(memo.id!))?.toJSON()).toMatchObject({
      title: 'Do not replay',
    });
  });

  it('keeps dependency identity tools and app references after approved business removal without inventing lists', async () => {
    const runtime = host.runtime;
    host.dispose();
    const app = {
      cookbook: { ...cookbook, recipes: ['host.customers', 'host.identity'] },
      catalog: {
        ...catalog,
        recipes: [
          {
            ...catalog.recipes[0],
            models: [CUSTOMER],
            requires: ['host.identity'],
          },
          catalog.recipes[1],
          {
            id: 'host.identity',
            label: 'Identity prerequisites',
            models: [PROFILE],
            nav: [],
            requires: [],
          },
        ],
      },
    };
    host = createCookbookHost({
      runtime,
      app,
      packageName: '@fixture/host-prerequisites',
    });
    await host.init();
    const listing = await mcp();
    const names = listing.body.result.tools.map(
      (tool: { name: string }) => tool.name,
    );
    expect(names).toContain('profile_create');
    expect(names).toContain('app_describe');
    const described = await mcp('tools/call', {
      name: 'app_describe',
      arguments: {},
    });
    expect(
      JSON.parse(described.body.result.content[0].text).lists.map(
        (list: { label: string }) => list.label,
      ),
    ).toEqual(['Customers']);
    const projection = await host.cookbookApp(tenantId);
    const shell = buildCookbookShell(projection);
    expect([...shell.entries.values()].map((entry) => entry.label)).toEqual([
      'Customers',
    ]);
    expect(shell.sections).toHaveLength(1);
    const page = await loadCookbookModelPage({
      ...event('/m/commerce/Customer'),
      params: { pkg: 'commerce', model: 'Customer' },
      parent: async () => ({ cookbookApp: projection }),
    } as unknown as Parameters<typeof loadCookbookModelPage>[0]);
    expect(page.referenceHrefs['@fixture/host:Profile']).toBeUndefined();
    expect(page.entry.model).toBe(CUSTOMER);
    const held = await mcp('tools/call', {
      name: names.find((name: string) => name.endsWith('recipes_disable')),
      arguments: { id: 'host.customers', expectedRevision: 0 },
    });
    const pending = JSON.parse(held.body.result.content[0].text);
    expect(pending.status).toBe('approval_required');
    expect((await host.cookbookApp(tenantId)).cookbook.recipes).toContain(
      'host.customers',
    );
    host.dispose();
    host = createCookbookHost({
      runtime,
      app,
      packageName: '@fixture/host-prerequisites',
    });
    await host.init();
    const decision = await chat(`approvals/${pending.approvalId}/decide`, {
      approve: true,
    });
    expect(decision.status).toBe(200);
    expect((await decision.json()).approval.status).toBe('succeeded');
    const remaining = await host.cookbookApp(tenantId);
    expect(remaining.cookbook.recipes).toEqual(['host.identity']);
    expect(buildCookbookShell(remaining).navGroups).toEqual([]);
    const created = await mcp('tools/call', {
      name: 'profile_create',
      arguments: {
        createType: '@fixture/host:Profile',
        name: 'Framework identity',
        typeId: profileTypeId,
      },
    });
    expect(created.body.result.isError, JSON.stringify(created.body)).not.toBe(
      true,
    );
    expect(ObjectRegistry.getClass(PROFILE)?.constructor).toBe(Profile);
    expect(
      (await mcp()).body.result.tools.map(
        (tool: { name: string }) => tool.name,
      ),
    ).not.toContain('customer_create');
    expect(
      (await chat(`approvals/${pending.approvalId}/decide`, { approve: true }))
        .status,
    ).toBe(409);
  });

  it('continues a native cookbook disable without a thread or double consumption', async () => {
    const disableName = (await mcp()).body.result.tools.find(
      (t: { name: string }) => t.name.endsWith('recipes_disable'),
    )?.name;
    expect(disableName).toBeTruthy();
    const held = await mcp('tools/call', {
      name: disableName,
      arguments: { id: 'host.customers', expectedRevision: 0 },
    });
    expect(held.body.result, JSON.stringify(held.body)).toBeTruthy();
    const pending = JSON.parse(held.body.result.content[0].text);
    expect(pending.status).toBe('approval_required');
    const runtime = host.runtime;
    host.dispose();
    host = createCookbookHost({ runtime, app: { cookbook, catalog } });
    await host.init();
    const decision = await chat(`approvals/${pending.approvalId}/decide`, {
      approve: true,
    });
    expect(decision.status).toBe(200);
    expect((await decision.json()).approval.status).toBe('succeeded');
    expect((await host.cookbookApp(tenantId)).cookbook.recipes).toEqual([]);
    expect(
      (await chat(`approvals/${pending.approvalId}/decide`, { approve: true }))
        .status,
    ).toBe(409);
  });

  it('resumes app remove-field and remove-list holds through the shared owner route across restart', async () => {
    const runtime = host.runtime;
    host.dispose();
    const app = { cookbook, catalog: structuredClone(catalog) };
    host = createCookbookHost({
      runtime,
      packageName: '@fixture/host-remove',
      app,
      assistant: {
        ai: {
          chat: async (m: unknown, o: unknown) =>
            response(m as never, o as never),
        } as never,
      },
    });
    await host.init();
    let editor: Awaited<ReturnType<typeof host.modelEditor>>;
    await request(event('/'), async () => {
      editor = await host.modelEditor(tenantId);
      return new Response();
    });
    await editor!.apply(
      {
        type: 'create_list',
        name: 'ApprovalMat',
        list: {
          label: 'Loaner mats',
          icon: 'layers',
          displayField: 'size',
          fields: { size: { type: 'text' } },
        },
      },
      {
        actor: owner.id,
        tenantId,
        requestId: randomUUID(),
        expectedRevision: 0,
      },
    );
    const offered = (await mcp()).body.result.tools;
    expect(
      offered.find(
        (entry: { name: string }) => entry.name === 'app_remove_list',
      ).annotations.destructiveHint,
    ).toBe(true);
    expect(
      offered.find((entry: { name: string }) => entry.name === 'app_history')
        .annotations.readOnlyHint,
    ).toBe(true);
    let rounds = 0;
    response = () =>
      ++rounds === 1
        ? tool('app.removeField', {
            list: 'Loaner mats',
            field: 'Size',
            expectedRevision: editor!.snapshot().revision,
          })
        : text();
    const seen = await turn(
      await thread(),
      'Remove the Size field from Loaner mats',
    );
    expect(seen.some((e) => e.type === 'error')).toBe(false);
    const ownerRows = (await (await chat('approvals', undefined, 'GET')).json())
      .approvals;
    const fieldRows = ownerRows.filter(
      (row: { tool: string }) => row.tool === 'app.removeField',
    );
    expect(fieldRows).toHaveLength(1);
    const fieldHold = { approvalId: fieldRows[0].id };
    expect(fieldRows[0].status).toBe('pending');
    expect(editor!.snapshot().revision).toBe(1);
    const fieldDecision = await chat(
      `approvals/${fieldHold.approvalId}/decide`,
      { approve: true },
    );
    expect(fieldDecision.status).toBe(200);
    expect((await fieldDecision.json()).approval.status).toBe('succeeded');
    expect(editor!.snapshot().cookbook.policies).toContainEqual(
      expect.objectContaining({ fieldName: 'size', visibility: 'hidden' }),
    );
    const listCall = await mcp('tools/call', {
      name: 'app_remove_list',
      arguments: {
        list: 'Loaner mats',
        expectedRevision: editor!.snapshot().revision,
      },
    });
    const listHold = JSON.parse(listCall.body.result.content[0].text);
    expect(listHold.status).toBe('approval_required');
    host.dispose();
    host = createCookbookHost({
      runtime,
      packageName: '@fixture/host-remove',
      app,
    });
    await host.init();
    const listDecision = await chat(`approvals/${listHold.approvalId}/decide`, {
      approve: true,
    });
    expect(listDecision.status).toBe(200);
    expect((await listDecision.json()).approval.status).toBe('succeeded');
    expect((await host.cookbookApp(tenantId)).cookbook.features).not.toContain(
      '@fixture/host-remove:ApprovalMat',
    );
    expect(
      (await chat(`approvals/${listHold.approvalId}/decide`, { approve: true }))
        .status,
    ).toBe(409);
    const outcome = await mcp('tools/call', {
      name: 'owner_approval_outcome',
      arguments: { id: listHold.approvalId },
    });
    expect(JSON.parse(outcome.body.result.content[0].text).status).toBe(
      'succeeded',
    );
  });

  it('continues an approved template apply after recreating the host and its preview cache', async () => {
    const runtime = host.runtime;
    host.dispose();
    const app = {
      cookbook,
      catalog: {
        ...structuredClone(catalog),
        cookbooks: [
          {
            id: 'host-template',
            name: 'Memos only',
            document: { ...cookbook, recipes: ['host.memos'] },
          },
        ],
      },
    };
    host = createCookbookHost({
      runtime,
      packageName: '@fixture/host-app',
      app,
    });
    await host.init();
    const previewCall = await mcp('tools/call', {
      name: 'cookbook_apply',
      arguments: { id: 'host-template' },
    });
    const preview = JSON.parse(previewCall.body.result.content[0].text);
    const held = await mcp('tools/call', {
      name: 'cookbook_apply',
      arguments: {
        id: 'host-template',
        apply: true,
        expectedRevision: preview.revision,
        previewToken: preview.previewToken,
      },
    });
    const pending = JSON.parse(held.body.result.content[0].text);
    expect(pending.status).toBe('approval_required');
    host.dispose();
    host = createCookbookHost({
      runtime,
      packageName: '@fixture/host-app',
      app,
    });
    await host.init();
    const decision = await chat(`approvals/${pending.approvalId}/decide`, {
      approve: true,
    });
    expect(decision.status).toBe(200);
    expect((await decision.json()).approval.status).toBe('succeeded');
    expect((await host.cookbookApp(tenantId)).cookbook.recipes).toEqual([
      'host.memos',
    ]);
  });

  it('publishes a live custom list and reference through gated dynamic REST and keeps later recipe changes', async () => {
    const runtime = host.runtime;
    host.dispose();
    host = createCookbookHost({
      runtime,
      packageName: '@fixture/host-app',
      app: { cookbook, catalog: structuredClone(catalog) },
      activation: () => ({
        boot: async () => {},
        gate: (gate) => gate,
        isReady: () => true,
        activate: async (ids) => {
          expect([...ids]).not.toContain('@fixture/host-app:LoanerMat');
        },
      }),
    });
    await host.init();
    let editor: Awaited<ReturnType<typeof host.modelEditor>>;
    await request(event('/'), async () => {
      editor = await host.modelEditor(tenantId);
      return new Response();
    });
    const permission = await (
      await PermissionCollection.create({ db })
    ).findBySlug('customers.create');
    const role = await (
      await RoleCollection.create({ db })
    ).findSystemRoleBySlug('owner');
    const grants = await (await RolePermissionCollection.create({ db })).list({
      where: { roleId: role!.id, permissionId: permission!.id },
    });
    expect(grants).toHaveLength(1);
    await grants[0].delete(); // An existing operator revocation must stay removed.
    const added = await editor!.apply(
      {
        type: 'create_list',
        name: 'LoanerMat',
        list: {
          label: 'Loaner mats',
          icon: 'layers',
          displayField: 'size',
          fields: {
            size: { type: 'text' },
            customerId: { type: 'reference', target: CUSTOMER },
          },
        },
      },
      {
        actor: owner.id,
        tenantId,
        requestId: randomUUID(),
        expectedRevision: editor!.snapshot().revision,
      },
    );
    const definition = added.webDefinitions.find(
      (d) => d.objectRef === '@fixture/host-app:LoanerMat',
    )!;
    permissions = [
      ...(
        await (
          await PermissionResolver.create({ db })
        ).resolvePermissions(owner.id, tenantId)
      ).permissions,
    ];
    expect(permissions).toContain(`${definition.name}.create`);
    expect(permissions).toContain(`${definition.name}.read`);
    expect(permissions).not.toContain('customers.create');
    const created = await request(
      event(`/api/${definition.name}`, 'POST', { size: 'large' }),
      () => new Response(null, { status: 404 }),
    );
    expect(created.status, await created.clone().text()).toBe(201);
    const load = await request(event('/'), async (e) =>
      json(await host.load(e)),
    ).then((r) => r.json());
    expect(load.enabledModels).toContain('@fixture/host-app:LoanerMat');
    expect(
      load.dynamicDefinitions.find(
        (d: { objectRef: string }) => d.objectRef === definition.objectRef,
      ).relationships,
    ).toContainEqual(
      expect.objectContaining({
        field: 'customerId',
        relatedCollection: 'customers',
      }),
    );
    const revision = (await editor!.snapshot()).revision;
    const enableName = (await mcp()).body.result.tools.find(
      (t: { name: string }) => t.name.endsWith('recipes_enable'),
    )?.name;
    const enable = await mcp('tools/call', {
      name: enableName,
      arguments: { id: 'host.memos', expectedRevision: revision },
    });
    expect(JSON.parse(enable.body.result.content[0].text).status).toBe('ok');
    await editor!.apply(
      { type: 'relabel_list', name: 'LoanerMat', label: 'Studio mats' },
      {
        actor: owner.id,
        tenantId,
        requestId: randomUUID(),
        expectedRevision: editor!.snapshot().revision,
      },
    );
    expect((await host.cookbookApp(tenantId)).cookbook.recipes).toContain(
      'host.memos',
    );
    const pref = await (
      await request(event('/api/cookbook/prebuilt'), host.prebuilt)
    ).json();
    await request(
      event('/api/cookbook/prebuilt', 'POST', {
        enabled: false,
        revision: pref.revision,
      }),
      host.prebuilt,
    );
    const listing = (await mcp()).body.result.tools.map(
      (tool: { name: string }) => tool.name,
    );
    expect(listing).toContain('app_describe');
    const projected = await request(event('/'), async (e) =>
      json(await host.load(e)),
    ).then((r) => r.json());
    expect(projected.enabledModels).toContain('@fixture/host-app:LoanerMat');
    expect(projected.enabledModels).not.toContain(CUSTOMER);
  });

  it('awaits activation before publishing a recipe and leaves failed activation disabled', async () => {
    const runtime = host.runtime;
    host.dispose();
    let fail = true;
    const activate = vi.fn(async (ids: Iterable<string>) => {
      expect([...ids]).toContain(MEMO);
      expect((await host.cookbookApp(tenantId)).cookbook.recipes).not.toContain(
        'host.memos',
      );
      if (fail) throw new Error('Fixture migration failed');
    });
    host = createCookbookHost({
      runtime,
      app: { cookbook, catalog },
      activation: () => ({
        activate,
        boot: async () => {},
        isReady: () => true,
        gate: (gate) => gate,
      }),
    });
    await host.init();
    const name = (await mcp()).body.result.tools.find((t: { name: string }) =>
      t.name.endsWith('recipes_enable'),
    ).name;
    const refused = await mcp('tools/call', {
      name,
      arguments: { id: 'host.memos', expectedRevision: 0 },
    });
    expect(JSON.stringify(refused.body)).toContain('activation_failed');
    expect((await host.cookbookApp(tenantId)).cookbook.recipes).not.toContain(
      'host.memos',
    );
    fail = false;
    const enabled = await mcp('tools/call', {
      name,
      arguments: { id: 'host.memos', expectedRevision: 0 },
    });
    expect(JSON.parse(enabled.body.result.content[0].text).status).toBe('ok');
    expect(activate).toHaveBeenCalledTimes(2);
    expect((await host.cookbookApp(tenantId)).cookbook.recipes).toContain(
      'host.memos',
    );
  });

  it.each([
    undefined,
    '@fixture/host:Profile',
  ])('a stub assistant creates a Customer linked to its effective Profile using createType %s, never a Bot', async (createType) => {
    let round = 0;
    let profileId = '';
    response = (messages, options) => {
      expect(
        options.tools?.some((t) => t.function.name === 'customers-read'),
      ).toBe(true);
      round += 1;
      if (round === 1) return tool('customers-read', {});
      if (round === 2)
        return tool('profiles-create', {
          name: 'Ada Customer',
          typeId: profileTypeId,
          ...(createType ? { createType } : {}),
        });
      if (round === 3) {
        profileId = JSON.parse(
          messages.filter((m) => m.role === 'tool').at(-1)!.content,
        ).id;
        return tool('customers-create', { profileId });
      }
      return text();
    };
    const events = await turn(await thread(), 'List my customers and add Ada');
    expect(
      events.some((e) => e.type === 'error'),
      JSON.stringify(errors),
    ).toBe(false);
    const profiles = await ObjectRegistry.getCollection(PROFILE, { db });
    const profile = await profiles.get(profileId);
    expect(profile?.toJSON()).toMatchObject({ name: 'Ada Customer' });
    expect(profile?.constructor.name).toBe('Profile');
    const customers = await ObjectRegistry.getCollection(CUSTOMER, { db });
    const createdCustomers = await customers.list({
      where: { profileId },
      displayLabel: true,
    });
    expect(createdCustomers).toHaveLength(1);
    expect(createdCustomers[0].toJSON()).toMatchObject({
      displayLabel: 'Ada Customer',
    });
    const row = (
      await db.query('SELECT _meta_type FROM profiles WHERE id = ?', profileId)
    ).rows[0];
    expect(String(row._meta_type)).not.toContain('Bot');
    expect(row._meta_type).toBe('@fixture/host:Profile');
    expect(ObjectRegistry.getClassByQualifiedName(PROFILE)).toBeUndefined();
    expect(ObjectRegistry.getClass(PROFILE)?.constructor).toBe(Profile);
  });

  it('assistant creates a named member in one ordinary Customer create call', async () => {
    let round = 0;
    response = (_messages, options) => {
      const create = options.tools?.find(
        (t) => t.function.name === 'customers-create',
      );
      expect(
        (
          create?.function as
            | { parameters?: { properties?: unknown } }
            | undefined
        )?.parameters?.properties,
      ).toHaveProperty('name');
      round++;
      return round === 1
        ? tool('customers-create', {
            name: 'Typed Member',
            email: 'typed@example.test',
            phone: '555-0100',
          })
        : text();
    };
    const events = await turn(await thread(), 'Add Typed Member');
    expect(
      events.some((e) => e.type === 'error'),
      JSON.stringify(errors),
    ).toBe(false);
    const customers = await ObjectRegistry.getCollection(CUSTOMER, { db });
    const members = await customers.list({ displayLabel: true });
    const member = members.find(
      (m) => m.toJSON().displayLabel === 'Typed Member',
    );
    expect(member).toBeDefined();
    const contact = await (
      await ObjectRegistry.getCollection(PROFILE, { db })
    ).get(String(member?.toJSON().profileId));
    expect(contact?.toJSON()).toMatchObject({
      name: 'Typed Member',
      email: 'typed@example.test',
    });
    expect(contact?.constructor.name).toBe('Profile');
  });

  it('MCP advertises and accepts Customer inline fields without changing createType dispatch', async () => {
    const offered = (await mcp()).body.result.tools;
    expect(
      offered.find((t: { name: string }) => t.name === 'customer_create')
        ?.inputSchema.properties,
    ).toHaveProperty('name');
    const result = await mcp('tools/call', {
      name: 'customer_create',
      arguments: { name: 'MCP Member', email: 'mcp@example.test' },
    });
    expect(result.body.result?.isError, JSON.stringify(result.body)).not.toBe(
      true,
    );
    const customers = await ObjectRegistry.getCollection(CUSTOMER, { db });
    expect(
      (await customers.list({ displayLabel: true })).map(
        (m) => m.toJSON().displayLabel,
      ),
    ).toContain('MCP Member');
  });

  it('MCP createType follows the effective app base and rejects gated or unrelated create targets before writes', async () => {
    const offered = (await mcp()).body.result.tools;
    expect(offered.map((entry: { name: string }) => entry.name)).toContain(
      'profile_create',
    );
    const profiles = await ObjectRegistry.getCollection(PROFILE, { db });
    const before = await profiles.count();
    const created = await mcp('tools/call', {
      name: 'profile_create',
      arguments: {
        createType: '@fixture/host:Profile',
        name: 'MCP Profile',
        typeId: profileTypeId,
      },
    });
    expect(created.body.result?.isError, JSON.stringify(created.body)).not.toBe(
      true,
    );
    const rows = await profiles.list({ where: { name: 'MCP Profile' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].constructor).toBe(Profile);
    const row = (
      await db.query('SELECT _meta_type FROM profiles WHERE id = ?', rows[0].id)
    ).rows[0];
    expect(row._meta_type).toBe('@fixture/host:Profile');
    expect(await profiles.count()).toBe(before + 1);
    for (const createType of ['@happyvertical/smrt-profiles:Bot', MEMO]) {
      const refused = await mcp('tools/call', {
        name: 'profile_create',
        arguments: {
          createType,
          name: 'Must not be saved',
          typeId: profileTypeId,
        },
      });
      expect(
        refused.body.result?.isError ?? !!refused.body.error,
        JSON.stringify(refused.body),
      ).toBe(true);
      expect(await profiles.count()).toBe(before + 1);
    }
  });

  it('enables a recipe through an assistant extra tool and exposes its section, REST and MCP without rebuilding', async () => {
    let round = 0;
    response = () =>
      ++round === 1
        ? tool('recipes.enable', { id: 'host.memos', expectedRevision: 0 })
        : text();
    const seen = await turn(await thread(), 'Enable memos');
    expect(
      seen.some((e) => e.type === 'error'),
      JSON.stringify(errors),
    ).toBe(false);
    expect((await host.cookbookApp(tenantId)).cookbook.recipes).toContain(
      'host.memos',
    );
    const rest = new APIGenerator(
      { basePath: '/api', authMiddleware: () => async (req) => req },
      { db, tenantId },
    ).generateHandler();
    expect(
      (await request(event('/api/host_memos'), (e) => rest(e.request))).status,
    ).toBe(200);
    expect(
      (await mcp()).body.result.tools.some((t: { name: string }) =>
        t.name.includes('hostmemo'),
      ),
    ).toBe(true);
  });

  it('holds a delete then executes once after the owner decides; repeat cannot execute', async () => {
    const state = await createCookbookHostState(db, catalog, {
      ...cookbook,
      recipes: ['host.customers', 'host.memos'],
    });
    await state.refresh(tenantId);
    const before = state.engineFor({ tenantId })!.state();
    const next = structuredClone(before);
    next.cookbook.recipes.push('host.memos');
    next.revision++;
    await state.commit({
      context: { tenantId, userId: owner.id, surface: 'assistant' },
      before,
      after: next,
      audit: {
        context: { tenantId, userId: owner.id, surface: 'assistant' },
        tool: 'recipes.enable',
        outcome: 'changed',
        summary: 'Enabled memos',
      },
    });
    const memos = await ObjectRegistry.getCollection(MEMO, { db });
    const memo = await memos.create({ title: 'Disposable' });
    await memo.save();
    let round = 0;
    response = () =>
      ++round === 1
        ? tool('host_memos-delete', { id: memo.id, approved: true })
        : text();
    const seen = await turn(await thread(), 'Delete this memo');
    const hold = seen.find((e) => e.type === 'approval_needed');
    expect(hold, JSON.stringify({ seen, errors })).toBeTruthy();
    expect(await memos.get(memo.id!)).not.toBeNull();
    const approvalId = (hold!.approval as { id: string }).id;
    const first = await chat(`approvals/${approvalId}/decide`, {
      approve: true,
    });
    expect(first.status, JSON.stringify(await first.clone().json())).toBe(200);
    expect(await memos.get(memo.id!)).toBeNull();
    expect(
      (await chat(`approvals/${approvalId}/decide`, { approve: true })).status,
    ).toBe(409);
  });

  it('persists engine selection per user and rejects stale cookbook CAS after restart', async () => {
    const first = await createCookbookHostState(db, catalog, cookbook);
    await first.refresh(tenantId);
    await first.select(tenantId, owner.id, 'codex');
    const second = await createCookbookHostState(db, catalog, cookbook);
    expect(await second.engine(tenantId, owner.id)).toBe('codex');
    expect(await second.engine(tenantId, 'other-user')).toBeNull();
    const before = first.engineFor({ tenantId })!.state();
    const after = structuredClone(before);
    after.revision++;
    const change = {
      context: { tenantId, userId: owner.id, surface: 'assistant' as const },
      before,
      after,
      audit: {
        context: { tenantId, userId: owner.id, surface: 'assistant' as const },
        tool: 'recipes.configure' as const,
        outcome: 'changed' as const,
        summary: 'Saved',
      },
    };
    await first.commit(change);
    await expect(second.commit(change)).rejects.toThrow(/changed/);
    await second.refresh(tenantId);
    expect(second.engineFor({ tenantId })!.state().revision).toBe(
      after.revision,
    );
    const custom = '@fixture/history:PendingList';
    const bootIds = await second.enabledModelUnion(async (tenant) => {
      expect(tenant).toBe(tenantId);
      return {
        ...cookbook,
        recipes: ['host.memos'],
        features: [custom, '@fixture/missing:Unknown'],
        models: {
          version: 1,
          packageName: '@fixture/history',
          fields: {},
          lists: {
            ['PendingList']: {
              label: 'Pending list',
              icon: 'layers',
              displayField: 'name',
              fields: { name: { type: 'text' } },
            },
          },
        },
      };
    });
    expect(bootIds).toContain(MEMO);
    expect(bootIds).not.toContain(CUSTOMER); // Journal supersedes the older checkpoint.
    expect(bootIds).not.toContain(custom); // Only declared custom lists leave the fixed graph.
    expect(bootIds).toContain('@fixture/missing:Unknown');
  });
});
function json(value: unknown) {
  return Response.json(value);
}

describe('onboarding over real cookbook tools and owner ledger', () => {
  it('previews Fresh, creates a durable hold, applies only after an owner decision, then resumes done', async () => {
    const read = async () => {
      const r = await request(event('/api/onboarding'), host.onboarding);
      expect(r.status).toBe(200);
      return r.json();
    };
    let progress = await read();
    const change = async (action: string, extra = {}) => {
      const r = await request(
        event('/api/onboarding', 'POST', {
          action,
          revision: progress.revision,
          ...extra,
        }),
        host.onboarding,
      );
      expect(r.status).toBe(200);
      progress = await r.json();
    };
    await change('welcome');
    await change('skip');
    expect(progress.templates.map((t: { id: string }) => t.id)).toContain(
      'fresh',
    );
    await change('preview', { id: 'fresh' });
    expect(progress.preview.after).toEqual([]);
    await change('apply');
    expect(progress.approval.status).toBe('pending');
    expect((await host.cookbookApp(tenantId)).cookbook.recipes).toEqual([
      'host.customers',
    ]);
    const runtime = host.runtime;
    host.dispose();
    host = createCookbookHost({
      runtime,
      onboarding: true,
      app: { cookbook, catalog },
    });
    await host.init();
    expect((await read()).approvalId).toBe(progress.approvalId);
    const decision = await chat(`approvals/${progress.approvalId}/decide`, {
      approve: true,
    });
    expect(decision.status).toBe(200);
    progress = await read();
    expect(progress.completed).toBe(true);
    expect(progress.step).toBe('done');
    expect((await host.cookbookApp(tenantId)).cookbook.recipes).toEqual([]);
    const rest = new APIGenerator(
      { basePath: '/api', authMiddleware: () => async (req) => req },
      { db, tenantId },
    ).generateHandler();
    expect(
      (await request(event('/api/customers'), (e) => rest(e.request))).status,
    ).toBe(404);
    expect(
      (await mcp()).body.result.tools.some((t: { name: string }) =>
        /customer/.test(t.name),
      ),
    ).toBe(false);
    const loaded = await host.load(event('/'));
    expect(loaded.assistantIntroduction).toMatchObject({
      configured: false,
      lists: [],
    });
    expect(loaded.enabledModels).not.toContain(CUSTOMER);
  });
  it('onboarding template approval enables the effective app subclass, STI create and linked reference labels', async () => {
    const runtime = host.runtime;
    host.dispose();
    host = createCookbookHost({
      runtime,
      onboarding: true,
      app: {
        cookbook: { ...cookbook, recipes: [] },
        catalog: {
          ...catalog,
          cookbooks: [
            {
              id: 'customers-template',
              name: 'Customer business',
              document: cookbook,
            },
          ],
        },
      },
    });
    await host.init();
    let progress = await (
      await request(event('/api/onboarding'), host.onboarding)
    ).json();
    const advance = async (action: string, extra = {}) => {
      const r = await request(
        event('/api/onboarding', 'POST', {
          action,
          revision: progress.revision,
          ...extra,
        }),
        host.onboarding,
      );
      expect(r.status).toBe(200);
      progress = await r.json();
    };
    await advance('welcome');
    await advance('skip');
    await advance('preview', { id: 'customers-template' });
    expect(progress.preview.after).toContain('Customers');
    await advance('apply');
    expect(progress.approval.status).toBe('pending');
    expect(
      (await chat(`approvals/${progress.approvalId}/decide`, { approve: true }))
        .status,
    ).toBe(200);
    const profiles = await ObjectRegistry.getCollection(PROFILE, { db });
    const before = await profiles.count();
    const made = await mcp('tools/call', {
      name: 'profile_create',
      arguments: {
        createType: '@fixture/host:Profile',
        name: 'Onboarded Ada',
        typeId: profileTypeId,
      },
    });
    expect(made.body.result?.isError).not.toBe(true);
    const rows = await profiles.list({ where: { name: 'Onboarded Ada' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].constructor).toBe(Profile);
    expect(
      (
        await mcp('tools/call', {
          name: 'profile_create',
          arguments: {
            createType: '@happyvertical/smrt-profiles:Bot',
            name: 'Gated Bot',
            typeId: profileTypeId,
          },
        })
      ).body.result?.isError,
    ).toBe(true);
    expect(await profiles.count()).toBe(before + 1);
    const rest = new APIGenerator(
      { basePath: '/api', authMiddleware: () => async (req) => req },
      { db, tenantId },
    ).generateHandler();
    // Customer deliberately publishes read-only MCP; screens author through REST.
    const customer = await request(
      event('/api/customers', 'POST', { profileId: rows[0].id }),
      (e) => rest(e.request),
    );
    expect(customer.status).toBe(201);
    const referencePage = await request(event('/api/customers'), (e) =>
      rest(e.request),
    );
    expect(referencePage.status).toBe(200);
    expect(JSON.stringify(await referencePage.json())).toContain(
      'Onboarded Ada',
    );
    const linked = await (
      await ObjectRegistry.getCollection(CUSTOMER, { db })
    ).list({ displayLabel: true });
    expect(linked.map((row) => row.toJSON())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ displayLabel: 'Onboarded Ada' }),
      ]),
    );
    const loaded = await host.load(event('/'));
    expect(loaded.enabledModels).toContain('@fixture/host:Profile');
    expect(loaded.enabledModels).not.toContain(PROFILE);
  });
  it('refuses a template write outside the session ceiling even when the live owner role grants it', async () => {
    permissions = permissions.filter((p) => p !== 'cookbook.apply');
    let progress = await (
      await request(event('/api/onboarding'), host.onboarding)
    ).json();
    for (const action of ['welcome', 'skip']) {
      const r = await request(
        event('/api/onboarding', 'POST', {
          action,
          revision: progress.revision,
        }),
        host.onboarding,
      );
      expect(r.status).toBe(200);
      progress = await r.json();
    }
    const r = await request(
      event('/api/onboarding', 'POST', {
        action: 'preview',
        id: 'fresh',
        revision: progress.revision,
      }),
      host.onboarding,
    );
    expect(r.status).toBe(403);
    expect((await host.cookbookApp(tenantId)).cookbook.recipes).toEqual([
      'host.customers',
    ]);
  });
});
