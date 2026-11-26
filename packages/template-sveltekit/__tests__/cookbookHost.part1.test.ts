import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
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
  getAiRun,
  ObjectRegistry,
  readAiRunCheckpoint,
  smrt,
} from '@happyvertical/smrt-core';
import {
  getTestDatabase,
  snapshotObjectRegistryState,
} from '@happyvertical/smrt-core/testing';
import { createAgentCliService } from '@happyvertical/smrt-inference/server';
import { TaskRunner } from '@happyvertical/smrt-jobs';
import { ProfileTypeCollection } from '@happyvertical/smrt-profiles';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
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
import { testHomeEnvironment } from '../../vitest/src/test-home.js';
import { createCookbookHost } from '../host/server.js';
import { createCookbookHostState } from '../host/state.js';
import { checkpointFault } from './support/cookbookHostFault.js';
import {
  CUSTOMER,
  catalog,
  cookbook,
  json,
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
  async function durableWorkflowHost(preview = true, steps: number | null = 3) {
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
      ...(steps === null ? {} : { workflowBudget: { steps } }),
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
      const saved = await host.assistantSettings.read(e);
      expect(
        (
          await host.assistantSettings.write(e, {
            settings: { previewBeforeApply: preview },
            revision: saved.revision,
          })
        ).ok,
      ).toBe(true);
      return new Response();
    });
    return calls;
  }
  /** A workflow run as core records it: run row plus checkpoint state. */
  async function workflowState(id: string) {
    const run = await getAiRun(db, id);
    const checkpoint = await readAiRunCheckpoint(db, id);
    const state = checkpoint?.state as {
      stepIndex: number;
      phase: 'call' | 'check';
      outputs: unknown[];
      pending: { output: unknown } | null;
      input: Record<string, unknown>;
    };
    return {
      id,
      status: run?.status,
      stopReason: run?.stopReason ?? null,
      budget: run?.budget ?? {},
      tokens: run?.inclusiveTokens ?? 0,
      calls: run?.inclusiveCalls ?? 0,
      definitionVersion: checkpoint?.definitionVersion ?? null,
      lease: checkpoint?.lease ?? null,
      stepIndex: state.stepIndex,
      phase: state.phase,
      input: state.input as Record<string, any>,
      /** Accepted outputs, then the output awaiting its check. */
      outputs: (state.pending
        ? [...state.outputs.slice(0, state.stepIndex), state.pending.output]
        : state.outputs) as any[],
    };
  }

  it("binds the assistant's best tier to the strongest ranked ChatGPT account model, never the first catalog entry", async () => {
    const runtime = host.runtime;
    await host.shutdown();
    host.dispose();
    const clientOptions = vi.fn(async () => {
      throw new Error('stop before a provider call');
    });
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
        clientOptions,
        start: vi.fn(),
        cancel: vi.fn(),
        signOut: vi.fn(),
      } as never,
    });
    await host.init();
    expect(
      (
        await request(
          event('/api/connect-ai', 'POST', {
            action: 'select',
            engine: 'chatgpt',
          }),
          host.connectAi.POST,
        )
      ).status,
    ).toBe(200);
    const id = await thread();
    // The stub stops before a provider call: the route answers 503.
    const refused = await request(
      event(`/api/assistant/threads/${id}/messages`, 'POST', {
        content: 'Hello',
        clientRequestId: randomUUID(),
      }),
      host.assistant.handle,
    );
    expect(refused.status).toBe(503);
    expect(clientOptions).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'strong' }),
    );
  });

  it('loads the owner assistant settings, rejects stale saves and resets to all on', async () => {
    await request(event('/settings/inference'), async (e) => {
      const before = await host.assistantSettings.read(e);
      expect(before.settings).toEqual({});
      expect(before.editable).toBe(true);
      const settings = { escalateToWorkflow: false, previewBeforeApply: false };
      expect(
        (
          await host.assistantSettings.write(e, {
            settings,
            revision: before.revision,
          })
        ).ok,
      ).toBe(true);
      const saved = await host.assistantSettings.read(e);
      expect(saved.settings).toEqual(settings);
      expect(
        await host.assistantSettings.write(e, {
          settings: {},
          revision: null,
        }),
      ).toEqual({ ok: false, reason: 'conflict' });
      expect((await host.assistantSettings.reset(e, saved.revision)).ok).toBe(
        true,
      );
      expect((await host.assistantSettings.read(e)).settings).toEqual({});
      return new Response();
    });
  });

  it('steps a refused model down the tier binding order only within its exact memo scope', async () => {
    const state = await createCookbookHostState(db, catalog, cookbook);
    expect(
      (
        await request(
          event('/api/connect-ai', 'POST', {
            action: 'select',
            engine: 'claude-code',
          }),
          host.connectAi.POST,
        )
      ).status,
    ).toBe(200);
    const version = (await cli.cliStatus('claude-code')).version ?? 'unknown';
    const generation = await state.engineGeneration(tenantId, owner.id);
    const connection = `${version}:${generation}`;
    const store = state.fallbackStore(tenantId);
    // Memos of another scope never apply.
    await store.write(
      owner.id,
      'claude-code',
      'fable',
      `other:${generation}`,
      'opus',
    );
    await store.write(
      owner.id,
      'claude-code',
      'fable',
      `${version}:other`,
      'opus',
    );
    await store.write(randomUUID(), 'claude-code', 'fable', connection, 'opus');
    await state
      .fallbackStore(randomUUID())
      .write(owner.id, 'claude-code', 'fable', connection, 'opus');
    const path = join(stateDirectory, 'bin', 'claude');
    const binary = await readFile(path, 'utf8');
    await writeFile(
      path,
      binary.replace(
        "if (head === 'say') {",
        "if (head === 'selected-model') { say(argv[argv.indexOf('--model') + 1]); } else if (head === 'say') {",
      ),
      { mode: 0o700 },
    );
    response = () => {
      throw new Error('API fallback is forbidden');
    };
    const first = await turn(await thread(), 'selected-model');
    // No memo: the best tier of Claude Code's default binding answers.
    expect(first.find((value) => value.type === 'done')).toMatchObject({
      message: { content: 'fable' },
    });
    await store.write(owner.id, 'claude-code', 'fable', connection, 'opus');
    issued.length = 0;
    const actual = await turn(await thread(), 'selected-model');
    expect(actual.find((value) => value.type === 'done')).toMatchObject({
      message: { content: 'opus' },
    });
    expect(issued).toHaveLength(1);
    expect(revoked).toContain(issued[0].holder);
  });

  it('admits a durable design proposal before a structural tool executes', async () => {
    await durableWorkflowHost();
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
    const privateReasoning =
      '@happyvertical/smrt-commerce:Customer app.addField expectedRevision 2 cookbook';
    response = (messages) =>
      messages.some((m) => m.content.includes('Workflow step '))
        ? {
            content: JSON.stringify({
              summary: privateReasoning,
              personSummary: privateReasoning,
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
        const response = await chat(`runs?threadId=${id}`, undefined, 'GET');
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.run.runId).toBe(done?.runId);
        expect(['done', 'waiting-approval']).toContain(body.run.status);
        expect(body.run.note).toBe('Your changes are ready for your review.');
        expect(
          /smrt-commerce|app\.addField|expectedRevision|cookbook/.test(
            JSON.stringify(body),
          ),
        ).toBe(false);
      },
      { timeout: 15000 },
    );
    expect((await host.cookbookApp(tenantId)).cookbook.recipes).not.toContain(
      'host.memos',
    );
    const raw = await workflowState(done?.runId as string);
    expect(raw.outputs).toHaveLength(3);
    for (const output of raw.outputs) {
      expect(output.summary).toBe(privateReasoning);
      expect(output.personSummary).toBe(privateReasoning);
    }
    const reloaded = await chat(`threads/${id}/messages`, undefined, 'GET');
    expect(reloaded.status).toBe(200);
    expect(
      /smrt-commerce|app\.addField|expectedRevision|cookbook/.test(
        JSON.stringify(await reloaded.json()),
      ),
    ).toBe(false);
    expect(
      /smrt-commerce|app\.addField|expectedRevision|cookbook/.test(
        JSON.stringify(events),
      ),
    ).toBe(false);
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
      workflowBudget: { steps: 3 },
      assistant: {
        ai: {
          chat: async (messages: never, options: never) => {
            calls.push({ messages, options });
            return {
              content: JSON.stringify({
                summary: 'Add Birthday to Customers.',
                personSummary: 'I’m checking the requested changes.',
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
    const id = await thread();
    const admitted = await chat('runs', {
      threadId: id,
      content: 'Add a birthday field to Customers.',
    });
    expect(admitted.status).toBe(202);
    const runId = (await admitted.json()).run.runId;
    await vi.waitFor(
      async () => {
        const state = await workflowState(runId);
        expect(state.status).toBe('waiting-approval');
        expect(state.definitionVersion).toBe('1/steps-3');
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
    const before = await workflowState(runId);
    const decision = await chat(`approvals/${approvals[0].id}/decide`, {
      approve: true,
    });
    expect(decision.status).toBe(200);
    expect((await decision.json()).approval.status).toBe('succeeded');
    await vi.waitFor(
      async () => expect((await workflowState(runId)).status).toBe('done'),
      { timeout: 15000 },
    );
    const done = await workflowState(runId);
    expect(done.outputs).toEqual(before.outputs);
    // The approval re-ran only the check: no further model call or usage.
    expect(done.tokens).toBe(before.tokens);
    expect(done.calls).toBe(3);
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
        resourceType: 'Your app',
        resourceId: 'Changes',
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
      'execution',
      'budget',
      'fixedPasses',
      'listCatalog',
      'expanded',
      'engine',
      'actionKey',
      'actionId',
      'runId',
      'workflowAction',
      'approvalId',
      'ownerId',
      'userId',
      'tenantId',
    ]) {
      expect(
        (
          await chat('runs', {
            threadId: id,
            content: 'Review Customers.',
            [key]: 'forged',
          })
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await chat('runs', {
          threadId: randomUUID(),
          content: 'Review Customers.',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await chat('runs', {
          threadId: id,
          content: 'x'.repeat(140_000),
        })
      ).status,
    ).toBe(413);
    const crossOrigin = event('/api/assistant/runs', 'POST', {
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
            '/api/assistant/runs',
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
      (await db.query('SELECT run_id FROM _smrt_ai_run_checkpoints')).rows,
    ).toHaveLength(0);
  });
  it('replaces unsafe canonical business captions separately from private design reasoning', async () => {
    await durableWorkflowHost();
    const id = await thread();
    let label = 'Tenant Id';
    response = () => ({
      content: JSON.stringify({
        summary: 'Private implementation reasoning.',
        personSummary: 'Private presentation suggestion.',
        checks: ['Customers exists.'],
        ready: true,
        operations: [
          {
            tool: 'app.addField',
            args: {
              list: 'Customers',
              label,
              kind: 'text',
              expectedRevision: 0,
            },
          },
        ],
      }),
      finishReason: 'stop',
    });
    const refused = await chat('runs', {
      threadId: id,
      content: 'Add a Tenant Id field',
    });
    expect(refused.status).toBe(202);
    const refusedId = (await refused.json()).run.runId;
    await vi.waitFor(
      async () =>
        expect((await workflowState(refusedId)).status).toBe('failed'),
      { timeout: 15000 },
    );
    // The real core refuses this reserved existing field before a hold exists.
    expect(
      checkpointFault.errors.some((error) => error.includes('already used')),
    ).toBe(true);
    expect(
      (await (await chat(`threads/${id}/approvals`, undefined, 'GET')).json())
        .approvals,
    ).toEqual([]);
    label = 'Birthday';
    const admitted = await chat('runs', {
      threadId: id,
      content: 'Add a birthday field',
    });
    expect(admitted.status).toBe(202);
    const runId = (await admitted.json()).run.runId;
    await vi.waitFor(
      async () =>
        expect((await workflowState(runId)).status).toBe('waiting-approval'),
      { timeout: 15000 },
    );
    const pending = (
      await (await chat(`threads/${id}/approvals`, undefined, 'GET')).json()
    ).approvals;
    expect(pending).toHaveLength(1);
    expect(pending[0].summary).toContain('Birthday');
    expect(pending[0].summary).toContain('Customers');
    const authority = new OwnerApprovalAuthority(
      await createSqliteOwnerApprovalStore(db),
      async () => true,
    );
    const held = (await authority.get(tenantId, pending[0].id))!;
    expect(held).toMatchObject({
      tool: 'app.addField',
      args: { label: 'Birthday' },
      status: 'pending',
    });
    // Presentation-only records use the real canonical hold envelope. No decision
    // or execution is made on these deliberately unsafe historical captions.
    for (const caption of [
      'Tenant Id',
      'Profile Id',
      'app.addField',
      'CustomerClass',
      '@happyvertical/smrt-commerce:Customer',
    ]) {
      const saved = await authority.request({
        tenantId,
        requestedBy: owner.id,
        tool: held.tool,
        callId: randomUUID(),
        args: held.args,
        summary: `Added ${caption} to Customers.`,
        context: held.context,
        continuation: held.continuation,
      });
      const { approvals } = await (
        await chat(`threads/${id}/approvals`, undefined, 'GET')
      ).json();
      const projected = approvals.filter(
        (approval: { id: string }) => approval.id === saved.id,
      );
      expect(projected).toHaveLength(1);
      expect(projected[0]).toMatchObject({
        tool: 'change',
        summary: 'Review this change',
        status: 'pending',
      });
      expect((await authority.get(tenantId, saved.id))?.summary).toBe(
        `Added ${caption} to Customers.`,
      );
    }
    const history = await request(event('/api/history'), host.history);
    expect((await history.json()).entries).toEqual([]);
  });

  it('presents prospective canonical app, recipe and template captions without changing the ledger', async () => {
    await durableWorkflowHost();
    const id = await thread();
    const user = await (await UserCollection.create({ db })).get({
      id: owner.id,
    });
    const authority = new OwnerApprovalAuthority(
      await createSqliteOwnerApprovalStore(db),
      async () => true,
    );
    // Projection-only requests exercise canonical records without inventing
    // successful effects. Real execution and history are checked below in Stop.
    for (const item of [
      {
        tool: 'app.addField',
        args: {},
        summary: 'Added Visit note to Customers.',
        expected: 'Add Visit note to Customers.',
      },
      {
        tool: 'app.renameField',
        args: {},
        summary: 'Renamed Note to Visit note.',
        expected: 'Rename Note to Visit note.',
      },
      {
        tool: 'app.removeField',
        args: {},
        summary: 'Removed Size from Loaner mats and kept its data.',
        expected: 'Remove Size from Loaner mats and keep its data.',
      },
      {
        tool: 'app.hideField',
        args: {},
        summary: 'Hid Email in Customers.',
        expected: 'Hide Email in Customers.',
      },
      {
        tool: 'app.showField',
        args: {},
        summary: 'Showed Email in Customers.',
        expected: 'Show Email in Customers.',
      },
      {
        tool: 'app.undo',
        args: {},
        summary: 'Undid change 2: Added hidden implementation details.',
        expected: 'Reverse the last structure change',
      },
      {
        tool: 'recipes.configure',
        args: { id: 'host.memos' },
        summary: 'Configured Memos.',
        expected: 'Configure Memos.',
      },
      {
        tool: 'recipes.enable',
        args: { id: 'host.memos' },
        summary: 'Internal receipt @fixture/host:Memos',
        expected: 'Enable Memos.',
      },
      {
        tool: 'recipes.disable',
        args: { id: 'host.customers' },
        summary: 'Internal receipt @fixture/host:Customer',
        expected: 'Disable Customers.',
      },
      {
        tool: 'cookbook.apply',
        args: { id: 'mechanic' },
        summary: 'Use Mechanic.',
        expected: 'Use Mechanic.',
      },
    ]) {
      const saved = await authority.request({
        tenantId,
        requestedBy: owner.id,
        tool: item.tool,
        args: item.args,
        summary: item.summary,
        callId: randomUUID(),
        context: {
          threadId: id,
          principal: { userId: owner.id, tenantId, profileId: user!.profileId },
        },
        continuation: {
          executor: 'cookbook',
          consumption: 'executor',
          principal: {
            id: owner.id,
            tenantId,
            permissions: [...permissions],
            allowedTools: [item.tool],
          },
        },
      });
      const { approvals } = await (
        await chat(`threads/${id}/approvals`, undefined, 'GET')
      ).json();
      const card = approvals.find(
        (record: { id: string }) => record.id === saved.id,
      );
      expect(card).toMatchObject({
        status: 'pending',
        summary: item.expected,
        presentation: { summary: item.expected },
      });
      expect((await authority.get(tenantId, saved.id))?.summary).toBe(
        item.summary,
      );
    }
    expect(
      (await (await request(event('/api/history'), host.history)).json())
        .entries,
    ).toEqual([]);
  });

  it('keeps structure history owner-scoped and permission-bound without leaking change documents', async () => {
    await durableWorkflowHost();
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
    const editor = (await withTenant({ tenantId, userId: owner.id }, () =>
      host.modelEditor(tenantId),
    ))!;
    await withTenant({ tenantId, userId: owner.id }, async () => {
      await editor.apply(
        {
          type: 'add_field',
          model: CUSTOMER,
          name: 'extraNote',
          field: { type: 'text' },
          label: 'Extra note',
          summary: 'Added Tenant Id to Customers.',
        },
        {
          actor: owner.id,
          tenantId,
          requestId: randomUUID(),
          expectedRevision: editor.snapshot().revision,
        },
      );
      return new Response();
    });
    expect(JSON.parse((await editor.history())[0].command).summary).toBe(
      'Added Tenant Id to Customers.',
    );
    const safeHistory = await (
      await request(event('/api/history'), host.history)
    ).json();
    expect(safeHistory.entries).toEqual([
      {
        id: '1',
        action: 'Changed your app',
        resourceType: 'Your app',
        resourceId: 'Changes',
        actorLabel: 'You',
      },
    ]);
  });
});
