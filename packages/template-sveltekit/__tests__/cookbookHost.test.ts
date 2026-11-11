import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { LOCAL_MCP_TOKEN_PRINCIPAL } from '@happyvertical/smrt-app-runtime';
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
import { Profile, ProfileTypeCollection } from '@happyvertical/smrt-profiles';
import { withTenant } from '@happyvertical/smrt-tenancy';
import type { Cookbook } from '@happyvertical/smrt-types';
import {
  MembershipCollection,
  MembershipStatus,
  PermissionResolver,
  RoleCollection,
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
import { createCookbookHost } from '../host/server.js';
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
  await readAssistantTurnStream(r, (e) => {
    events.push(e as unknown as Record<string, unknown>);
  });
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
  const r = await request(e, host.mcp);
  const raw = await r.text();
  if (r.status === 200) expect(raw, `MCP response ${r.status}`).not.toBe('');
  return { status: r.status, body: raw ? JSON.parse(raw) : null };
}

beforeEach(async () => {
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

  it('a stub assistant lists customers and creates a Customer linked to a Profile, never a Bot', async () => {
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
    expect(await customers.list({ where: { profileId } })).toHaveLength(1);
    const row = (
      await db.query('SELECT _meta_type FROM profiles WHERE id = ?', profileId)
    ).rows[0];
    expect(String(row._meta_type)).not.toContain('Bot');
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
  });
});
function json(value: unknown) {
  return Response.json(value);
}
