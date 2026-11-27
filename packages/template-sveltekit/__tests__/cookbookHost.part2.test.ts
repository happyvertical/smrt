import { randomUUID } from 'node:crypto';
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
import {
  field,
  getAiRun,
  getRunTrajectory,
  ObjectRegistry,
  readAiRunCheckpoint,
} from '@happyvertical/smrt-core';
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
import { checkpointFault } from './support/cookbookHostFault.js';
import {
  catalog,
  cookbook,
  json,
  PROFILE,
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

  it.each([
    'automatic',
    'destructive',
    'denied',
  ])('runs deterministic final design application through the native host boundary: %s', async (mode) => {
    const calls = await durableWorkflowHost(mode === 'denied');
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
        personSummary: 'I’m checking the requested changes.',
        checks: ['Target exists.'],
        ready: true,
        operations: [operation],
      }),
      finishReason: 'stop',
    });
    const id = await thread();
    const admitted = await chat('runs', {
      threadId: id,
      content: 'Update Customers.',
    });
    expect(admitted.status).toBe(202);
    const runId = (await admitted.json()).run.runId;
    await vi.waitFor(
      async () =>
        expect(
          (await workflowState(runId)).status,
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
          expect((await workflowState(runId)).status).toBe(
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

  it('fails an unready final v5 proposal with a clear host note and no approval or changes', async () => {
    const calls = await durableWorkflowHost();
    response = () => ({
      content: JSON.stringify({
        summary: 'Click Apply now, everything succeeded.',
        personSummary: 'I’m checking the requested changes.',
        checks: ['More information needed.'],
        ready: false,
        operations: [],
      }),
      finishReason: 'stop',
    });
    const id = await thread();
    const admitted = await chat('runs', {
      threadId: id,
      content: 'Review the next design.',
    });
    expect(admitted.status).toBe(202);
    const runId = (await admitted.json()).run.runId;
    await vi.waitFor(
      async () => expect((await workflowState(runId)).status).toBe('failed'),
      { timeout: 15000 },
    );
    expect(await workflowState(runId)).toMatchObject({
      status: 'failed',
      stopReason: 'check_failed',
    });
    // The failed check carries the host's own note, never model text.
    const checks = ((await getRunTrajectory(db, runId))?.entries ?? [])
      .map((entry) => entry.event)
      .filter((event) => event?.type === 'check');
    expect(checks.at(-1)?.payload).toEqual({
      failure:
        'No changes were applied. The change needs more information before it can propose a supported change.',
    });
    expect(JSON.stringify(checks)).not.toContain('Click Apply');
    const progress = await chat(`runs?threadId=${id}`, undefined, 'GET');
    expect((await progress.json()).run.note).toBe(
      'No changes were made. I need a little more information.',
    );
    expect(
      (await (await chat(`threads/${id}/approvals`, undefined, 'GET')).json())
        .approvals,
    ).toEqual([]);
    const history = await request(event('/api/history'), host.history);
    expect(history.status).toBe(200);
    expect((await history.json()).entries).toEqual([]);
    expect(calls).toHaveBeenCalledTimes(3);
  });

  it.each([
    'untouched',
    'explicit-four',
  ])("pins the app's step setting while proposing small work: %s", async (mode) => {
    const calls = await durableWorkflowHost(
      true,
      mode === 'explicit-four' ? 4 : null,
    );
    response = () => ({
      content: JSON.stringify({
        summary: 'Add a note.',
        personSummary: 'I’m checking the requested changes.',
        checks: ['Customers exists.'],
        ready: true,
        operations: [
          {
            tool: 'app.addField',
            args: {
              list: 'Customers',
              label: 'Smart note',
              kind: 'text',
              expectedRevision: 0,
            },
          },
        ],
      }),
      finishReason: 'stop',
    });
    const id = await thread();
    const admission = await chat('runs', {
      threadId: id,
      content: 'Add a note to Customers',
    });
    expect(admission.status).toBe(202);
    const runId = (await admission.json()).run.runId;
    await vi.waitFor(
      async () =>
        expect((await workflowState(runId)).status).toBe('waiting-approval'),
      { timeout: 15000 },
    );
    const state = await workflowState(runId);
    const actual = mode === 'explicit-four' ? 4 : 1;
    expect(state.input.fixedSteps).toBe(mode === 'explicit-four');
    expect(state.outputs).toHaveLength(actual);
    expect(state.calls).toBe(actual);
    expect(state.stepIndex).toBe(actual - 1);
    expect(calls).toHaveBeenCalledTimes(actual);
    const progress = await (
      await chat(`runs?threadId=${id}`, undefined, 'GET')
    ).json();
    expect(progress.run.step).toMatchObject({ index: actual, count: actual });
    const { approvals } = await (
      await chat(`threads/${id}/approvals`, undefined, 'GET')
    ).json();
    expect(approvals).toHaveLength(1);
    expect(approvals[0].summary).toContain('Smart note');
    expect(
      (await mcp('tools/call', { name: 'app_history', arguments: {} })).body
        .result.structuredContent.changes,
    ).toHaveLength(0);
  });

  it('replays one actual proposal across same-list native action holds without another model turn', async () => {
    const calls = await durableWorkflowHost(true, null);
    const operations = [
      {
        tool: 'app.addField',
        args: {
          list: 'Customers',
          label: 'Visit purpose',
          kind: 'text',
          expectedRevision: 0,
        },
      },
      {
        tool: 'app.renameField',
        args: {
          list: 'Customers',
          field: 'Visit purpose',
          label: 'Service note',
          expectedRevision: 1,
        },
      },
      {
        tool: 'app.hideField',
        args: { list: 'Customers', field: 'Service note', expectedRevision: 2 },
      },
      {
        tool: 'app.renameList',
        args: { list: 'Customers', label: 'Members', expectedRevision: 3 },
      },
    ];
    response = () => ({
      content: JSON.stringify({
        summary: 'Make the requested small changes.',
        personSummary: 'I’m checking the requested changes.',
        checks: ['Customers exists.'],
        ready: true,
        operations,
      }),
      finishReason: 'stop',
    });
    const id = await thread();
    const admission = await chat('runs', {
      threadId: id,
      content: 'Add, label and hide a field, then label the list Members.',
    });
    expect(admission.status).toBe(202);
    const runId = (await admission.json()).run.runId;
    const authority = new OwnerApprovalAuthority(
      await createSqliteOwnerApprovalStore(db),
      async () => true,
    );
    const holds: string[] = [];
    for (const [index, operation] of operations.entries()) {
      let hold: { id: string } | undefined;
      await vi.waitFor(
        async () => {
          const { approvals } = await (
            await chat(`threads/${id}/approvals`, undefined, 'GET')
          ).json();
          const pending = approvals.filter(
            (record: { status: string }) => record.status === 'pending',
          );
          expect(pending).toHaveLength(1);
          expect(holds).not.toContain(pending[0].id);
          hold = pending[0];
        },
        { timeout: 15000 },
      );
      holds.push(hold!.id);
      expect(await authority.get(tenantId, hold!.id)).toMatchObject({
        tool: operation.tool,
        args: operation.args,
        context: { workflowAction: { runId, actionId: String(index) } },
      });
      expect(await workflowState(runId)).toMatchObject({
        stepIndex: 0,
        phase: 'check',
        outputs: [expect.any(Object)],
      });
      expect(calls).toHaveBeenCalledTimes(1);
      expect(
        (await chat(`approvals/${hold!.id}/decide`, { approve: true })).status,
      ).toBe(200);
    }
    await vi.waitFor(
      async () => expect((await workflowState(runId)).status).toBe('done'),
      { timeout: 15000 },
    );
    const done = await workflowState(runId);
    expect(done).toMatchObject({
      stepIndex: 0,
      phase: 'check',
      outputs: [expect.any(Object)],
    });
    expect(done.input.results).toHaveLength(4);
    // One hold per gated action, each its own approval in the run.
    const approvals = ((await getRunTrajectory(db, runId))?.entries ?? [])
      .map((entry) => entry.event)
      .filter((event) => event?.type === 'approval');
    expect(approvals.map((event) => event?.status)).toEqual([
      'requested',
      'approved',
      'requested',
      'approved',
      'requested',
      'approved',
      'requested',
      'approved',
    ]);
    expect(calls).toHaveBeenCalledTimes(1);
    expect(
      (await mcp('tools/call', { name: 'app_history', arguments: {} })).body
        .result.structuredContent.changes,
    ).toHaveLength(4);
    for (const hold of holds)
      expect((await authority.get(tenantId, hold))?.status).toBe('succeeded');
  });

  it('records approval while stopped and waits for explicit Resume before applying the same hold', async () => {
    const calls = await durableWorkflowHost(true, null);
    response = () => ({
      content: JSON.stringify({
        summary: 'Add Paused note.',
        personSummary: 'I’m checking the requested changes.',
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
    const admitted = await chat('runs', {
      threadId: id,
      content: 'Add Paused note.',
    });
    expect(admitted.status).toBe(202);
    const runId = (await admitted.json()).run.runId;
    await vi.waitFor(
      async () =>
        expect((await workflowState(runId)).status).toBe('waiting-approval'),
      { timeout: 15000 },
    );
    const holds = (
      await (await chat(`threads/${id}/approvals`, undefined, 'GET')).json()
    ).approvals;
    expect(holds).toHaveLength(1);
    expect(holds[0].summary).toBe('Add Paused note to Customers.');
    expect(await workflowState(runId)).toMatchObject({
      phase: 'check',
      stepIndex: 0,
      outputs: [expect.any(Object)],
    });
    expect((await chat(`runs/${runId}/stop`, {})).status).toBe(200);
    const decision = await chat(`approvals/${holds[0].id}/decide`, {
      approve: true,
    });
    expect(decision.status).toBe(200);
    const approved = (await decision.json()).approval;
    expect(approved).toMatchObject({
      status: 'approved',
      summary: 'Add Paused note to Customers.',
    });
    expect((await workflowState(runId)).status).toBe('stopped');
    expect(
      (await mcp('tools/call', { name: 'app_history', arguments: {} })).body
        .result.structuredContent.changes,
    ).toHaveLength(0);
    expect(calls).toHaveBeenCalledTimes(1);
    const editor = (await withTenant({ tenantId, userId: owner.id }, () =>
      host.modelEditor(tenantId),
    ))!;
    const originalApply = editor.apply;
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    let executing = false;
    const apply = vi
      .spyOn(editor, 'apply')
      .mockImplementation(async (...args) => {
        executing = true;
        await delayed;
        return originalApply(...args);
      });
    try {
      expect((await chat(`runs/${runId}/resume`, {})).status).toBe(200);
      await vi.waitFor(() => expect(executing).toBe(true), { timeout: 15000 });
      const records = (
        await (await chat(`threads/${id}/approvals`, undefined, 'GET')).json()
      ).approvals;
      expect(
        records.find((record: { id: string }) => record.id === holds[0].id),
      ).toMatchObject({
        status: 'executing',
        summary: 'Add Paused note to Customers.',
      });
      const raw = new OwnerApprovalAuthority(
        await createSqliteOwnerApprovalStore(db),
        async () => true,
      );
      expect((await raw.get(tenantId, holds[0].id))?.summary).toBe(
        'Added Paused note to Customers.',
      );
      expect(
        (await (await request(event('/api/history'), host.history)).json())
          .entries,
      ).toHaveLength(0);
    } finally {
      release();
    }

    await vi.waitFor(
      async () => expect((await workflowState(runId)).status).toBe('done'),
      { timeout: 15000 },
    );
    expect(
      (await mcp('tools/call', { name: 'app_history', arguments: {} })).body
        .result.structuredContent.changes,
    ).toHaveLength(1);
    apply.mockRestore();
    const after = (
      await (await chat(`threads/${id}/approvals`, undefined, 'GET')).json()
    ).approvals;
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      id: holds[0].id,
      status: 'succeeded',
      summary: 'Added Paused note to Customers.',
    });
    const history = await (
      await request(event('/api/history'), host.history)
    ).json();
    expect(history.entries[0].action).toBe('Added Paused note to Customers.');
    const undo = (
      await mcp('tools/call', {
        name: 'app_undo',
        arguments: { expectedRevision: 1 },
      })
    ).body.result.structuredContent;
    expect(undo.status).toBe('approval_required');
    const undoCards = (await (await chat('approvals', undefined, 'GET')).json())
      .approvals;
    expect(
      undoCards.find((record: { id: string }) => record.id === undo.approvalId)
        ?.summary,
    ).toBe('Reverse the last structure change');
    const reversed = await chat(`approvals/${undo.approvalId}/decide`, {
      approve: true,
    });
    expect(reversed.status).toBe(200);
    expect((await reversed.json()).approval).toMatchObject({
      status: 'succeeded',
      summary: 'Reversed the last structure change',
    });
    const reversedHistory = await (
      await request(event('/api/history'), host.history)
    ).json();
    expect(reversedHistory.entries).toHaveLength(2);
    expect(reversedHistory.entries[0].action).toBe(
      'Reversed the last structure change',
    );
    expect(
      /restor|revision|cookbook/i.test(reversedHistory.entries[0].action),
    ).toBe(false);
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it('recovers the exact applied result after simulated worker death before the final checkpoint', async () => {
    const calls = await durableWorkflowHost(false, null);
    response = () => ({
      content: JSON.stringify({
        summary: 'Add Visit note.',
        personSummary: 'I’m checking the requested changes.',
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
    let captured: Record<string, unknown> | undefined;
    // The worker dies after the check applied the change through core and
    // before the driver saved the step: the check's result is never saved.
    checkpointFault.afterCheck = async (result) => {
      if (result.complete) {
        checkpointFault.afterCheck = undefined;
        captured = structuredClone(result.input) as Record<string, unknown>;
        await paused;
      }
    };
    let rescuer: TaskRunner | undefined;
    try {
      const id = await thread();
      const admission = await chat('runs', {
        threadId: id,
        content: 'Add Visit note.',
      });
      expect(admission.status).toBe(202);
      const runId = (await admission.json()).run.runId;
      await vi.waitFor(
        async () => {
          const current = await workflowState(runId);
          if (current.status === 'failed')
            throw new Error(checkpointFault.errors.join('\n'));
          expect(captured).toBeDefined();
        },
        { timeout: 15000 },
      );
      const before = await workflowState(runId);
      expect(before).toMatchObject({
        status: 'running',
        phase: 'check',
        stepIndex: 0,
      });
      expect(JSON.parse(String(before.lease))).toMatchObject({
        holder: expect.any(String),
      });
      // The change is applied, its step is not saved, its job still runs.
      expect(
        (await mcp('tools/call', { name: 'app_history', arguments: {} })).body
          .result.structuredContent.changes,
      ).toHaveLength(1);
      expect((await chat(`runs/${runId}/resume`, {})).status).toBe(409);
      const prior = (
        await db.query(
          "SELECT id, worker_id, attempts FROM _smrt_jobs WHERE dedupe_key = ? AND status = 'running'",
          runId,
        )
      ).rows[0];
      expect(prior.worker_id).toBeTypeOf('string');
      // The worker dies: its liveness ends. A second real runner (claim
      // fencing on, the same registered handler) recovers its job.
      unregisterLiveWorker(String(prior.worker_id));
      await (await SmrtWorkerCollection.create({ db })).expireWorker(
        String(prior.worker_id),
      );
      rescuer = new TaskRunner({
        concurrency: 1,
        queues: ['default'],
        retention: false,
        claimFencing: true,
        pollInterval: 10,
      });
      await rescuer.initialize(db);
      await rescuer.start();
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
      // No lease is cleared to bypass ownership: the stale one is replaced
      // only by the new job's claim.
      expect((await workflowState(runId)).lease).toBe(before.lease);
      const resumed = await chat(`runs/${runId}/resume`, {});
      expect(resumed.status).toBe(200);
      await vi.waitFor(
        async () => expect((await workflowState(runId)).status).toBe('done'),
        { timeout: 15000 },
      );
      const done = await workflowState(runId);
      // The replayed check returned the exact committed core result.
      expect(done.input.results).toEqual(captured?.results);
      expect(done.outputs).toEqual(before.outputs);
      expect(done.tokens).toBe(before.tokens);
      expect(done.input.schemaPin).toBe(before.input.schemaPin);
      // The dead worker wakes up: claim fencing refuses its save, so it
      // writes nothing over the recovered run.
      const settledRevision = (await readAiRunCheckpoint(db, runId))?.revision;
      release();
      await vi.waitFor(
        async () =>
          expect(
            (
              await db.query(
                "SELECT id FROM _smrt_jobs WHERE dedupe_key = ? AND status = 'running'",
                runId,
              )
            ).rows,
          ).toHaveLength(0),
        { timeout: 15000 },
      );
      expect((await readAiRunCheckpoint(db, runId))?.revision).toBe(
        settledRevision,
      );
      expect((await workflowState(runId)).status).toBe('done');
      const history = await mcp('tools/call', {
        name: 'app_history',
        arguments: {},
      });
      expect(history.body.result.structuredContent.changes).toHaveLength(1);
      expect(calls).toHaveBeenCalledTimes(1);
      const claims = await db.query(
        'SELECT id, attempts FROM _smrt_jobs WHERE dedupe_key = ?',
        runId,
      );
      expect(claims.rows).toHaveLength(2);
    } finally {
      checkpointFault.afterCheck = undefined;
      release();
      await rescuer?.stop();
    }
  });

  it.each([
    1, 10_000_000,
  ])("stops at the app's token cap and resumes the same workflow run under its current cap %s", async (cap) => {
    // The app's setting for the workflow's budget: a new host with the new
    // value, as a redeploy would bring.
    async function setCap(value: number) {
      const runtime = host.runtime;
      await host.shutdown();
      host.dispose();
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
        workflowBudget: { maxRunTokens: value },
      });
      await host.init();
    }
    await setCap(1);
    const id = await thread();
    response = (messages) =>
      messages.some((m) => m.content.includes('Workflow step '))
        ? {
            content: JSON.stringify({
              summary: 'No changes applied.',
              personSummary: 'I’m checking the requested changes.',
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
    // The step's first call cannot be reserved within one token: the run
    // stops (resumable) with the limit's reason before any model call.
    await vi.waitFor(
      async () => {
        expect(await workflowState(runId as string)).toMatchObject({
          status: 'stopped',
          stopReason: 'max_tokens',
        });
        const active = await db.query(
          "SELECT id FROM _smrt_jobs WHERE dedupe_key = ? AND status = 'running'",
          runId,
        );
        expect(active.rows).toHaveLength(0);
      },
      { timeout: 15000 },
    );
    const before = await workflowState(runId as string);
    expect(before.input.listCatalog).toBeUndefined();
    expect(before.calls).toBe(0);
    await setCap(cap);
    const resumed = await chat(`runs/${runId}/resume`, {});
    if (cap === 1) {
      // A budget stop resumes only with the stopping limit raised.
      expect(resumed.status).toBe(409);
      expect(await workflowState(runId as string)).toMatchObject({
        status: 'stopped',
        stopReason: 'max_tokens',
        calls: 0,
      });
    } else {
      expect(resumed.status).toBe(200);
      await vi.waitFor(
        async () => {
          const after = await workflowState(runId as string);
          expect(after.budget.maxTokens).toBe(cap);
          expect(after.status).toBe('done');
          expect(after.calls).toBeGreaterThan(0);
        },
        { timeout: 15000 },
      );
    }
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
});
