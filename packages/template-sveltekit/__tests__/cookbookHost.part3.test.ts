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
import {
  type AssistantTurnEvent,
  readAssistantTurnStream,
} from '@happyvertical/smrt-chat/assistant-turn';
import { Customer } from '@happyvertical/smrt-commerce';
import { getChangesSince, ObjectRegistry } from '@happyvertical/smrt-core';
import { getCookbookToolService } from '@happyvertical/smrt-core/cookbook/tools';
import { APIGenerator } from '@happyvertical/smrt-core/generators/rest';
import {
  getTestDatabase,
  snapshotObjectRegistryState,
} from '@happyvertical/smrt-core/testing';
import { createAgentCliService } from '@happyvertical/smrt-inference/server';
import { ProfileTypeCollection } from '@happyvertical/smrt-profiles';
import { buildCookbookShell } from '@happyvertical/smrt-svelte/cookbook/server';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
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
import { testHomeEnvironment } from '../../vitest/src/test-home.js';
import { createCookbookHost, loadCookbookModelPage } from '../host/server.js';
import { createCookbookHostState } from '../host/state.js';
import { checkpointFault } from './support/cookbookHostFault.js';
import {
  CUSTOMER,
  catalog,
  cookbook,
  HostMemo,
  json,
  MEMO,
  PROFILE,
  Profile,
  text,
  tool,
} from './support/cookbookHostFixtures.js';

vi.mock('@happyvertical/smrt-workflows', async (importOriginal) =>
  (await import('./support/cookbookHostFault.js')).wrapWorkflows(
    await importOriginal<typeof import('@happyvertical/smrt-workflows')>(),
  ),
);

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
let cli: ReturnType<typeof createAgentCliService>;
let restoreRegistry: (() => void) | undefined;
const activeTurns = new Map<AbortController, Promise<unknown>>();
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
    params: { path: url.pathname.replace('/api/assistant/', '') },
    locals: authenticated
      ? {
          user: owner,
          tenantId,
          permissions,
          sessionId: 'verified-owner-session',
        }
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
async function turn(
  id: string,
  content: string,
  onEvent?: (event: AssistantTurnEvent) => void,
) {
  const controller = new AbortController();
  const pending = (async () => {
    const e = event(`/api/assistant/threads/${id}/messages`, 'POST', {
      content,
      clientRequestId: randomUUID(),
    });
    e.request = new Request(e.request, { signal: controller.signal });
    const r = await request(e, host.assistant.handle);
    expect(r.status, JSON.stringify(errors)).toBe(200);
    const events: Array<Record<string, unknown>> = [];
    try {
      await readAssistantTurnStream(r, (e) => {
        const current = e as unknown as Record<string, unknown>;
        events.push(current);
        onEvent?.(e);
      });
    } catch (error) {
      throw new Error(
        `${String(error)}; fixture errors: ${JSON.stringify(errors)}`,
      );
    }
    return events;
  })();
  activeTurns.set(controller, pending);
  try {
    return await pending;
  } finally {
    activeTurns.delete(controller);
  }
}
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

beforeEach(async ({ task }) => {
  restoreRegistry = snapshotObjectRegistryState();
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
  // Both fixtures accept the secured invocation and exercise actual app MCP.
  // Claude has no built-ins; Codex enables the required code host with native
  // sandbox containment. Inference separately tests incidental builtin items.
  const fixture = stub.replace(
    '#!/usr/bin/env node',
    `#!${process.execPath}\nObject.assign(process.env, ${JSON.stringify(Object.fromEntries([['SMRT_FORBIDDEN_STATE_BASES', process.env.SMRT_FORBIDDEN_STATE_BASES]]))});\nif (process.argv.includes('--version')) { console.log('1.2.3'); process.exit(0); }\nif (process.argv.slice(2).join(' ') === 'auth status') { console.log('{"loggedIn":true}'); process.exit(0); }\nif (process.argv.slice(2).join(' ') === 'login status') { console.log('Logged in using ChatGPT'); process.exit(0); }`,
  );
  for (const binary of ['claude', 'codex'])
    await writeFile(join(bin, binary), fixture, { mode: 0o700 });
  cli = createAgentCliService({
    env: Object.fromEntries([
      ...Object.entries(testHomeEnvironment()),
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
  db = await getTestDatabase(
    task.name.includes('simulated worker death')
      ? { type: 'sqlite', url: join(stateDirectory, 'crash.sqlite') }
      : {},
  );
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
  // Abort and settle streamed turns before closing their database or restoring
  // the process-wide registry used by this one-host-per-process fixture.
  for (const controller of activeTurns.keys()) controller.abort();
  await Promise.allSettled(activeTurns.values());
  checkpointFault.errors.length = 0;
  checkpointFault.afterCheck = undefined;
  await host?.shutdown();
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
  restoreRegistry?.();
  restoreRegistry = undefined;
});

describe('local cookbook host composition (SQLite, fake model, no providers)', () => {
  beforeEach(async () => {
    // These scenarios model the ordinary daily app; the separate onboarding
    // suite retains fresh progress. Seed only the fixture's owner progress.
    await request(event('/api/onboarding'), host.onboarding);
    await db.query(
      `UPDATE _smrt_cookbook_onboarding SET state = ? WHERE tenant_id = ? AND user_id = ?`,
      JSON.stringify({
        step: 'done',
        completed: true,
        rerunning: false,
        selected: null,
        approvalId: null,
        preview: null,
      }),
      tenantId,
      owner.id,
    );
  });
  it('wraps enabled colliding model aliases as valid workflows and keeps discovery gated', async () => {
    const initial = await mcp();
    expect(initial.status).toBe(200);
    const enableName = initial.body.result.tools.find(
      (tool: { name: string }) => tool.name.endsWith('recipes_enable'),
    )?.name;
    expect(enableName).toBeTruthy();
    const enabled = await mcp('tools/call', {
      name: enableName,
      arguments: { id: 'host.memos', expectedRevision: 0 },
    });
    expect(JSON.parse(enabled.body.result.content[0].text).status).toBe('ok');
    const listing = await mcp();
    expect(listing.status).toBe(200);
    const collisions = listing.body.result.tools.filter(
      (tool: { description: string }) =>
        tool.description.includes('CatalogCollision'),
    );
    expect(collisions).toHaveLength(2);
    expect(
      new Set(collisions.map((tool: { name: string }) => tool.name)).size,
    ).toBe(2);
    expect(
      collisions.every((tool: { name: string }) =>
        /^[a-z][a-z0-9_]{0,63}$/.test(tool.name),
      ),
    ).toBe(true);
    expect(
      listing.body.result.tools.some(
        (tool: { name: string }) => tool.name === 'profile_create',
      ),
    ).toBe(true);
  });
  it('keeps batched discovery and invocation permissions aligned for a partially granted owner', async () => {
    const before = (await mcp()).body.result.tools.map(
      (tool: { name: string }) => tool.name,
    );
    expect(before).toContain('recipes_search');
    expect(before).toContain('recipes_describe');
    const service = getCookbookToolService()!;
    const context = { surface: 'mcp' as const, tenantId, userId: owner.id };
    const offered = (await service.assistantTools(context)).map(
      (tool) => tool.slug,
    );
    expect(offered).toContain('recipes.search');
    expect(offered).toContain('recipes.describe');
    const permission = await (
      await PermissionCollection.create({ db })
    ).findBySlug('recipes.search');
    const role = await (
      await RoleCollection.create({ db })
    ).findSystemRoleBySlug('owner');
    const grants = await (await RolePermissionCollection.create({ db })).list({
      where: { roleId: role!.id, permissionId: permission!.id },
    });
    expect(grants).toHaveLength(1);
    await grants[0].delete();
    expect(
      (await mcp()).body.result.tools.map(
        (tool: { name: string }) => tool.name,
      ),
    ).toEqual(before.filter((name: string) => name !== 'recipes_search'));
    // Check the host's batch callback without the MCP scope filter masking it.
    expect(
      (await service.assistantTools(context)).map((tool) => tool.slug),
    ).toEqual(offered.filter((slug) => slug !== 'recipes.search'));
    await expect(
      service.invoke('recipes.search', { query: 'memos' }, context),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      service.invoke('recipes.describe', { id: 'host.memos' }, context),
    ).resolves.toMatchObject({ status: 'ok' });
  });

  it.each([
    ['app_describe', {}],
    ['app_history', {}],
    ['cookbook_list_templates', {}],
    ['recipes_search', { query: 'memos' }],
  ])('returns the declared structured result for %s, as real CLI clients require', async (name, args) => {
    const runtime = host.runtime;
    host.dispose();
    await host.shutdown();
    host.dispose();
    host = createCookbookHost({
      runtime,
      packageName: '@fixture/host-app',
      app: { cookbook, catalog },
    });
    await host.init();
    await request(event('/'), async (e) => json(await host.load(e)));
    // App initialization seeds workflow permissions after the first snapshot.
    permissions = [
      ...(
        await (
          await PermissionResolver.create({ db })
        ).resolvePermissions(owner.id, tenantId)
      ).permissions,
    ];
    const result = await mcp('tools/call', { name, arguments: args });
    expect(result.status).toBe(200);
    expect(result.body.error).toBeUndefined();
    expect(result.body.result.isError).not.toBe(true);
    expect(result.body.result.structuredContent).toEqual(
      JSON.parse(result.body.result.content[0].text),
    );
    expect(result.body.result.structuredContent).toEqual(
      expect.objectContaining({ status: expect.any(String) }),
    );
  });

  it.each([
    ['claude-code', true],
    ['codex', true],
    ['claude-code', false],
    ['codex', false],
  ] as const)('runs %s (removal approval %s) through the real host MCP route with short-lived scoped credentials and no API fallback', async (engine, removalApproval) => {
    const state = await createCookbookHostState(db, catalog, cookbook);
    await state.refresh(tenantId);
    const before = state.engineFor({ tenantId })!.state();
    const after = structuredClone(before);
    after.revision++;
    after.cookbook.recipes.push('host.memos');
    after.cookbook.layout = {
      version: 1,
      items: {
        'item:commerce:Customer': { label: 'Members', singularLabel: 'member' },
      },
    };
    await state.commit({
      context: { surface: 'assistant', tenantId, userId: owner.id },
      before,
      after,
      audit: {
        context: { surface: 'assistant', tenantId, userId: owner.id },
        tool: 'recipes.enable',
        outcome: 'changed',
        summary: 'Enable CLI fixture',
      },
    });
    const seenCatalogs: Array<
      Array<{
        name: string;
        inputSchema: { properties: Record<string, unknown> };
      }>
    > = [];
    let beforeMcpResponse: (() => Promise<void>) | undefined;
    let beforeMcpCall: (() => Promise<void>) | undefined;
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
        const scoped = await mcp(
          'tools/list',
          undefined,
          incoming.headers.authorization!.slice(7),
        );
        seenCatalogs.push(scoped.body.result.tools);
        await beforeMcpCall?.();
        const result = await request(e, host.mcp);
        await beforeMcpResponse?.();
        outgoing.writeHead(result.status, Object.fromEntries(result.headers));
        outgoing.end(await result.text());
      } catch {
        outgoing.writeHead(500);
        outgoing.end();
      }
    });
    await new Promise<void>((resolve) => http!.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    const connection = await (
      await request(event('/api/connect-ai'), host.connectAi.GET)
    ).json();
    expect(
      connection.tools.find((tool: { tool: string }) => tool.tool === engine),
    ).toMatchObject({
      installed: true,
      signedIn: true,
      ready: true,
    });
    const selection = await request(
      event('/api/connect-ai', 'POST', { action: 'select', engine }),
      host.connectAi.POST,
    );
    expect(selection.status).toBe(200);
    await request(event('/settings/inference'), async (e) => {
      const state = await host.assistantSettings.read(e);
      expect(
        (
          await host.assistantSettings.write(e, {
            settings: {
              requireRemovalApproval: removalApproval,
              ...(!removalApproval ? { protectLocalCli: false } : {}),
            },
            revision: state.revision,
            confirmUnprotectedCli: !removalApproval,
          })
        ).ok,
      ).toBe(true);
      return new Response();
    });

    expect((await host.load(event('/'))).assistantIntroduction).toMatchObject({
      configured: true,
      lists: ['Members', 'Memos'],
    });
    const listing = await mcp();
    const name = listing.body.result.tools.find((t: { name: string }) =>
      /customer_list$/.test(t.name),
    )?.name;
    expect(name).toBeTruthy();
    response = () => {
      throw new Error('An API fallback is forbidden');
    };
    const seen = await turn(await thread(), `tool members_read {}`);
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
    // API-only tools are not executable through this generated-MCP bridge.
    expect(issued[0].scopes).not.toContain('customers.delete');
    expect(issued[0].scopes.length).toBeLessThanOrEqual(64);
    expect(issued[0].scopes).toContain('recipes.enable');
    expect(revoked).toEqual([issued[0].holder]);
    expect(tokens.size).toBe(0);
    expect(JSON.stringify(seen).includes(issued[0].token)).toBe(false);

    const liveTools = seenCatalogs[0];
    expect(liveTools.some((t) => /profile/.test(t.name))).toBe(false);
    const create = liveTools.find((t) => /^members_create$/.test(t.name))!;
    expect(create).toHaveProperty(
      'description',
      expect.stringContaining('Members'),
    );
    expect(Object.keys(create.inputSchema.properties)).toEqual(
      expect.arrayContaining(['name', 'email', 'phone']),
    );
    expect(
      liveTools.some((t) => /(?:customer|members)_delete$/.test(t.name)),
    ).toBe(false);
    const introduction = await request(event('/'), async (e) =>
      json(await host.load(e)),
    );
    expect(
      (await introduction.json()).assistantIntroduction.actions,
    ).not.toContain('delete');
    if (removalApproval) {
      const made = await turn(
        await thread(),
        `tool ${create.name} ${JSON.stringify({ name: 'Test Person', email: '', phone: '' })}`,
      );
      expect(
        made.some((e) => e.type === 'error'),
        JSON.stringify(made),
      ).toBe(false);
      expect(JSON.stringify(made)).toContain('Completed this action');
      await withTenant({ tenantId }, async () => {
        const customers = await ObjectRegistry.getCollection(CUSTOMER, { db });
        const members = await customers.list({ displayLabel: true });
        expect(members.map((member) => member.toJSON().displayLabel)).toContain(
          'Test Person',
        );
      });
    }

    const memos = await ObjectRegistry.getCollection(MEMO, { db });
    let memo = await withTenant({ tenantId }, async () => {
      const record = await memos.create({ title: 'CLI held delete' });
      await record.save();
      return record;
    });
    const deleteName = liveTools.find((t) =>
      /^memos_delete$/.test(t.name),
    )!.name;
    if (!removalApproval) {
      const deleted = vi.spyOn(HostMemo.prototype, 'delete');
      const events = await turn(
        await thread(),
        `tool ${deleteName} ${JSON.stringify({ id: memo.id })}`,
      );
      expect(
        events.some((e) => e.type === 'approval_needed' || e.type === 'error'),
      ).toBe(false);
      expect(deleted).toHaveBeenCalledTimes(1);
      expect(
        await withTenant({ tenantId }, () => memos.get(memo.id!)),
      ).toBeFalsy();
      const changes = await getChangesSince(db, {
        since: 0,
        tables: ['host_memos'],
        tenantId,
      });
      expect(changes.changes).toContainEqual(
        expect.objectContaining({ operation: 'delete', rowId: memo.id }),
      );

      const next = await withTenant({ tenantId }, async () => {
        const row = await memos.create({ title: 'Outside client still held' });
        await row.save();
        return row;
      });
      const outsideList = await mcp();
      expect(
        outsideList.body.result.tools.some((t: { name: string }) =>
          /preference|assistant_settings|assistant_safety/i.test(t.name),
        ),
      ).toBe(false);
      const outsideName = outsideList.body.result.tools.find(
        (t: { name: string }) => /memo.*delete$/i.test(t.name),
      )?.name;
      expect(outsideName).toBeTruthy();
      const outside = await mcp('tools/call', {
        name: outsideName,
        arguments: { id: next.id },
      });
      expect(JSON.stringify(outside.body)).toContain('approval');
      expect(
        await withTenant({ tenantId }, () => memos.get(next.id!)),
      ).toBeTruthy();
      expect(deleted).toHaveBeenCalledTimes(1);
      const forbidden = await mcp('tools/call', {
        name: 'assistant_settings_update',
        arguments: { requireRemovalApproval: true, protectLocalCli: true },
      });
      expect(
        forbidden.body.error ?? forbidden.body.result?.isError,
      ).toBeTruthy();
      await request(event('/settings/inference'), async (e) => {
        expect((await host.assistantSettings.read(e)).settings).toEqual({
          requireRemovalApproval: false,
          protectLocalCli: false,
        });
        return new Response();
      });
      const noSession = event('/settings/inference', 'POST', {});
      delete (noSession.locals as { sessionId?: string }).sessionId;
      await expect(
        request(noSession, async (e) =>
          json(
            await host.assistantSettings.write(e, {
              settings: {},
              revision: null,
            }),
          ),
        ),
      ).rejects.toMatchObject({ status: 403 });
      deleted.mockRestore();
      // A running turn must not lose its initial hold policy if the owner
      // disables approval while the CLI is approaching the MCP boundary.
      await request(event('/settings/inference'), async (e) => {
        const saved = await host.assistantSettings.read(e);
        await host.assistantSettings.write(e, {
          settings: { ...saved.settings, requireRemovalApproval: true },
          revision: saved.revision,
        });
        return new Response();
      });
      memo = await withTenant({ tenantId }, async () => {
        const record = await memos.create({
          title: 'In-flight removal policy',
        });
        await record.save();
        return record;
      });
      beforeMcpCall = async () => {
        beforeMcpCall = undefined;
        await request(event('/settings/inference'), async (e) => {
          const saved = await host.assistantSettings.read(e);
          await host.assistantSettings.write(e, {
            settings: { ...saved.settings, requireRemovalApproval: false },
            revision: saved.revision,
          });
          return new Response();
        });
      };
    }
    const threadId = await thread();
    let approvalReady!: (id: string) => void;
    const approval = new Promise<string>((resolve) => {
      approvalReady = resolve;
    });
    const running = turn(
      threadId,
      `tool ${deleteName} ${JSON.stringify({ id: memo.id })}`,
      (event) => {
        if (event.type === 'approval_needed') approvalReady(event.approval.id);
      },
    ).then(
      (events) => ({ events, error: null }),
      (error: unknown) => ({ events: null, error }),
    );
    // Native process startup is asynchronous. Await the actual hold event,
    // rather than assuming the process reaches MCP within vi.waitFor's 1s.
    const approvalId = await Promise.race([
      approval,
      running.then((result) => {
        throw (
          result.error ?? new Error('CLI turn ended before its approval hold')
        );
      }),
    ]);
    const authority = new OwnerApprovalAuthority(
      await createSqliteOwnerApprovalStore(db),
      async () => true,
    );
    const saved = await authority.get(tenantId, approvalId);
    expect(saved).toMatchObject({
      tool: 'host_memos.delete',
      status: 'pending',
      args: { id: memo.id },
      context: { threadId },
      continuation: {
        executor: 'model',
        consumption: 'continuation',
        principal: {
          id: owner.id,
          tenantId,
          allowedTools: ['host_memos.delete'],
        },
      },
    });
    expect(
      await withTenant({ tenantId }, () => memos.get(memo.id!)),
    ).toBeTruthy();
    const foreign = event(
      `/api/assistant/approvals/${approvalId}/decide`,
      'POST',
      { approve: true },
    );
    (foreign.locals as { user: typeof owner }).user = {
      ...owner,
      id: randomUUID(),
    };
    expect((await request(foreign, host.assistant.handle)).status).toBe(403);
    const foreignTenant = event(
      `/api/assistant/approvals/${approvalId}/decide`,
      'POST',
      { approve: true },
    );
    (foreignTenant.locals as { tenantId: string }).tenantId = randomUUID();
    expect((await request(foreignTenant, host.assistant.handle)).status).toBe(
      403,
    );
    const deleted = vi.spyOn(HostMemo.prototype, 'delete');
    expect(
      (await chat(`approvals/${approvalId}/decide`, { approve: true })).status,
    ).toBe(200);
    const result = await running;
    expect(result.error).toBeNull();
    const completed = result.events!;
    expect(
      completed.some((e) => e.type === 'error'),
      JSON.stringify(completed),
    ).toBe(false);
    expect((await authority.get(tenantId, approvalId))?.status).toBe(
      'succeeded',
    );
    expect(
      await withTenant({ tenantId }, () => memos.get(memo.id!)),
    ).toBeFalsy();
    expect(deleted).toHaveBeenCalledTimes(1);
    expect(
      (await chat(`approvals/${approvalId}/decide`, { approve: true })).status,
    ).toBe(409);
    expect(deleted).toHaveBeenCalledTimes(1);
    if (!removalApproval) return;
    const blockedMemo = await withTenant({ tenantId }, async () => {
      const record = await memos.create({ title: 'Revoked CLI delete' });
      await record.save();
      return record;
    });
    let blockedApprovalReady!: (id: string) => void;
    const blockedApproval = new Promise<string>((resolve) => {
      blockedApprovalReady = resolve;
    });
    let releaseResponse!: () => void;
    const responseReleased = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    // Pause only the fake network response, after the real MCP route persisted
    // the hold. Revoke exposure before the CLI parses that held tool result.
    beforeMcpResponse = async () => {
      const records = await (await chat('approvals', undefined, 'GET')).json();
      const pending = records.approvals.find(
        (record: { tool: string; status: string }) =>
          record.tool === 'change' && record.status === 'pending',
      );
      if (!pending) throw new Error('MCP did not persist the expected hold');
      expect(await authority.get(tenantId, pending.id)).toMatchObject({
        tool: 'host_memos.delete',
        status: 'pending',
        args: { id: blockedMemo.id },
      });
      blockedApprovalReady(pending.id);
      await responseReleased;
    };
    const blockedTurn = turn(
      await thread(),
      `tool ${deleteName} ${JSON.stringify({ id: blockedMemo.id })}`,
    ).then(
      (events) => ({ events, error: null }),
      (error: unknown) => ({ events: null, error }),
    );
    let blockedId: string;
    try {
      blockedId = await Promise.race([
        blockedApproval,
        blockedTurn.then((result) => {
          throw (
            result.error ?? new Error('CLI turn ended before its approval hold')
          );
        }),
      ]);
      const preference = await (
        await request(event('/api/cookbook/prebuilt'), host.prebuilt)
      ).json();
      expect(
        (
          await request(
            event('/api/cookbook/prebuilt', 'POST', {
              enabled: false,
              revision: preference.revision,
            }),
            host.prebuilt,
          )
        ).status,
      ).toBe(200);
    } finally {
      beforeMcpResponse = undefined;
      releaseResponse();
    }
    const refused = await chat(`approvals/${blockedId}/decide`, {
      approve: true,
    });
    expect(refused.status).toBe(500);
    expect((await authority.get(tenantId, blockedId))?.status).toBe('failed');
    expect((await blockedTurn).error).toBeInstanceOf(Error);
    expect(
      await withTenant({ tenantId }, () => memos.get(blockedMemo.id!)),
    ).toBeTruthy();
    expect(deleted).toHaveBeenCalledTimes(1);
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
      new Set(listing.body.result.tools.map((t: { name: string }) => t.name))
        .size,
    ).toBe(listing.body.result.tools.length);
    expect(
      listing.body.result.tools.some((t: { name: string }) =>
        t.name.includes('catalogcollision'),
      ),
    ).toBe(false);
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
    await host.shutdown();
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
    await host.shutdown();
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
    await host.shutdown();
    host.dispose();
    host = createCookbookHost({
      runtime,
      app,
      packageName: '@fixture/host-prerequisites',
      assistant: {
        onError: (error) =>
          errors.push(error instanceof Error ? error.stack : String(error)),
      },
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
    await host.shutdown();
    host.dispose();
    host = createCookbookHost({
      runtime,
      app,
      packageName: '@fixture/host-prerequisites',
      assistant: {
        onError: (error) =>
          errors.push(error instanceof Error ? error.stack : String(error)),
      },
    });
    await host.init();
    const decision = await chat(`approvals/${pending.approvalId}/decide`, {
      approve: true,
    });
    expect(
      decision.status,
      `${await decision.clone().text()} ${JSON.stringify(errors)}`,
    ).toBe(200);
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
});
