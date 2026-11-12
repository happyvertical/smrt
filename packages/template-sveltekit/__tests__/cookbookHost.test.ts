import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
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
import {
  field,
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { APIGenerator } from '@happyvertical/smrt-core/generators/rest';
import {
  getTestDatabase,
  snapshotObjectRegistryState,
} from '@happyvertical/smrt-core/testing';
import { createAgentCliService } from '@happyvertical/smrt-inference/server';
import {
  SmrtWorkerCollection,
  TaskRunner,
  unregisterLiveWorker,
} from '@happyvertical/smrt-jobs';
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
import { getDatabase } from '@happyvertical/sql';
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

const checkpointFault = vi.hoisted(() => ({
  errors: [] as string[],
  beforeSave: undefined as
    | undefined
    | ((
        state: import('@happyvertical/smrt-inference/server').DesignRunState,
      ) => Promise<void>),
}));
vi.mock('@happyvertical/smrt-inference/server', async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import('@happyvertical/smrt-inference/server')
    >();
  return {
    ...original,
    createDesignRunDriver: (
      options: Parameters<typeof original.createDesignRunDriver>[0],
    ) =>
      original.createDesignRunDriver({
        ...options,
        executePass: async (...args) => {
          try {
            return await options.executePass(...args);
          } catch (error) {
            checkpointFault.errors.push(String(error));
            throw error;
          }
        },
        passes: options.passes.map((pass) => ({
          ...pass,
          check: pass.check
            ? async (...args: Parameters<NonNullable<typeof pass.check>>) => {
                try {
                  return await pass.check!(...args);
                } catch (error) {
                  checkpointFault.errors.push(String(error));
                  throw error;
                }
              }
            : undefined,
        })),
      }),
    createDesignRunStore: (
      ...args: Parameters<typeof original.createDesignRunStore>
    ) => {
      const store = original.createDesignRunStore(...args);
      return {
        ...store,
        async save(
          state: import('@happyvertical/smrt-inference/server').DesignRunState,
          revision: number | null,
        ) {
          await checkpointFault.beforeSave?.(state);
          return store.save(state, revision);
        },
      };
    },
  };
});

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
const COLLISIONS = [
  '@fixture/collision-one:CatalogCollision',
  '@fixture/collision-two:CatalogCollision',
];
for (const [index, id] of COLLISIONS.entries()) {
  ObjectRegistry.register(class CatalogCollision extends SmrtObject {}, {
    packageName: id.split(':')[0],
    tableName: `host_collision_${index}`,
    collection: `host_collision_${index}`,
    api: { include: ['list', 'get'] },
    mcp: { include: ['list'] },
  });
}
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
      models: [MEMO, ...COLLISIONS],
      nav: [{ model: MEMO, label: 'Memos' }],
      requires: [],
    },
  ],
  models: [
    { id: CUSTOMER, name: 'Customer', packageId: 'commerce' },
    { id: PROFILE, name: 'Profile', packageId: 'profiles', exposed: true },
    { id: MEMO, name: 'HostMemo', packageId: 'host' },
    ...COLLISIONS.map((id) => ({
      id,
      name: 'CatalogCollision',
      packageId: id.split(':')[0],
    })),
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
  const cli = createAgentCliService({
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
  checkpointFault.beforeSave = undefined;
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
  it('serves the conventional favicon request from the shipped SVG without owner authorization', async () => {
    const response = await request(
      event('/favicon.ico', 'GET', undefined, false),
      async () => new Response(null, { status: 404 }),
    );
    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe('/favicon.svg');
    expect(response.headers.get('cache-control')).toContain('public');
  });
  it('stops the real task runner on adapter-node shutdown and detaches its listener', async () => {
    const stop = vi.spyOn(TaskRunner.prototype, 'stop');
    const before = process.listenerCount('sveltekit:shutdown');
    expect(before).toBeGreaterThan(0);
    (process as EventEmitter).emit('sveltekit:shutdown', 'SIGTERM');
    await host.shutdown();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop.mock.contexts[0]).toBeInstanceOf(TaskRunner);
    expect((stop.mock.contexts[0] as TaskRunner).isRunning()).toBe(false);
    expect(process.listenerCount('sveltekit:shutdown')).toBe(before - 1);
    await host.shutdown();
    expect(stop).toHaveBeenCalledTimes(1);
    await expect(host.init()).rejects.toThrow('shutting down');
    host.dispose();
    expect(process.listenerCount('sveltekit:shutdown')).toBe(before - 1);
  });

  it('drains a runner whose initialization overlaps adapter-node shutdown', async () => {
    const runtime = host.runtime;
    await host.shutdown();
    host.dispose();
    let reachedStart!: () => void;
    const reached = new Promise<void>((resolve) => {
      reachedStart = resolve;
    });
    let releaseStart!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const realStart = TaskRunner.prototype.start;
    const start = vi
      .spyOn(TaskRunner.prototype, 'start')
      .mockImplementationOnce(async function (this: TaskRunner) {
        reachedStart();
        await released;
        return realStart.call(this);
      });
    const stop = vi.spyOn(TaskRunner.prototype, 'stop');
    host = createCookbookHost({ runtime, app: { cookbook, catalog } });
    const initializing = host.init();
    let inFlightAccess: Promise<void> | undefined;
    try {
      await reached;
      (process as EventEmitter).emit('sveltekit:shutdown', 'SIGTERM');
      inFlightAccess = host.init();
    } finally {
      releaseStart();
    }
    await Promise.all([initializing, inFlightAccess]);
    await host.shutdown();
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop.mock.contexts[0]).toBeInstanceOf(TaskRunner);
    expect((stop.mock.contexts[0] as TaskRunner).isRunning()).toBe(false);
    host.dispose();
    expect(process.listenerCount('sveltekit:shutdown')).toBe(0);
  });

  it('does not initialize a new runner after adapter-node shutdown', async () => {
    const runtime = host.runtime;
    await host.shutdown();
    host.dispose();
    const start = vi.spyOn(TaskRunner.prototype, 'start');
    host = createCookbookHost({ runtime, app: { cookbook, catalog } });
    (process as EventEmitter).emit('sveltekit:shutdown', 'SIGTERM');
    await expect(host.init()).rejects.toThrow('shutting down');
    await host.shutdown();
    expect(start).not.toHaveBeenCalled();
  });

  it('cleans a partially-started runner after failed initialization on adapter-node shutdown', async () => {
    const runtime = host.runtime;
    await host.shutdown();
    host.dispose();
    const realStart = TaskRunner.prototype.start;
    vi.spyOn(TaskRunner.prototype, 'start').mockImplementationOnce(
      async function (this: TaskRunner) {
        await realStart.call(this);
        throw new Error('Fixture initialization failed after runner start');
      },
    );
    const stop = vi.spyOn(TaskRunner.prototype, 'stop');
    host = createCookbookHost({ runtime, app: { cookbook, catalog } });
    await expect(host.init()).rejects.toThrow(
      'Fixture initialization failed after runner start',
    );
    const exitCode = process.exitCode;
    (process as EventEmitter).emit('sveltekit:shutdown', 'SIGTERM');
    await expect(host.shutdown()).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop.mock.contexts[0]).toBeInstanceOf(TaskRunner);
    expect((stop.mock.contexts[0] as TaskRunner).isRunning()).toBe(false);
    expect(process.exitCode).toBe(exitCode);
  });

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
  async function directStructuralService() {
    // These legacy service/continuation cases explicitly exercise the owner's
    // supported opt-out. The default durable-escalation regression stays on.
    await request(event('/settings/inference'), async (e) => {
      const state = await host.workProfiles.read(e);
      const result = await host.workProfiles.write(e, {
        settings: {
          ...state.settings,
          assist: { ...state.settings.assist, autoEscalate: false },
        },
        revision: state.revision,
      });
      expect(result.ok).toBe(true);
      return new Response();
    });
  }
  async function durableDesignHost(preview = true) {
    const runtime = host.runtime;
    await host.shutdown();
    host.dispose();
    const calls = vi.fn(async (messages: unknown, options: unknown) =>
      response(messages as never, options as never),
    );
    host = createCookbookHost({
      runtime,
      packageName: '@fixture/host-app',
      app: { cookbook, catalog },
      assistant: { ai: { chat: calls } as never },
    });
    await host.init();
    await request(event('/'), async (e) => json(await host.load(e)));
    permissions = [
      ...(
        await (
          await PermissionResolver.create({ db })
        ).resolvePermissions(owner.id, tenantId)
      ).permissions,
    ];
    await request(event('/settings/inference'), async (e) => {
      const saved = await host.workProfiles.read(e);
      expect(
        (
          await host.workProfiles.write(e, {
            settings: {
              design: { previewBeforeApply: preview, budgets: { passes: 3 } },
            },
            revision: saved.revision,
          })
        ).ok,
      ).toBe(true);
      return new Response();
    });
    return calls;
  }
  async function designState(id: string) {
    return JSON.parse(
      String(
        (
          await db.query(
            'SELECT payload FROM _smrt_inference_design_runs WHERE id = ?',
            id,
          )
        ).rows[0].payload,
      ),
    );
  }

  it('resolves design and assist to the strongest ranked ChatGPT account model without choosing the first catalog entry', async () => {
    const runtime = host.runtime;
    await host.shutdown();
    host.dispose();
    host = createCookbookHost({
      runtime,
      app: { cookbook, catalog },
      chatgpt: {
        status: async () => ({ signedIn: true, signingIn: false }),
        models: async () => [
          { id: 'small', label: 'Small', intelligenceRank: 1 },
          { id: 'strong', label: 'Strong', intelligenceRank: 3 },
        ],
        defaultModel: async () => 'strong',
        clientOptions: vi.fn(),
        start: vi.fn(),
        signOut: vi.fn(),
      },
    });
    await request(event('/settings/inference'), async (e) => {
      const before = await host.workProfiles.read(e);
      expect(
        (
          await host.workProfiles.write(e, {
            settings: {
              design: { engine: 'chatgpt' },
              assist: { engine: 'chatgpt' },
            },
            revision: before.revision,
          })
        ).ok,
      ).toBe(true);
      const saved = await host.workProfiles.read(e);
      for (const name of ['design', 'assist'])
        expect(
          saved.resolved.find((profile) => profile.name === name),
        ).toMatchObject({ model: 'strong', unavailable: false });
      return new Response();
    });
  });
  it('loads owner quality overrides, rejects stale saves, and resets without exposing unavailable model failures', async () => {
    await request(event('/settings/inference'), async (e) => {
      const before = await host.workProfiles.read(e);
      expect(before.settings).toEqual({});
      expect(before.resolved.find((p) => p.name === 'assist')?.effort).toBe(
        'high',
      );
      const settings = {
        design: { engine: 'chatgpt' as const, budgets: { passes: 6 } },
      };
      expect(
        (
          await host.workProfiles.write(e, {
            settings,
            revision: before.revision,
          })
        ).ok,
      ).toBe(true);
      const saved = await host.workProfiles.read(e);
      expect(saved.settings).toEqual(settings);
      expect(saved.resolved.find((p) => p.name === 'design')?.unavailable).toBe(
        true,
      );
      expect(
        await host.workProfiles.write(e, { settings: {}, revision: null }),
      ).toEqual({ ok: false, reason: 'conflict' });
      expect((await host.workProfiles.reset(e, saved.revision)).ok).toBe(true);
      expect((await host.workProfiles.read(e)).settings).toEqual({});
      return new Response();
    });
  });

  it('admits a durable design proposal before a structural tool executes', async () => {
    await durableDesignHost();
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
    const id = await thread();
    response = (messages) =>
      messages.some((m) => m.content.includes('Design pass '))
        ? {
            content: JSON.stringify({
              summary: 'Enable the Memos recipe after review.',
              checks: ['Recipe exists'],
              ready: true,
              operations: [
                {
                  tool: 'recipes.enable',
                  args: { id: 'host.memos', expectedRevision: 0 },
                },
              ],
            }),
            finishReason: 'stop',
          }
        : tool('recipes.enable', { id: 'host.memos', expectedRevision: 0 });
    const events = await turn(id, 'Enable memos');
    const done = events.find((e) => e.type === 'done');
    expect(done?.runId).toBeTruthy();
    expect((await host.cookbookApp(tenantId)).cookbook.recipes).not.toContain(
      'host.memos',
    );
    await vi.waitFor(
      async () => {
        const response = await chat(
          `design-runs?threadId=${id}`,
          undefined,
          'GET',
        );
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.run.runId).toBe(done?.runId);
        expect(['done', 'waiting-approval']).toContain(body.run.status);
      },
      { timeout: 15000 },
    );
    expect((await host.cookbookApp(tenantId)).cookbook.recipes).not.toContain(
      'host.memos',
    );
  });

  it('admits a direct owner design request with concrete structural schemas and read-only model tools', async () => {
    const runtime = host.runtime;
    await host.shutdown();
    host.dispose();
    const calls: Array<{
      messages: Array<{ role: string; content: string }>;
      options: { tools?: Array<{ function: { name: string } }> };
    }> = [];
    host = createCookbookHost({
      runtime,
      packageName: '@fixture/host-app',
      app: { cookbook, catalog },
      assistant: {
        ai: {
          chat: async (messages: never, options: never) => {
            calls.push({ messages, options });
            return {
              content: JSON.stringify({
                summary: 'Add Birthday to Customers.',
                checks: ['Customers exists.'],
                ready: true,
                operations: [
                  {
                    tool: 'app.addField',
                    args: {
                      list: 'Customers',
                      label: 'Birthday',
                      kind: 'date',
                      expectedRevision: 0,
                    },
                  },
                ],
              }),
              finishReason: 'stop',
            };
          },
        } as never,
      },
    });
    await host.init();
    await request(event('/'), async (e) => json(await host.load(e)));
    permissions = [
      ...(
        await (
          await PermissionResolver.create({ db })
        ).resolvePermissions(owner.id, tenantId)
      ).permissions,
    ];
    await request(event('/settings/inference'), async (e) => {
      const saved = await host.workProfiles.read(e);
      expect(
        (
          await host.workProfiles.write(e, {
            settings: { design: { budgets: { passes: 3 } } },
            revision: saved.revision,
          })
        ).ok,
      ).toBe(true);
      return new Response();
    });
    const id = await thread();
    const admitted = await chat('design-runs', {
      threadId: id,
      content: 'Add a birthday field to Customers.',
    });
    expect(admitted.status).toBe(202);
    const runId = (await admitted.json()).run.runId;
    await vi.waitFor(
      async () => {
        const state = JSON.parse(
          String(
            (
              await db.query(
                'SELECT payload FROM _smrt_inference_design_runs WHERE id = ?',
                runId,
              )
            ).rows[0].payload,
          ),
        );
        expect(state.status).toBe('waiting-approval');
        expect(state.definition).toBe('cookbook-design/v3/3');
        expect(state.outputs[2].operations[0].tool).toBe('app.addField');
      },
      { timeout: 15000 },
    );
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(JSON.stringify(call.messages)).toContain('app.addField');
      expect(
        call.options.tools?.some(
          (tool) => tool.function.name === 'app_add_field',
        ),
      ).not.toBe(true);
    }
    const history = await mcp('tools/call', {
      name: 'app_history',
      arguments: {},
    });
    expect(history.body.result.structuredContent.changes).toEqual([]);
    const pending = await chat(`threads/${id}/approvals`, undefined, 'GET');
    expect(pending.status).toBe(200);
    const approvals = (await pending.json()).approvals;
    expect(approvals).toHaveLength(1);
    const before = await designState(runId);
    const decision = await chat(`approvals/${approvals[0].id}/decide`, {
      approve: true,
    });
    expect(decision.status).toBe(200);
    expect((await decision.json()).approval.status).toBe('succeeded');
    await vi.waitFor(
      async () => expect((await designState(runId)).status).toBe('done'),
      { timeout: 15000 },
    );
    const done = await designState(runId);
    expect(done.outputs).toEqual(before.outputs);
    expect(done.attempts).toEqual(before.attempts);
    expect(done.tokens).toBe(before.tokens);
    expect(calls).toHaveLength(3);
    const applied = await mcp('tools/call', {
      name: 'app_history',
      arguments: {},
    });
    expect(applied.body.result.structuredContent.changes).toHaveLength(1);
    expect(done.input.results).toHaveLength(1);
    const historyResponse = await request(event('/api/history'), host.history);
    expect(historyResponse.status).toBe(200);
    const visibleHistory = await historyResponse.json();
    expect(visibleHistory.entries).toEqual([
      {
        id: '1',
        action: expect.stringContaining('Birthday'),
        resourceType: 'App structure',
        resourceId: 'Revision 1',
        actorLabel: 'You',
      },
    ]);
    expect(JSON.stringify(visibleHistory)).not.toContain('before');
    expect(JSON.stringify(visibleHistory)).not.toContain('timestamp');
  });

  it('rejects forged direct design authority, foreign threads and cross-origin admission before any model call', async () => {
    const calls = vi.fn();
    response = calls;
    const id = await thread();
    for (const key of [
      'profile',
      'workProfile',
      'engine',
      'actionKey',
      'actionId',
      'runId',
      'designAction',
      'approvalId',
      'ownerId',
      'userId',
      'tenantId',
    ]) {
      expect(
        (
          await chat('design-runs', {
            threadId: id,
            content: 'Review Customers.',
            [key]: 'forged',
          })
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await chat('design-runs', {
          threadId: randomUUID(),
          content: 'Review Customers.',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await chat('design-runs', {
          threadId: id,
          content: 'x'.repeat(140_000),
        })
      ).status,
    ).toBe(413);
    const crossOrigin = event('/api/assistant/design-runs', 'POST', {
      threadId: id,
      content: 'Review Customers.',
    });
    crossOrigin.request.headers.set('origin', 'https://other.invalid');
    expect((await request(crossOrigin, host.assistant.handle)).status).toBe(
      403,
    );
    expect(
      (
        await request(
          event(
            '/api/assistant/design-runs',
            'POST',
            { threadId: id, content: 'Review Customers.' },
            false,
          ),
          host.assistant.handle,
        )
      ).status,
    ).toBe(403);
    expect(calls).not.toHaveBeenCalled();
    expect(
      (await db.query('SELECT id FROM _smrt_inference_design_runs')).rows,
    ).toHaveLength(0);
  });
  it('keeps structure history owner-scoped and permission-bound without leaking change documents', async () => {
    await durableDesignHost();
    const own = await request(event('/api/history'), host.history);
    expect(own.status).toBe(200);
    expect(await own.json()).toEqual({ revision: 0, entries: [] });
    expect(
      (
        await request(
          event('/api/history', 'GET', undefined, false),
          host.history,
        )
      ).status,
    ).toBe(403);
    const foreign = event('/api/history');
    (foreign.locals as { tenantId: string }).tenantId = randomUUID();
    expect((await request(foreign, host.history)).status).toBe(403);
    const withoutPermission = event('/api/history');
    (withoutPermission.locals as { permissions: string[] }).permissions = [];
    expect((await request(withoutPermission, host.history)).status).toBe(403);
    expect(
      (await request(event('/api/history', 'POST', {}), host.history)).status,
    ).toBe(405);
  });

  it.each([
    'automatic',
    'destructive',
    'denied',
  ])('runs deterministic final design application through the native host boundary: %s', async (mode) => {
    const calls = await durableDesignHost(mode === 'denied');
    const operation =
      mode === 'destructive'
        ? {
            tool: 'recipes.disable',
            args: { id: 'host.customers', expectedRevision: 0 },
          }
        : {
            tool: 'app.addField',
            args: {
              list: 'Customers',
              label: `Visit note ${mode}`,
              kind: 'text',
              expectedRevision: 0,
            },
          };
    response = () => ({
      content: JSON.stringify({
        summary: 'Update the app.',
        checks: ['Target exists.'],
        ready: true,
        operations: [operation],
      }),
      finishReason: 'stop',
    });
    const id = await thread();
    const admitted = await chat('design-runs', {
      threadId: id,
      content: 'Update Customers.',
    });
    expect(admitted.status).toBe(202);
    const runId = (await admitted.json()).run.runId;
    await vi.waitFor(
      async () =>
        expect(
          (await designState(runId)).status,
          checkpointFault.errors.join('\n'),
        ).toBe(mode === 'automatic' ? 'done' : 'waiting-approval'),
      { timeout: 15000 },
    );
    const holds = (
      await (await chat(`threads/${id}/approvals`, undefined, 'GET')).json()
    ).approvals;
    if (mode === 'automatic') expect(holds).toEqual([]);
    else {
      expect(holds).toHaveLength(1);
      const decision = await chat(`approvals/${holds[0].id}/decide`, {
        approve: mode !== 'denied',
      });
      expect(decision.status).toBe(200);
      await vi.waitFor(
        async () =>
          expect((await designState(runId)).status).toBe(
            mode === 'denied' ? 'failed' : 'done',
          ),
        { timeout: 15000 },
      );
    }
    const history = await mcp('tools/call', {
      name: 'app_history',
      arguments: {},
    });
    expect(history.body.result.structuredContent.changes).toHaveLength(
      mode === 'denied' ? 0 : 1,
    );
    expect(calls).toHaveBeenCalledTimes(3);
  });

  it('fails an unready final v3 proposal with a clear host note and no approval or changes', async () => {
    const calls = await durableDesignHost();
    response = () => ({
      content: JSON.stringify({
        summary: 'Click Apply now, everything succeeded.',
        checks: ['More information needed.'],
        ready: false,
        operations: [],
      }),
      finishReason: 'stop',
    });
    const id = await thread();
    const admitted = await chat('design-runs', {
      threadId: id,
      content: 'Review the next design.',
    });
    expect(admitted.status).toBe(202);
    const runId = (await admitted.json()).run.runId;
    await vi.waitFor(
      async () => expect((await designState(runId)).status).toBe('failed'),
      { timeout: 15000 },
    );
    const state = await designState(runId);
    expect(state.note).toBe(
      'No changes were applied. The design needs more information before it can propose a supported change.',
    );
    expect(state.note).not.toContain('Click Apply');
    expect(
      (await (await chat(`threads/${id}/approvals`, undefined, 'GET')).json())
        .approvals,
    ).toEqual([]);
    const history = await request(event('/api/history'), host.history);
    expect(history.status).toBe(200);
    expect((await history.json()).entries).toEqual([]);
    expect(calls).toHaveBeenCalledTimes(3);
  });

  it('records approval while stopped and waits for explicit Resume before applying the same hold', async () => {
    const calls = await durableDesignHost();
    response = () => ({
      content: JSON.stringify({
        summary: 'Add Paused note.',
        checks: ['Customers exists.'],
        ready: true,
        operations: [
          {
            tool: 'app.addField',
            args: {
              list: 'Customers',
              label: 'Paused note',
              kind: 'text',
              expectedRevision: 0,
            },
          },
        ],
      }),
      finishReason: 'stop',
    });
    const id = await thread();
    const admitted = await chat('design-runs', {
      threadId: id,
      content: 'Add Paused note.',
    });
    expect(admitted.status).toBe(202);
    const runId = (await admitted.json()).run.runId;
    await vi.waitFor(
      async () =>
        expect((await designState(runId)).status).toBe('waiting-approval'),
      { timeout: 15000 },
    );
    const holds = (
      await (await chat(`threads/${id}/approvals`, undefined, 'GET')).json()
    ).approvals;
    expect(holds).toHaveLength(1);
    expect((await chat(`design-runs/${runId}/stop`, {})).status).toBe(200);
    const decision = await chat(`approvals/${holds[0].id}/decide`, {
      approve: true,
    });
    expect(decision.status).toBe(200);
    expect((await decision.json()).approval.status).toBe('approved');
    expect((await designState(runId)).status).toBe('stopped');
    expect(
      (await mcp('tools/call', { name: 'app_history', arguments: {} })).body
        .result.structuredContent.changes,
    ).toHaveLength(0);
    expect(calls).toHaveBeenCalledTimes(3);
    expect((await chat(`design-runs/${runId}/resume`, {})).status).toBe(200);
    await vi.waitFor(
      async () => expect((await designState(runId)).status).toBe('done'),
      { timeout: 15000 },
    );
    expect(
      (await mcp('tools/call', { name: 'app_history', arguments: {} })).body
        .result.structuredContent.changes,
    ).toHaveLength(1);
    const after = (
      await (await chat(`threads/${id}/approvals`, undefined, 'GET')).json()
    ).approvals;
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: holds[0].id, status: 'succeeded' });
    expect(calls).toHaveBeenCalledTimes(3);
  });

  it('recovers the exact applied result after simulated worker death before the final checkpoint', async () => {
    const calls = await durableDesignHost(false);
    response = () => ({
      content: JSON.stringify({
        summary: 'Add Visit note.',
        checks: ['Customers exists.'],
        ready: true,
        operations: [
          {
            tool: 'app.addField',
            args: {
              list: 'Customers',
              label: 'Recovery note',
              kind: 'text',
              expectedRevision: 0,
            },
          },
        ],
      }),
      finishReason: 'stop',
    });
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    let checkpoint!: (
      state: import('@happyvertical/smrt-inference/server').DesignRunState,
    ) => void;
    const reached = new Promise<
      import('@happyvertical/smrt-inference/server').DesignRunState
    >((resolve) => {
      checkpoint = resolve;
    });
    let captured:
      | import('@happyvertical/smrt-inference/server').DesignRunState
      | undefined;
    checkpointFault.beforeSave = async (state) => {
      if (
        state.definition === 'cookbook-design/v3/3' &&
        state.phase === 'model' &&
        state.passIndex === 3 &&
        state.status === 'checking'
      ) {
        checkpointFault.beforeSave = undefined;
        captured = structuredClone(state);
        checkpoint(captured);
        await paused;
      }
    };
    const oldHost = host;
    const oldDb = db;
    let stopping: Promise<void> | undefined;
    try {
      const id = await thread();
      const admission = await chat('design-runs', {
        threadId: id,
        content: 'Add Visit note.',
      });
      expect(admission.status).toBe(202);
      const runId = (await admission.json()).run.runId;
      await vi.waitFor(
        async () => {
          const current = await designState(runId);
          if (current.status === 'failed')
            throw new Error(
              `${current.note} ${checkpointFault.errors.join('\n')} ${JSON.stringify({ pass: current.passIndex, phase: current.phase, validationErrors: current.validationErrors, hasInvalidOutput: current.invalidOutput !== undefined })}`,
            );
          expect(captured).toBeDefined();
        },
        { timeout: 15000 },
      );
      const uncommitted = await reached;
      const before = await designState(runId);
      expect(before).toMatchObject({
        status: 'checking',
        phase: 'check',
        passIndex: 2,
      });
      expect(before.leaseRevision).toBeTypeOf('number');
      expect(before.leaseUntil).toBeTypeOf('number');
      expect((await chat(`design-runs/${runId}/resume`, {})).status).toBe(409);
      const prior = (
        await oldDb.query(
          "SELECT id, worker_id, attempts FROM _smrt_jobs WHERE object_id = ? AND status = 'running'",
          runId,
        )
      ).rows[0];
      expect(prior.worker_id).toBeTypeOf('string');
      stopping = oldHost.shutdown();
      unregisterLiveWorker(String(prior.worker_id));
      await (await SmrtWorkerCollection.create({ db: oldDb })).expireWorker(
        String(prior.worker_id),
      );
      db = await getDatabase({
        type: 'sqlite',
        url: join(stateDirectory, 'crash.sqlite'),
      });
      expect(db).not.toBe(oldDb);
      host = createCookbookHost({
        runtime: oldHost.runtime,
        packageName: '@fixture/host-app',
        app: { cookbook, catalog },
        assistant: { ai: { chat: calls } as never },
      });
      await host.init();
      await vi.waitFor(
        async () =>
          expect(
            (
              await db.query(
                'SELECT status FROM _smrt_jobs WHERE id = ?',
                prior.id,
              )
            ).rows[0].status,
          ).toBe('failed'),
        { timeout: 15000 },
      );
      expect((await designState(runId)).leaseRevision).toBe(
        before.leaseRevision,
      );
      const resumed = await chat(`design-runs/${runId}/resume`, {});
      expect(resumed.status).toBe(200);
      await vi.waitFor(
        async () => expect((await designState(runId)).status).toBe('done'),
        { timeout: 15000 },
      );
      const done = await designState(runId);
      expect(done.input.results).toEqual(
        (uncommitted.input as { results: unknown[] }).results,
      );
      expect(done.outputs).toEqual(before.outputs);
      expect(done.attempts).toEqual(before.attempts);
      expect(done.tokens).toBe(before.tokens);
      expect(done.input.schemaPin).toBe(before.input.schemaPin);
      const history = await mcp('tools/call', {
        name: 'app_history',
        arguments: {},
      });
      expect(history.body.result.structuredContent.changes).toHaveLength(1);
      expect(calls).toHaveBeenCalledTimes(3);
      const claims = await db.query(
        'SELECT id, attempts FROM _smrt_jobs WHERE object_id = ?',
        runId,
      );
      expect(claims.rows).toHaveLength(2);
    } finally {
      checkpointFault.beforeSave = undefined;
      release();
      await stopping;
      if (host !== oldHost) {
        await host.shutdown();
        oldHost.dispose();
        await oldDb.close?.();
      }
    }
  });

  it.each([
    1, 20,
  ])('resumes the same design run with current aggregate token cap %s and retained usage', async (cap) => {
    async function setCap(value: number) {
      await request(event('/settings/inference'), async (e) => {
        const saved = await host.workProfiles.read(e);
        expect(
          (
            await host.workProfiles.write(e, {
              settings: { design: { budgets: { maxRunTokens: value } } },
              revision: saved.revision,
            })
          ).ok,
        ).toBe(true);
        return new Response();
      });
    }
    await setCap(2);
    const id = await thread();
    response = (messages) =>
      messages.some((m) => m.content.includes('Design pass '))
        ? {
            content: JSON.stringify({
              summary: 'No changes applied.',
              checks: ['Read-only design'],
              ready: true,
              operations: [],
            }),
            finishReason: 'stop',
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          }
        : tool('recipes.enable', { id: 'host.memos', expectedRevision: 0 });
    const events = await turn(id, 'Review the Memos setup');
    const runId = events.find((e) => e.type === 'done')?.runId;
    expect(runId).toBeTruthy();
    async function state() {
      const row = (
        await db.query(
          'SELECT payload FROM _smrt_inference_design_runs WHERE id = ? AND owner_id = ? AND tenant_id = ?',
          runId,
          owner.id,
          tenantId,
        )
      ).rows[0];
      return JSON.parse(String(row.payload));
    }
    await vi.waitFor(
      async () => {
        expect((await state()).status).toBe('stopped');
        const active = await db.query(
          "SELECT id FROM _smrt_jobs WHERE object_id = ? AND status = 'running'",
          runId,
        );
        expect(active.rows).toHaveLength(0);
      },
      { timeout: 15000 },
    );
    const before = await state();
    expect(before.tokens).toBe(2);
    await setCap(cap);
    const resumed = await chat(`design-runs/${runId}/resume`, {});
    expect(resumed.status).toBe(200);
    await vi.waitFor(
      async () => {
        const after = await state();
        expect(after.id).toBe(before.id);
        expect(after.definition).toBe(before.definition);
        expect(after.budget.maxTokens).toBe(cap);
        expect(after.tokens).toBeGreaterThanOrEqual(before.tokens);
        expect(after.status).toBe(cap < before.tokens ? 'stopped' : 'done');
        if (cap < before.tokens) expect(after.tokens).toBe(before.tokens);
      },
      { timeout: 15000 },
    );
    const messages = await (
      await chat(`threads/${id}/messages`, undefined, 'GET')
    ).json();
    expect(
      messages.items.filter(
        (message: { role: string }) => message.role === 'user',
      ),
    ).toHaveLength(1);
    expect(
      JSON.stringify(
        messages.items.map((message: { content: string }) => message.content),
      ),
    ).not.toContain('JSON Schema');
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
    'claude-code',
    'codex',
  ] as const)('runs %s through the real host MCP route with short-lived scoped credentials and no API fallback', async (engine) => {
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
    // The compatible fake CLI has this explicit fixture model; no native
    // strongest-model claim is inferred from its synthetic catalog.
    await request(event('/settings/inference'), async (e) => {
      const state = await host.workProfiles.read(e);
      expect(
        (
          await host.workProfiles.write(e, {
            settings: { assist: { model: 'fixture-best' } },
            revision: state.revision,
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
    const made = await turn(
      await thread(),
      `tool ${create.name} ${JSON.stringify({ name: 'Test Person', email: '', phone: '' })}`,
    );
    expect(
      made.some((e) => e.type === 'error'),
      JSON.stringify(made),
    ).toBe(false);
    expect(JSON.stringify(made)).toContain('Added member Test Person');
    await withTenant({ tenantId }, async () => {
      const customers = await ObjectRegistry.getCollection(CUSTOMER, { db });
      const members = await customers.list({ displayLabel: true });
      expect(members.map((member) => member.toJSON().displayLabel)).toContain(
        'Test Person',
      );
    });

    const memos = await ObjectRegistry.getCollection(MEMO, { db });
    const memo = await withTenant({ tenantId }, async () => {
      const record = await memos.create({ title: 'CLI held delete' });
      await record.save();
      return record;
    });
    const deleteName = liveTools.find((t) =>
      /^memos_delete$/.test(t.name),
    )!.name;
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
          record.tool === 'host_memos.delete' && record.status === 'pending',
      );
      if (!pending) throw new Error('MCP did not persist the expected hold');
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
    await host.shutdown();
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

  it('edits models with a shared frozen catalog without changing the compiled snapshot', async () => {
    const runtime = host.runtime;
    host.dispose();
    const app = JSON.parse(
      JSON.stringify({ cookbook, catalog }),
      (_key, value) =>
        value && typeof value === 'object' ? Object.freeze(value) : value,
    );
    const original = JSON.stringify(app);
    host = createCookbookHost({
      runtime,
      packageName: '@fixture/frozen-catalog',
      app,
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
        name: 'FrozenCatalogMat',
        list: {
          label: 'Shared catalog mats',
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
    expect(editor!.snapshot().revision).toBe(1);
    expect(
      (await host.cookbookApp(tenantId)).catalog.models.some(
        (model) => model.id === '@fixture/frozen-catalog:FrozenCatalogMat',
      ),
    ).toBe(true);
    expect(JSON.stringify(app)).toBe(original);
    expect(Object.isFrozen(app.catalog.models)).toBe(true);
  });

  it('resumes app remove-field and remove-list holds through the shared owner route across restart', async () => {
    await directStructuralService();
    const runtime = host.runtime;
    host.dispose();
    const app = { cookbook, catalog: structuredClone(catalog) };
    await host.shutdown();
    host.dispose();
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
    await host.shutdown();
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
    await host.shutdown();
    host.dispose();
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
    await host.shutdown();
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
    await host.shutdown();
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
    await host.shutdown();
    host.dispose();
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
  ])('an explicitly placed Profile list lets a stub assistant create a Customer linked to its effective Profile using createType %s, never a Bot', async (createType) => {
    const state = await createCookbookHostState(db, catalog, cookbook);
    await state.refresh(tenantId);
    const before = state.engineFor({ tenantId })!.state();
    const after = structuredClone(before);
    after.cookbook.features.push(PROFILE);
    after.cookbook.layout = {
      version: 1,
      items: { 'item:profiles:Profile': { label: 'People' } },
    };
    after.revision++;
    await state.commit({
      context: { tenantId, userId: owner.id, surface: 'assistant' },
      before,
      after,
      audit: {
        context: { tenantId, userId: owner.id, surface: 'assistant' },
        tool: 'app.describe',
        outcome: 'changed',
        summary: 'Explicitly place Profiles for the STI dispatcher control',
      },
    });
    let round = 0;
    let profileId = '';
    response = (messages, options) => {
      expect(
        options.tools?.some((t) => t.function.name === 'customers_read'),
      ).toBe(true);
      round += 1;
      if (round === 1) return tool('customers_read', {});
      if (round === 2)
        return tool('people_create', {
          name: 'Ada Customer',
          typeId: profileTypeId,
          ...(createType ? { createType } : {}),
        });
      if (round === 3) {
        profileId = JSON.parse(
          messages.filter((m) => m.role === 'tool').at(-1)!.content,
        ).id;
        return tool('customers_create', { profileId });
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

  it('offers cookbook list vocabulary and excludes unpublished identity helpers from a real assistant turn', async () => {
    const state = await createCookbookHostState(db, catalog, cookbook);
    await state.refresh(tenantId);
    const before = state.engineFor({ tenantId })!.state();
    const after = structuredClone(before);
    after.revision++;
    after.cookbook.layout = {
      version: 1,
      items: { 'item:commerce:Customer': { label: 'Members' } },
    };
    await state.commit({
      context: { tenantId, userId: owner.id, surface: 'assistant' },
      before,
      after,
      audit: {
        context: { tenantId, userId: owner.id, surface: 'assistant' },
        tool: 'recipes.configure',
        outcome: 'changed',
        summary: 'Name the customer list Members',
      },
    });
    response = (_messages, options) => {
      const names = options.tools?.map((tool) => tool.function.name) ?? [];
      expect(names).toEqual(
        expect.arrayContaining(['members_read', 'members_create']),
      );
      expect(names).not.toContain('members_get_profile_id');
      expect(names.some((name) => /customer|profile/.test(name))).toBe(false);
      return text();
    };
    const seen = await turn(await thread(), 'Inspect the member tools');
    expect(
      seen.some((event) => event.type === 'error'),
      JSON.stringify(errors),
    ).toBe(false);
  });

  it('assistant creates a named member in one ordinary Customer create call', async () => {
    let round = 0;
    response = (messages, options) => {
      const create = options.tools?.find(
        (t) => t.function.name === 'customers_create',
      );
      expect(
        (
          create?.function as
            | { parameters?: { properties?: unknown } }
            | undefined
        )?.parameters?.properties,
      ).toHaveProperty('name');
      round++;
      if (round === 1)
        return tool('customers_create', {
          name: 'Typed Member',
          email: 'typed@example.test',
          phone: '555-0100',
        });
      const observed = JSON.parse(
        messages.filter((message) => message.role === 'tool').at(-1)!.content,
      );
      if (round === 2) return tool('customers_read', { id: observed.id });
      if (round === 3) {
        expect(observed).toMatchObject({
          name: 'Typed Member',
          email: 'typed@example.test',
          phone: '555-0100',
        });
        return tool('customers_read', {});
      }
      expect(observed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'Typed Member',
            email: 'typed@example.test',
            phone: '555-0100',
          }),
        ]),
      );
      return text();
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
    await directStructuralService();
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
        ? tool('memos_delete', { id: memo.id, approved: true })
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
  it('counts only this tenant list rows, allowing Fresh with owner identity and another tenant records', async () => {
    const foreign = await (await TenantCollection.create({ db })).create({
      name: 'Another business',
    });
    await foreign.save();
    await withTenant({ tenantId: foreign.id! }, async () => {
      const profile = await (
        await ObjectRegistry.getCollection(PROFILE, { db })
      ).create({ name: 'Other member', typeId: profileTypeId });
      await profile.save();
      const customer = await (
        await ObjectRegistry.getCollection(CUSTOMER, { db })
      ).create({ profileId: profile.id });
      await customer.save();
    });
    let progress = await (
      await request(event('/api/onboarding'), host.onboarding)
    ).json();
    for (const change of [
      { action: 'welcome' },
      { action: 'skip' },
      { action: 'preview', id: 'fresh' },
      { action: 'apply' },
    ]) {
      const result = await request(
        event('/api/onboarding', 'POST', {
          ...change,
          revision: progress.revision,
        }),
        host.onboarding,
      );
      expect(result.status).toBe(200);
      progress = await result.json();
    }
    expect(progress).toMatchObject({
      completed: true,
      step: 'done',
      approvalId: null,
    });
    expect((await host.cookbookApp(tenantId)).cookbook.recipes).toEqual([]);
  });
  it('previews Fresh, creates a durable hold, applies only after an owner decision, then resumes done', async () => {
    await withTenant({ tenantId, userId: owner.id }, async () => {
      const customer = await (
        await ObjectRegistry.getCollection(CUSTOMER, { db })
      ).create({ profileId: owner.profileId });
      await customer.save();
    });
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
    await host.shutdown();
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
    await withTenant({ tenantId, userId: owner.id }, async () => {
      expect(
        await (await ObjectRegistry.getCollection(CUSTOMER, { db })).count(),
      ).toBe(1);
    });
  });
  it('empty first-run setup needs one confirmation and enables the effective app subclass, STI create and linked reference labels', async () => {
    const runtime = host.runtime;
    host.dispose();
    await host.shutdown();
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
    expect(progress).toMatchObject({
      step: 'done',
      completed: true,
      approvalId: null,
      approval: null,
    });
    expect(
      (await (await chat('approvals', undefined, 'GET')).json()).approvals,
    ).toEqual([]);
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
