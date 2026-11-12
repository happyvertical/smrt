/** Real owner tokens, SQLite host, generated launchers and stdio MCP client. */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSqliteOwnerApprovalStore,
  OwnerApprovalAuthority,
} from '@happyvertical/smrt-app-runtime';
import { createSmrtSvelteKitRuntime } from '@happyvertical/smrt-app-runtime/sveltekit';
import { resolveApplicationRuntime } from '@happyvertical/smrt-config';
import {
  field,
  ObjectRegistry,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import type { AppModelSnapshot } from '@happyvertical/smrt-core/app-models';
import { APIGenerator } from '@happyvertical/smrt-core/generators/rest';
import { isRuntimeModelEnabled } from '@happyvertical/smrt-core/runtime-exposure';
import { disableTenancy } from '@happyvertical/smrt-tenancy';
import {
  DEFAULT_ROLE_SLUGS,
  MembershipCollection,
  PermissionCollection,
  RoleCollection,
  RolePermissionCollection,
  TenantCollection,
} from '@happyvertical/smrt-users';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { RequestEvent } from '@sveltejs/kit';
import { afterEach, expect, it, vi } from 'vitest';
import {
  screenRecordLabel,
  screenReferenceTarget,
} from '../../smrt-svelte/src/components/screens/references.js';
import { createRecipeScreenReferences } from '../../smrt-svelte/src/components/screens/source.js';
import { testHomeEnvironment } from '../../vitest/src/test-home.js';
import type { PluginModeState } from '../host/plugin-mode.js';
import { createCookbookHost } from '../host/server.js';

it('loads the published host without CLI bridge SDKs and preserves the first-use error', () => {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === '@happyvertical/smrt-app-cli') throw new Error('App CLI unavailable');
      if (specifier.startsWith('@modelcontextprotocol/')) throw new Error('Unexpected eager MCP SDK');
      return next(specifier, context);
    } });
    await import(${JSON.stringify(new URL('../dist/host/server.js', import.meta.url).href)});
    const { createPluginMode } = await import(${JSON.stringify(new URL('../dist/host/plugin-mode.js', import.meta.url).href)});
    const plugin = createPluginMode({
      runtime: { localRuntime: async () => ({ mcpTokens: { list: async () => [] } }) },
      sourceRoot: '.', name: 'fixture', state: async () => ({ embed: async () => false }),
      authorize: async () => null,
    });
    let failed = false;
    try { await plugin.read({ id: 'owner', tenantId: 'tenant' }); }
    catch (error) { if (error.message !== 'App CLI unavailable') throw error; failed = true; }
    if (!failed) process.exit(2);
  `,
    ],
    { encoding: 'utf8', timeout: 30000 },
  );
  expect(child.status, child.stderr).toBe(0);
});

@smrt({
  packageName: '@fixture/plugin',
  collection: 'plugin_members',
  tableName: 'plugin_members',
  mcp: { include: ['list', 'get', 'create', 'delete'] },
})
class PluginMember extends SmrtObject {
  @field() name = '';
}
@smrt({
  packageName: '@fixture/plugin',
  collection: 'plugin_tasks',
  mcp: { include: ['list', 'get'] },
})
class PluginTask extends SmrtObject {
  @field() name = '';
}
void PluginMember;
void PluginTask;

let root = '';
let host: ReturnType<typeof createCookbookHost> | undefined;
let http: Server | undefined;
let client: Client | undefined;
let origin = '';
let session = '';
let failures: string[] = [];
let stateRoot = '';
let assistantDefinitions: NonNullable<
  PluginModeState['tools']
>[number]['definition'][] = [];
let released: (() => void) | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await client?.close();
  client = undefined;
  if (http) {
    http.closeAllConnections();
    await new Promise<void>((resolve) => http!.close(() => resolve()));
    http = undefined;
  }
  host?.dispose();
  if (host) {
    try {
      await (await host.runtime.localRuntime()).db.close?.();
    } catch {
      /* Failed startup has no database. */
    }
  }
  host = undefined;
  released?.();
  released = undefined;
  disableTenancy();
  if (root) await rm(root, { recursive: true, force: true });
  if (stateRoot) await rm(stateRoot, { recursive: true, force: true });
});
function event(path: string, body?: unknown, signedIn = true): RequestEvent {
  const url = new URL(path, origin);
  return {
    url,
    request: new Request(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin, host: url.host, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    locals: {},
    params: { path: path.replace('/api/assistant/', '') },
    cookies: {
      get: () => (signedIn ? session : undefined),
      getAll: () => [],
      set: () => {},
      delete: () => {},
    },
    getClientAddress: () => '127.0.0.1',
  } as unknown as RequestEvent;
}
async function request(
  path: string,
  handler: (e: RequestEvent) => Promise<Response>,
  body?: unknown,
  signedIn = true,
) {
  return host!.handle({ event: event(path, body, signedIn), resolve: handler });
}
function payload(result: Awaited<ReturnType<Client['callTool']>>) {
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  const text = result.content.find((c) => c.type === 'text');
  return JSON.parse(text && 'text' in text ? text.text : '{}');
}
async function call(name: string, args: Record<string, unknown> = {}) {
  return payload(await client!.callTool({ name, arguments: args }));
}

it('generates private setup; bridges live tools, writes and durable owner decisions without leaking tokens', async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'smrt-plugin-')));
  failures = [];
  const sourceRoot = join(root, 'source');
  await mkdir(sourceRoot);
  await writeFile(
    join(sourceRoot, 'package.json'),
    JSON.stringify({ name: '@fixture/plugin-app' }),
  );
  // Keep installation state outside the source without touching global harness config.
  const { defaultWriterLease } = await import(
    '@happyvertical/smrt-app-runtime/sveltekit'
  );
  const runtime = createSmrtSvelteKitRuntime({
    appId: `plugin-${randomUUID()}`,
    sourceRoot,
    dataDirectory: join(root, 'data'),
    runtime: resolveApplicationRuntime({ profile: 'local' }),
    env: Object.fromEntries([
      ...Object.entries(testHomeEnvironment()),
      ['NODE_ENV', 'development'],
      ['HOST', '127.0.0.1'],
    ]),
    acquireWriterLease: (context) => {
      const lease = defaultWriterLease(context);
      released = () => lease.release();
      return lease;
    },
    session: { cookieName: 'sid', cookieSecure: false },
  });
  const member = '@fixture/plugin:PluginMember';
  const task = '@fixture/plugin:PluginTask';
  host = createCookbookHost({
    title: 'plebeos',
    assistant: {
      ai: {
        chat: async (
          _messages: unknown,
          options: {
            tools?: Array<{
              function: NonNullable<
                PluginModeState['tools']
              >[number]['definition'];
            }>;
          },
        ) => {
          assistantDefinitions =
            options.tools?.map((tool) => tool.function) ?? [];
          return { content: 'Catalog inspected.', finishReason: 'stop' };
        },
      } as never,
      onError: (e) => {
        failures.push(String(e));
      },
    },
    runtime,
    root: sourceRoot,
    packageName: '@fixture/plugin-app',
    app: {
      cookbook: {
        $schema: 'https://s-m-r-t.dev/schemas/cookbook/v1.json',
        version: 1,
        recipes: ['plugin.members'],
        features: [],
        policies: [],
      },
      catalog: {
        cookbooks: [
          {
            id: 'empty',
            name: 'Empty',
            document: {
              $schema: 'https://s-m-r-t.dev/schemas/cookbook/v1.json',
              version: 1,
              recipes: [],
              features: [],
              policies: [],
            },
          },
        ],
        models: [
          { id: member, name: 'PluginMember', packageId: 'plugin' },
          { id: task, name: 'PluginTask', packageId: 'plugin' },
        ],
        recipes: [
          {
            id: 'plugin.members',
            label: 'Members',
            models: [member],
            nav: [{ model: member, label: 'Members' }],
            requires: ['plugin.identity'],
          },
          {
            id: 'plugin.identity',
            label: 'Identity prerequisite',
            models: [task],
            nav: [],
            requires: [],
          },
          {
            id: 'plugin.tasks',
            label: 'Tasks',
            models: [task],
            nav: [{ model: task, label: 'Tasks' }],
            requires: [],
          },
        ],
      },
    },
  });
  await host.init();
  stateRoot = runtime.applicationStateRoot();
  const local = await runtime.localRuntime();
  const invitation = await local.rotateBootstrapInvitation();
  const owner = await local.claimOwner({
    token: invitation.token,
    name: 'Owner',
    email: 'owner@plugin.test',
  });
  session = owner.sessionId;
  origin = 'http://127.0.0.1:4998';
  // HTTP transport is real; fixture dispatch still uses the normal runtime.handle.
  http = createServer(async (incoming, outgoing) => {
    try {
      if (
        incoming.method === 'GET' &&
        incoming.url === '/api/_runtime/health'
      ) {
        outgoing.writeHead(200);
        outgoing.end('{}');
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const e = event(
        '/mcp',
        JSON.parse(Buffer.concat(chunks).toString('utf8')),
        false,
      );
      for (const [key, value] of Object.entries(incoming.headers))
        if (typeof value === 'string') e.request.headers.set(key, value);
      const result = await host!.handle({ event: e, resolve: host!.mcp });
      outgoing.writeHead(result.status, Object.fromEntries(result.headers));
      outgoing.end(await result.text());
    } catch (error) {
      failures.push(String(error));
      outgoing.writeHead(500);
      outgoing.end();
    }
  });
  await new Promise<void>((resolve) => http!.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  // Publish the same non-secret origin record the desktop supervisor uses.
  const { writeOriginFile } = await import('@happyvertical/smrt-app-runtime');
  writeOriginFile(runtime.applicationStateRoot(), origin);
  expect(
    (await request('/api/plugin-mode', host.pluginMode, undefined, false))
      .status,
  ).toBe(403);
  const foreign = event('/api/plugin-mode', {
    action: 'connect',
    client: 'codex',
  });
  foreign.request.headers.set('origin', 'https://other.test');
  expect(
    (await host.handle({ event: foreign, resolve: host.pluginMode })).status,
  ).toBe(403);
  for (const action of [
    ['connect'],
    ['revoke'],
    { action: 'connect' },
    null,
    7,
  ]) {
    expect(
      (
        await request('/api/plugin-mode', host.pluginMode, {
          action,
          client: 'codex',
        })
      ).status,
    ).toBe(400);
  }
  expect(await local.mcpTokens!.list()).toEqual([]);
  const setupResponse = await request('/api/plugin-mode', host.pluginMode, {
    action: 'connect',
    client: 'codex',
  });
  expect(setupResponse.status, await setupResponse.clone().text()).toBe(200);
  const settings: PluginModeState = await setupResponse.json();
  const setup = settings.connections.find((c) => c.client === 'codex')!.setup!;
  expect(JSON.stringify(settings).includes('smrt_mcp_')).toBe(false);
  const tokenRecord = (await local.mcpTokens!.list()).find(
    (r) => r.holder === 'plugin-mode:codex',
  )!;
  expect(tokenRecord.scopes).toEqual(['app.plugin']);
  const config = JSON.parse(
    await readFile(
      join(runtime.applicationStateRoot(), 'plugin-mode/codex.json'),
      'utf8',
    ),
  );
  for (const other of ['claude-code', 'claude-desktop'] as const) {
    const connected = await request('/api/plugin-mode', host.pluginMode, {
      action: 'connect',
      client: other,
    });
    expect(connected.status).toBe(200);
    const state: PluginModeState = await connected.json();
    const otherSetup = state.connections.find((c) => c.client === other)!
      .setup!;
    const otherClient = new Client(
      { name: `setup-${other}`, version: '1' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    try {
      await otherClient.connect(
        new StdioClientTransport({
          env: testHomeEnvironment(),
          command: otherSetup.entry.command,
          args: otherSetup.entry.args,
          stderr: 'pipe',
        }),
      );
      const exposure = ObjectRegistry.getExposureModel(member);
      expect(exposure?.qualifiedName).toBe(member);
      expect(
        isRuntimeModelEnabled(exposure, {
          surface: 'assistant',
          tenantId: owner.tenantId,
        }),
      ).toBe(true);
      const publicNames = (await otherClient.listTools()).tools.map(
        (t) => t.name,
      );
      expect(publicNames, publicNames.join(', ')).toContain('members_read');
      payload(
        await otherClient.callTool({
          name: 'members_read',
          arguments: {},
        }),
      );
      await request('/api/plugin-mode', host.pluginMode, {
        action: 'revoke',
        client: other,
      });
      await expect(otherClient.listTools()).rejects.toThrow();
      expect(await runtime.verifyLocalMcpToken(config.token)).not.toBeNull();
    } finally {
      await otherClient.close();
    }
  }
  const transport = new StdioClientTransport({
    env: testHomeEnvironment(),
    command: setup.entry.command,
    args: setup.entry.args,
    stderr: 'pipe',
  });
  let notifications = 0;
  client = new Client(
    { name: 'plugin-fixture', version: '1' },
    {
      versionNegotiation: { mode: { pin: '2026-07-28' } },
      listChanged: {
        tools: {
          onChanged: () => {
            notifications++;
          },
        },
      },
    },
  );
  await client.connect(transport);
  const listed = await client.listTools().catch((error) => {
    throw new Error(String(error) + '; host: ' + failures.join('; '));
  });
  const names = listed.tools.map((t) => t.name);
  expect(names).toContain('members_read');
  expect(names).not.toContain('tasks_read');
  const pluginState = (await request('/api/plugin-mode', host.pluginMode).then(
    (r) => r.json(),
  )) as PluginModeState;
  const assistant = pluginState.tools!;
  expect(names.sort()).toEqual(
    assistant.map((tool) => tool.definition.name).sort(),
  );
  expect(names.some((name) => /plugin_member|plugin_task/.test(name))).toBe(
    false,
  );
  expect(
    assistant
      .filter((tool) => tool.source === 'model')
      .every((tool) => tool.model === member),
  ).toBe(true);
  expect(
    assistant
      .filter((tool) => tool.source === 'model')
      .map((tool) => tool.operation),
  ).toEqual(expect.arrayContaining(['read', 'create', 'delete']));
  for (const tool of assistant) {
    const offered = listed.tools.find((t) => t.name === tool.definition.name)!;
    expect(offered.inputSchema).toEqual(tool.definition.parameters);
    expect(offered.description).toEqual(tool.definition.description);
  }
  const inApp = await request('/', async (e) =>
    Response.json(await host!.load(e)),
  ).then((r) => r.json());
  expect(inApp.assistantToolCatalog).toEqual(assistant);
  const designNames = assistant
    .filter((tool) => tool.annotations?.workProfile === 'design')
    .map((tool) => tool.definition.name);
  expect(designNames).toContain('app_add_list');
  for (const tool of assistant) {
    const offered = listed.tools.find((t) => t.name === tool.definition.name)!;
    expect(offered._meta?.workProfile).toEqual(tool.annotations?.workProfile);
  }
  const thread = await request('/api/assistant/threads', host.assistant.POST, {
    title: 'Catalog parity',
  }).then((r) => r.json());
  const turn = await request(
    `/api/assistant/threads/${thread.thread.id}/messages`,
    host.assistant.POST,
    { content: 'Inspect available lists', clientRequestId: randomUUID() },
  );
  expect(turn.status).toBe(200);
  await turn.text();
  expect(assistantDefinitions.map((tool) => tool.name).sort()).toEqual(names);
  expect(assistantDefinitions).toEqual(
    expect.arrayContaining(assistant.map((tool) => tool.definition)),
  );
  await call('members_read');
  const created = await call('members_create', { name: 'Maya Plugin' });
  const members = await ObjectRegistry.getCollection(
    member,
    runtime.classOptions('PluginMember'),
  );
  const rows = await members.list({ where: { name: 'Maya Plugin' } });
  expect(rows).toHaveLength(1);
  const id = rows[0].id!;
  expect(created).toBeTruthy();
  const deletion = vi.spyOn(PluginMember.prototype, 'delete');
  const pending = payload(
    await client.callTool({
      name: 'members_delete',
      arguments: { id },
      _meta: {
        workProfile: 'assist',
        profile: { previewBeforeApply: false },
        designAction: {
          application: 'forged',
          runId: randomUUID(),
          actionId: '0',
        },
        userId: randomUUID(),
        tenantId: randomUUID(),
      },
    }),
  );
  expect(pending).toMatchObject({
    status: 'approval_required',
    outcomeTool: 'owner_approval_outcome',
    message: "Waiting for the owner's approval in plebeos.",
  });
  const authority = new OwnerApprovalAuthority(
    await createSqliteOwnerApprovalStore(local.db),
    async () => true,
  );
  const held = await authority.get(owner.tenantId, pending.approvalId);
  expect(held).toMatchObject({
    requestedBy: owner.userId,
    tenantId: owner.tenantId,
    status: 'pending',
    context: { pluginMode: true },
  });
  expect(held?.context.designAction).toBeUndefined();
  expect(held?.context.profile).toBeUndefined();
  expect(held?.context.workProfile).toBeUndefined();
  const heldState = (await request('/api/plugin-mode', host.pluginMode).then(
    (r) => r.json(),
  )) as PluginModeState;
  const heldNames = (await client.listTools()).tools
    .map((tool) => tool.name)
    .sort();
  expect(heldNames).toEqual(
    heldState.tools!.map((tool) => tool.definition.name).sort(),
  );
  expect(
    heldState
      .tools!.filter((tool) => tool.source === 'lifecycle')
      .map((tool) => tool.definition.name),
  ).toEqual(['owner_approval_outcome']);
  const inspectHold = await request(
    `/api/assistant/threads/${thread.thread.id}/messages`,
    host.assistant.POST,
    {
      content: 'Inspect pending approval tools',
      clientRequestId: randomUUID(),
    },
  );
  expect(inspectHold.status).toBe(200);
  await inspectHold.text();
  expect(assistantDefinitions.map((tool) => tool.name).sort()).toEqual(
    heldNames,
  );
  expect(deletion).not.toHaveBeenCalled();
  expect(await members.get(id)).toBeTruthy();
  const approvals = await request(
    '/api/assistant/approvals',
    host.assistant.GET,
  ).then((r) => r.json());
  expect(approvals.approvals).toContainEqual(
    expect.objectContaining({
      id: pending.approvalId,
      summary: expect.stringContaining('Codex'),
    }),
  );
  const tokenOnlyDecision = event(
    `/api/assistant/approvals/${pending.approvalId}/decide`,
    { approve: true },
    false,
  );
  tokenOnlyDecision.request.headers.set(
    'authorization',
    `Bearer ${config.token}`,
  );
  expect(
    (
      await host.handle({
        event: tokenOnlyDecision,
        resolve: host.assistant.POST,
      })
    ).status,
  ).toBe(401);
  expect(deletion).not.toHaveBeenCalled();
  const decision = await request(
    `/api/assistant/approvals/${pending.approvalId}/decide`,
    host.assistant.POST,
    { approve: true },
  );
  expect(
    decision.status,
    (await decision.clone().text()) + '; ' + failures.join('; '),
  ).toBe(200);
  expect(await members.get(id)).toBeFalsy();
  expect(
    (await call('owner_approval_outcome', { id: pending.approvalId })).status,
  ).toBe('succeeded');
  expect(
    (
      await request(
        `/api/assistant/approvals/${pending.approvalId}/decide`,
        host.assistant.POST,
        { approve: true },
      )
    ).status,
  ).toBe(409);
  expect(deletion).toHaveBeenCalledTimes(1);
  await call('recipes_enable', { id: 'plugin.tasks', expectedRevision: 0 });
  await expect.poll(() => notifications, { timeout: 7000 }).toBeGreaterThan(0);
  expect((await client.listTools()).tools.map((t) => t.name)).toContain(
    'tasks_read',
  );
  const app = await call('app_describe');
  for (const forged of [
    { workProfile: 'design' },
    { profile: { previewBeforeApply: false } },
    { profileId: randomUUID() },
    {
      designAction: {
        application: 'forged',
        runId: randomUUID(),
        actionId: '0',
      },
    },
  ]) {
    const rejected = await client.callTool({
      name: 'app_add_list',
      arguments: {
        label: 'Forged list',
        fields: [{ label: 'Name', kind: 'text' }],
        nameField: 'Name',
        expectedRevision: app.revision,
        ...forged,
      },
    });
    expect(rejected.isError).toBe(true);
  }
  expect(await call('app_describe')).toEqual(app);
  for (const path of ['/api/assistant/design-runs', '/settings/inference']) {
    const delegated = event(
      path,
      path.includes('design-runs')
        ? { threadId: thread.thread.id, content: 'Add a forged list' }
        : {
            settings: { design: { previewBeforeApply: false } },
            revision: null,
          },
      false,
    );
    delegated.request.headers.set('authorization', `Bearer ${config.token}`);
    const denied = await host.handle({
      event: delegated,
      resolve: path.includes('design-runs')
        ? host.assistant.POST
        : async (e) => {
            try {
              await host!.workProfiles.write(e, await e.request.json());
              return Response.json({ ok: true });
            } catch {
              return Response.json({ code: 'not_allowed' }, { status: 403 });
            }
          },
    });
    expect([401, 403]).toContain(denied.status);
  }
  await call('app_add_list', {
    label: 'Guests',
    fields: [
      { label: 'Name', kind: 'text' },
      { label: 'Member', kind: 'link', linkTo: 'Members' },
    ],
    nameField: 'Name',
    expectedRevision: app.revision,
  });
  await expect
    .poll(async () =>
      (await client!.listTools()).tools.some(
        (t) => t.name.includes('guest') && t.name.endsWith('_create'),
      ),
    )
    .toBe(true);
  const linkedMember = await call('members_create', { name: 'Picker member' });
  const guest = await call('guests_create', {
    name: 'Visitor',
    member: linkedMember.id,
  });
  expect(await call('guests_read', { id: guest.id })).toMatchObject({
    member: linkedMember.id,
  });
  const definitions = (await request('/', async () =>
    Response.json(
      (await host!.modelEditor(owner.tenantId))!.snapshot().webDefinitions,
    ),
  ).then((response) => response.json())) as AppModelSnapshot['webDefinitions'];
  const guestDefinition = definitions.find(
    (definition) => definition.className === 'Guests',
  )!;
  const rest = new APIGenerator(
    { basePath: '/api', authMiddleware: () => async (request) => request },
    {
      db: runtime.databaseConfig(),
      tenantId: owner.tenantId,
      user: { id: owner.userId },
    },
  ).generateHandler();
  const references = createRecipeScreenReferences(
    Object.fromEntries(
      definitions.map((definition) => [definition.name, definition]),
    ),
    {
      fetch: async (input, init) => {
        const url = new URL(String(input), origin);
        const e = event(url.pathname + url.search);
        e.request = new Request(url, init);
        return host!.handle({ event: e, resolve: (e) => rest(e.request) });
      },
    },
  );
  const target = screenReferenceTarget(
    guestDefinition,
    { name: 'member' },
    references,
  )!;
  expect(target.definition.objectRef).toBe(member);
  const picked = await target.source.search!({
    query: 'Picker',
    offset: 0,
    limit: 10,
  });
  expect(screenRecordLabel(target.definition, picked.rows[0])).toBe(
    'Picker member',
  );
  expect(await target.source.get!(String(picked.rows[0].id))).toMatchObject({
    name: 'Picker member',
  });
  const live = (await request('/api/plugin-mode', host.pluginMode).then((r) =>
    r.json(),
  )) as PluginModeState;
  expect(
    (await client.listTools()).tools.map((tool) => tool.name).sort(),
  ).toEqual(live.tools!.map((tool) => tool.definition.name).sort());
  const described = await call('app_describe');
  const removing = await call('app_remove_list', {
    list: 'Guests',
    expectedRevision: described.revision,
  });
  expect(removing).toMatchObject({
    status: 'approval_required',
    outcomeTool: 'owner_approval_outcome',
  });
  expect(
    (
      await request(
        `/api/assistant/approvals/${removing.approvalId}/decide`,
        host.assistant.POST,
        { approve: true },
      )
    ).status,
  ).toBe(200);
  expect(
    (await call('owner_approval_outcome', { id: removing.approvalId })).status,
  ).toBe('succeeded');
  const taskRecipe = await call('recipes_describe', { id: 'plugin.tasks' });
  const disabling = await call('recipes_disable', {
    id: 'plugin.tasks',
    expectedRevision: taskRecipe.recipe.revision,
  });
  expect(disabling.status).toBe('approval_required');
  expect(
    (
      await request(
        `/api/assistant/approvals/${disabling.approvalId}/decide`,
        host.assistant.POST,
        { approve: true },
      )
    ).status,
    failures.join('; '),
  ).toBe(200);
  expect((await client.listTools()).tools.map((t) => t.name)).not.toContain(
    'tasks_read',
  );
  const preview = await call('cookbook_apply', { id: 'empty' });
  const applying = await call('cookbook_apply', {
    id: 'empty',
    apply: true,
    expectedRevision: preview.revision,
    previewToken: preview.previewToken,
  });
  expect(applying.status).toBe('approval_required');
  const applyApprovals = await request(
    '/api/assistant/approvals',
    host.assistant.GET,
  ).then((r) => r.json());
  expect(applyApprovals.approvals).toContainEqual(
    expect.objectContaining({
      id: applying.approvalId,
      summary: expect.stringContaining('Codex'),
    }),
  );
  expect(
    (
      await request(
        `/api/assistant/approvals/${applying.approvalId}/decide`,
        host.assistant.POST,
        { approve: false },
      )
    ).status,
  ).toBe(200);
  expect(
    (await call('owner_approval_outcome', { id: applying.approvalId })).status,
  ).toBe('denied');
  await request('/api/plugin-mode', host.pluginMode, {
    action: 'embed',
    enabled: true,
  });
  expect(
    (
      await request('/', async (e) => Response.json(await host!.load(e))).then(
        (r) => r.json(),
      )
    ).embed,
  ).toBe(true);
  const state = await request('/api/cookbook/prebuilt', host.prebuilt).then(
    (r) => r.json(),
  );
  await request('/api/cookbook/prebuilt', host.prebuilt, {
    enabled: false,
    revision: state.revision,
  });
  const remaining = (await client.listTools()).tools.map((t) => t.name);
  expect(remaining.some((n) => n.startsWith('recipes_'))).toBe(false);
  expect(remaining).not.toContain('members_read');
  expect(remaining).toContain('app_add_list');
  const narrow = await local.mcpTokens!.issue({
    scopes: ['plugin_members.read'],
  });
  expect((await runtime.verifyLocalMcpToken(narrow.token))!.scopes).toEqual([
    'plugin_members.read',
  ]);
  const narrowClient = new Client(
    { name: 'read-only', version: '1' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  try {
    await narrowClient.connect(
      new StreamableHTTPClientTransport(new URL('/mcp', origin), {
        requestInit: { headers: { authorization: `Bearer ${narrow.token}` } },
      }),
    );
    expect(
      (await narrowClient.listTools()).tools.some((t) =>
        t.name.endsWith('_create'),
      ),
    ).toBe(false);
    const refused = await narrowClient
      .callTool({
        name: 'members_create',
        arguments: { name: 'Forbidden' },
      })
      .catch(() => null);
    expect(refused === null || refused.isError === true).toBe(true);
  } finally {
    await narrowClient.close();
  }
  expect(
    (await local.mcpTokens!.list()).find((r) => r.id === tokenRecord.id)!
      .lastUsedAt,
  ).toBeTruthy();
  await request('/api/plugin-mode', host.pluginMode, {
    action: 'revoke',
    client: 'codex',
  });
  expect(await runtime.verifyLocalMcpToken(config.token)).toBeNull();
  await expect(client.listTools()).rejects.toThrow();
  const ownerRoles = await RoleCollection.create({ db: local.db });
  const ownerRole = await ownerRoles.findSystemRoleBySlug(
    DEFAULT_ROLE_SLUGS.OWNER,
  );
  const permissions = await PermissionCollection.create({ db: local.db });
  const readPermission = await permissions.findBySlug('plugin_members.read');
  const grants = await RolePermissionCollection.create({ db: local.db });
  const mixed = await local.mcpTokens!.issue(
    {
      scopes: ['app.plugin', 'plugin_members.read'],
    },
    owner,
  );
  await grants.removePermission(ownerRole!.id!, readPermission!.id!);
  const mixedClient = new Client(
    { name: 'mixed-scopes', version: '1' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  try {
    expect((await runtime.verifyLocalMcpToken(mixed.token))!.scopes).toEqual([
      'app.plugin',
    ]);
    await mixedClient.connect(
      new StreamableHTTPClientTransport(new URL('/mcp', origin), {
        requestInit: { headers: { authorization: `Bearer ${mixed.token}` } },
      }),
    );
    expect(
      (await mixedClient.listTools()).tools.map((t) => t.name),
    ).not.toContain('app_add_list');
  } finally {
    await mixedClient.close();
    await grants.addPermission(ownerRole!.id!, readPermission!.id!);
  }
  const liveOwnerToken = await local.mcpTokens!.issue(
    { scopes: ['app.plugin'] },
    owner,
  );
  const liveOwnerClient = new Client(
    { name: 'owner-binding', version: '1' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  await liveOwnerClient.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', origin), {
      requestInit: {
        headers: { authorization: `Bearer ${liveOwnerToken.token}` },
      },
    }),
  );
  const ownerCatalog = await liveOwnerClient.listTools();
  expect(ownerCatalog.ttlMs).toBe(0);
  expect(ownerCatalog.tools.length).toBeGreaterThan(0);
  try {
    const tenants = await TenantCollection.create({ db: local.db });
    const second = await tenants.create({ name: 'Other owner', slug: 'other' });
    await second.save();
    const roles = await RoleCollection.create({ db: local.db });
    const role = await roles.findSystemRoleBySlug(DEFAULT_ROLE_SLUGS.OWNER);
    const memberships = await MembershipCollection.create({ db: local.db });
    const extra = await memberships.create({
      userId: owner.userId,
      tenantId: second.id!,
      roleId: role!.id!,
    });
    await extra.save();
    expect((await request('/api/plugin-mode', host.pluginMode)).status).toBe(
      403,
    );
    expect(
      (
        await request('/api/plugin-mode', host.pluginMode, {
          action: 'connect',
          client: 'codex',
        })
      ).status,
    ).toBe(403);
    await expect(liveOwnerClient.listTools()).rejects.toThrow();
  } finally {
    await liveOwnerClient.close();
  }
}, 180000);
