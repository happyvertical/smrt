/** Regression for the exact empty-phone payload submitted after template onboarding. */
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultWriterLease } from '@happyvertical/smrt-app-runtime/sveltekit';
import type { AssistantApprovalView } from '@happyvertical/smrt-chat/assistant-turn';
import type { AssistantMessageWire } from '@happyvertical/smrt-chat/sveltekit';
import { readAssistantTurnStream } from '@happyvertical/smrt-chat/assistant-turn';
// Keep external provider registrations in the snapshot: Node caches these
// modules across generated app fixtures while each app subclass is loaded anew.
import '@happyvertical/smrt-commerce';
import '@happyvertical/smrt-profiles';
import { resolveApplicationRuntime } from '@happyvertical/smrt-config';
import { ObjectRegistry, toSnakeCase } from '@happyvertical/smrt-core';
import { resolveManifestPath } from '@happyvertical/smrt-core/manifest/discover-smrt-packages';
import { createActivationCoordinator } from '@happyvertical/smrt-core/activation';
import { generateActivationRegistration } from '@happyvertical/smrt-core/activation/generate';
import { BUNDLED_COOKBOOK_TEMPLATES } from '@happyvertical/smrt-core/cookbook/tools';
import {
  modelReplacements,
  type SmartObjectManifest,
} from '@happyvertical/smrt-core/manifest';
import { generateSvelteKitRoutes } from '@happyvertical/smrt-core/vite-plugin';
import { snapshotObjectRegistryState } from '@happyvertical/smrt-core/testing';
import type { Profile } from '@happyvertical/smrt-profiles';
import { catalogFromManifests, buildCookbookShell } from '@happyvertical/smrt-svelte/cookbook/server';
import { disableTenancy, withTenant } from '@happyvertical/smrt-tenancy';
import type { RequestEvent } from '@sveltejs/kit';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { build } from 'esbuild';
import { afterEach, expect, it, vi } from 'vitest';
import {
  readWorkspacePackages,
  workspaceClosure,
} from '../../smrt-desktop/wrapper/scripts/build-desktop-app.mjs';
import { createCookbookApplication, createCookbookHost } from '../host/server.js';
import { createCookbookHostState } from '../host/state.js';

const APP = '@fixture/onboard';
const origin = 'http://127.0.0.1:4996';
let root: string;
let host: ReturnType<typeof createCookbookApplication> | undefined;
let release: (() => void) | undefined;
let db:
  | Awaited<ReturnType<NonNullable<typeof host>['runtime']['database']>>
  | undefined;
const retainedDatabases = new Set<NonNullable<typeof db>>();
let sessionId: string;
let restoreRegistry: (() => void) | undefined;

afterEach(async () => {
  await host?.shutdown();
  host?.dispose();
  if (db) retainedDatabases.add(db);
  await Promise.all([...retainedDatabases].map((database) => database.close?.()));
  retainedDatabases.clear();
  release?.();
  disableTenancy();
  delete (globalThis as Record<string, unknown>).__onboardingRuntime;
  if (root) {
    rmSync(root, { recursive: true, force: true });
    rmSync(`${root}-data`, { recursive: true, force: true });
  }
  host = undefined;
  db = undefined;
  release = undefined;
  restoreRegistry?.();
  restoreRegistry = undefined;
});

function event(path: string, method = 'GET', body?: unknown): RequestEvent {
  const url = new URL(path, origin);
  return {
    url,
    request: new Request(url, {
      method,
      headers: { origin, host: url.host, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    params: { path: url.pathname.replace('/api/assistant/', '') },
    locals: {},
    cookies: {
      get: (name: string) => (name === host?.runtime.sessionCookie.name ? sessionId : undefined),
      getAll: () => [],
    },
    getClientAddress: () => '127.0.0.1',
  } as unknown as RequestEvent;
}
function request(
  path: string,
  handler: (e: RequestEvent) => unknown,
  body?: unknown,
) {
  return host!.handle({
    event: event(path, body === undefined ? 'GET' : 'POST', body),
    resolve: async (e) => (await handler(e)) as Response,
  });
}

it.each(
  BUNDLED_COOKBOOK_TEMPLATES.flatMap((template) =>
    (template.id === 'mechanic' ? ['mcp', 'design'] : ['none']).map(
      (structuralPath) => ({ ...template, structuralPath }),
    ),
  ),
)('creates a typed contact through generated REST and assistant after fresh $id onboarding with lazy activation ($structuralPath)', async (template) => {
  restoreRegistry = snapshotObjectRegistryState();
  root = mkdtempSync(join(realpathSync(tmpdir()), 'smrt-onboard-write-'));
  const workspace = readWorkspacePackages(resolve(import.meta.dirname, '../../..'));
  const fixtureManifest = JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8'),
  );
  const manifests: SmartObjectManifest[] = [];
  mkdirSync(join(root, 'node_modules/@happyvertical'), { recursive: true });
  // Model an installed test runtime, not every unrelated package in the checkout.
  for (const name of workspaceClosure(workspace, fixtureManifest)) {
    const { dir: pkg, json: info } = workspace.get(name)!;
    symlinkSync(pkg, join(root, 'node_modules', info.name));
    const file = resolveManifestPath(info.name, root);
    if (file)
      manifests.push(JSON.parse(readFileSync(file, 'utf8')));
  }
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: APP, type: 'module' }),
  );
  const objects: SmartObjectManifest['objects'] = {};
  for (const manifest of manifests)
    for (const [id, object] of Object.entries(manifest.objects)) {
      if (object.packageName === manifest.packageName) objects[id] = object;
    }
  for (const [pkg, name] of [
    ['commerce', 'Customer'],
    ['profiles', 'Profile'],
    ['profiles', 'ProfileType'],
  ]) {
    const parent = `@happyvertical/smrt-${pkg}:${name}`;
    // Separate files match the generated app: booting identity must not import Customer.
    const sourceFile = join(root, `src/lib/models/${name}.ts`);
    const presentation = name === 'Customer'
      ? ",display:{list:['status','email','phone'],label:{via:'profileId',field:'name',fallback:'Unnamed customer'}},api:{include:['list','get','create','update']},mcp:{include:['list','get','create','update']}"
      : '';
    mkdirSync(dirname(sourceFile), { recursive: true });
    writeFileSync(
      sourceFile,
      `import {smrt} from '@happyvertical/smrt-core';
import {${name} as Base} from '@happyvertical/smrt-${pkg}';
@smrt({packageName:'${APP}',name:'${name}'${presentation}}) export class ${name} extends Base {}
`,
    );
    objects[`${APP}:${name}`] = {
      ...objects[parent],
      packageName: APP,
      qualifiedName: `${APP}:${name}`,
      filePath: sourceFile,
      extends: name,
      extendsQualified: parent,
    };
  }
  const manifest: SmartObjectManifest = {
    version: '1',
    timestamp: 0,
    packageName: APP,
    objects,
  };
  for (const [id, effective] of modelReplacements(manifest))
    objects[id] = { ...objects[id], replacedBy: effective };
  const catalog = catalogFromManifests(
    manifests.map((m) => ({
      packageName: m.packageName!,
      recipes: m.recipes,
      objects: Object.fromEntries(
        Object.entries(m.objects).map(([id, object]) => [
          id,
          { ...object, decoratorConfig: { ...object.decoratorConfig } },
        ]),
      ),
    })),
  );
  const server = join(root, 'src/lib/server');
  mkdirSync(server, { recursive: true });
  const registration = generateActivationRegistration(manifest, {
    projectRoot: root,
    outputDir: server,
  });
  writeFileSync(join(server, 'smrt-register.ts'), registration.source);
  const compile = async (entry: string, output: string) => {
    await build({
      entryPoints: [entry],
      outfile: output,
      bundle: true,
      packages: 'external',
      format: 'esm',
      platform: 'node',
      tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
      alias: {
        $lib: join(root, 'src/lib'),
        '@sveltejs/kit': resolve(
          import.meta.dirname,
          'setup/sveltejs-kit-stub.ts',
        ),
      },
    });
    return import(pathToFileURL(output).href);
  };
  const activation = await compile(
    join(server, 'smrt-register.ts'),
    join(root, 'registration.mjs'),
  );
  const imported = new Set<string>();
  const loaders = Object.fromEntries(
    Object.entries(
      activation.activationLoaders as Record<string, () => Promise<unknown>>,
    ).map(([id, load]) => [
      id,
      async () => {
        imported.add(id);
        return load();
      },
    ]),
  );
  const customerModule = registration.manifest.models[`${APP}:Customer`].module;
  let toolCalls = 0;
  let creatingMember = false;
  let designOutput: Record<string, unknown> | undefined;
  let designCalls = 0;
  let memberCreateName = '';
  const errors: unknown[] = [];
  const hostOptions: Parameters<typeof createCookbookApplication>[0] = {
    root,
    title: 'Onboarding regression',
    packageName: APP,
    onboarding: true,
    app: {
      cookbook: {
        $schema: 'https://s-m-r-t.dev/schemas/cookbook/v1.json',
        version: 1,
        recipes: [],
        features: [],
        policies: [],
      },
      catalog: {
        ...catalog,
        recipes: catalog.recipes.map((r) => ({
          ...r,
          requires: r.requires ?? [],
        })),
      },
    },
    lazyActivation: {
      manifest: activation.activationManifest,
      loaders,
      scope: randomUUID(),
      alwaysOn: Object.keys(activation.activationManifest.models).filter((id) =>
        /^@happyvertical\/smrt-(users|profiles|tenancy|chat|approvals|preferences|inference|secrets|jobs):/.test(id),
      ),
    },
    runtimeOptions: {
      sourceRoot: root,
      dataDirectory: `${root}-data`,
      runtime: resolveApplicationRuntime({ profile: 'local' }),
      env: { NODE_ENV: 'development', HOST: '127.0.0.1' },
      acquireWriterLease(context) {
        const lease = defaultWriterLease(context);
        release = () => lease.release();
        return lease;
      },
    },
    assistant: {
      ai: {
        chat: async (
          _messages: unknown,
          options: { tools?: Array<{ function: { name: string } }> },
        ) => {
          if (designOutput) {
            designCalls++;
            expect(options.tools?.some((tool) => /app_add|recipes_enable/.test(tool.function.name))).toBe(false);
            return { content: JSON.stringify(designOutput), finishReason: 'stop' };
          }
          if (creatingMember && toolCalls++ === 0) {
            expect(
              options?.tools?.some(
                (t: { function: { name: string } }) =>
                  t.function.name === memberCreateName,
              ),
            ).toBe(true);
            return {
              content: '',
              finishReason: 'tool_calls',
              toolCalls: [
                {
                  id: randomUUID(),
                  type: 'function',
                  function: {
                    name: memberCreateName,
                    arguments: JSON.stringify({
                      name: 'Assistant Ada',
                      email: 'assistant@example.test',
                      phone: '',
                    }),
                  },
                },
              ],
            };
          }
          return { content: 'Created.', finishReason: 'stop' };
        },
      } as never,
      onError: (error) => errors.push(error),
    },
  };
  host = createCookbookApplication(hostOptions);
  await host.init();
  db = await host.runtime.database();
  const local = await host.runtime.localRuntime();
  const invitation = await local.rotateBootstrapInvitation();
  const owner = await local.claimOwner({
    token: invitation.token,
    name: 'Owner',
    email: 'owner@example.test',
  });
  sessionId = owner.sessionId;
  expect(imported.has(customerModule)).toBe(false);
  const before = await request(
    '/',
    async (e) => new Response(JSON.stringify(await host!.load(e))),
  );
  expect((await before.json()).enabledModels).not.toContain(`${APP}:Customer`);
  expect(imported.has(customerModule)).toBe(false);
  let progress = await (
    await request('/api/onboarding', host.onboarding)
  ).json();
  for (const [action, extra] of [
    ['welcome', {}],
    ['skip', {}],
    ['preview', { id: template.id }],
    ['apply', {}],
  ] as const) {
    const response = await request('/api/onboarding', host.onboarding, {
      action,
      revision: progress.revision,
      ...extra,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    progress = await response.json();
  }
  expect(progress).toMatchObject({ completed: true, step: 'done', approvalId: null, approval: null });
  // The empty app needs only Use this template; successful apply enables commerce.
  const loaded = await request(
    '/',
    async (e) => new Response(JSON.stringify(await host!.load(e))),
  );
  expect((await loaded.json()).enabledModels).toContain(`${APP}:Customer`);
  expect(imported.has(customerModule)).toBe(true);
  (globalThis as Record<string, unknown>).__onboardingRuntime = host.runtime;
  writeFileSync(
    join(server, 'smrt.ts'),
    'export const runtime = globalThis.__onboardingRuntime;',
  );
  await generateSvelteKitRoutes(
    root,
    {
      ...manifest,
      objects: { [`${APP}:Customer`]: manifest.objects[`${APP}:Customer`] },
    },
    {
      enabled: true,
      lazyActivation: true,
      routesDir: 'src/routes/api',
      objectsDir: 'src/lib/models',
      configPath: 'src/lib/server',
      configFileName: 'smrt.ts',
    },
    manifest,
    undefined,
    manifest,
  );
  const route = await compile(
    join(root, 'src/routes/api/customers/+server.ts'),
    join(root, 'customer-route.mjs'),
  );
  // Only Name is filled; the shared form serializes untouched contacts as ''.
  const made = await request('/api/customers', route.POST, {
    name: 'REST Ada',
    email: '',
    phone: '',
  });
  expect(made.status, await made.clone().text()).toBe(201);
  const created = await made.json();
  const itemRoute = await compile(join(root, 'src/routes/api/customers/[id]/+server.ts'), join(root, 'customer-item-route.mjs'));
  const itemRequest = async (method: 'GET' | 'PUT', values?: unknown) => {
    const e = event(`/api/customers/${created.id}`, method, values);
    e.params = { id: created.id };
    return host!.handle({ event: e, resolve: (requestEvent) => itemRoute[method](requestEvent) });
  };
  expect((await (await itemRequest('GET')).json()).name).toBe('REST Ada');
  const edited = await itemRequest('PUT', { name: 'REST Ada Edited', email: 'edited@example.test', phone: '555-0109' });
  expect(edited.status, await edited.clone().text()).toBe(200);
  const listing = await request('/api/customers?orderBy=email%20ASC', route.GET);
  expect(listing.status, await listing.clone().text()).toBe(200);
  const listed = await listing.json();
  expect(listed.items ?? listed.data ?? listed).toEqual(expect.arrayContaining([expect.objectContaining({ id: created.id, name: 'REST Ada Edited', email: 'edited@example.test', phone: '555-0109' })]));
  expect(await (await itemRequest('GET')).json()).toMatchObject({ name: 'REST Ada Edited', email: 'edited@example.test', phone: '555-0109' });
  const cleared = await itemRequest('PUT', { name: 'REST Ada', email: '', phone: '' });
  expect(cleared.status, await cleared.clone().text()).toBe(200);
  expect(await (await itemRequest('GET')).json()).toMatchObject({ name: 'REST Ada', email: '', phone: '' });
  const clearedList = await request('/api/customers', route.GET);
  const clearedRows = await clearedList.json();
  expect(clearedRows.items ?? clearedRows.data ?? clearedRows).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'REST Ada', email: '', phone: '' })]));
  // Retain the original populated-email create case alongside name-only first.
  const contact = await request('/api/customers', route.POST, {
    name: 'REST Contact', email: 'rest@example.test', phone: '',
  });
  expect(contact.status, await contact.clone().text()).toBe(201);
  const thread = await request(
    '/api/assistant/threads',
    (e) => host!.assistant.handle(e),
    { title: 'Create a member' },
  );
  expect(thread.status, await thread.clone().text()).toBe(201);
  const id = (await thread.json()).thread.id;
  const shell = buildCookbookShell(await host!.cookbookApp(owner.tenantId));
  const memberEntry = [...shell.entries.values()].find(entry =>
    ObjectRegistry.getClass(entry.model.id)?.qualifiedName === ObjectRegistry.getClass('@fixture/onboard:Customer')?.qualifiedName)!;
  expect(memberEntry).toBeTruthy();
  memberCreateName = `${toSnakeCase(memberEntry.label).replace(/[^a-z0-9_]/g, '_')}_create`;
  creatingMember = true;
  const turn = await request(
    `/api/assistant/threads/${id}/messages`,
    (e) => host!.assistant.handle(e),
    { content: 'Create Assistant Ada', clientRequestId: randomUUID() },
  );
  expect(turn.status, turn.status === 200 ? '' : await turn.text()).toBe(200);
  const events: unknown[] = [];
  await readAssistantTurnStream(turn, (e) => events.push(e));
  expect(errors).toEqual([]);
  expect(
    events.some((e) => (e as { type?: string }).type === 'error'),
    JSON.stringify(events),
  ).toBe(false);
  expect(toolCalls).toBeGreaterThan(1);
  await withTenant({ tenantId: owner.tenantId }, async () => {
    const customers = await ObjectRegistry.getCollection(`${APP}:Customer`, {
      db,
    });
    const rows = await customers.list({ displayLabel: true });
    const profiles = await ObjectRegistry.getCollection<Profile>(
      `${APP}:Profile`,
      { db },
    );
    for (const [label, email] of [
      ['REST Ada', ''],
      ['REST Contact', 'rest@example.test'],
      ['Assistant Ada', 'assistant@example.test'],
    ]) {
      const row = rows.find((row) => row.toJSON().displayLabel === label);
      expect(row).toBeDefined();
      const profile = await profiles.get(String(row!.toJSON().profileId), {
        cache: false,
      });
      expect(profile?.toJSON()).toMatchObject({
        name: label,
        email,
        tenantId: owner.tenantId,
      });
      expect(await profile?.getTypeSlug()).toBe('person');
      expect(await profile?.getMetadata()).not.toHaveProperty('phone');
    }
    expect(rows.map((row) => row.toJSON())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          displayLabel: 'REST Ada',
          tenantId: owner.tenantId,
        }),
        expect.objectContaining({
          displayLabel: 'Assistant Ada',
          tenantId: owner.tenantId,
        }),
      ]),
    );
  });
  if (template.structuralPath !== 'none') {
    const generatedGet = vi.fn(async (e: RequestEvent): Promise<Response> => route.GET(e));
    const baseline = await request('/api/customers', generatedGet);
    expect(baseline.status, await baseline.clone().text()).toBe(200);
    expect(generatedGet).toHaveBeenCalledTimes(1);
    const initialRows = await baseline.json();
    const initialIds = (initialRows.items ?? initialRows.data ?? initialRows).map((row: { id: string }) => row.id).sort();
    expect(initialIds).toHaveLength(3);
    let editor: Awaited<ReturnType<NonNullable<typeof host>['modelEditor']>>;
    await request('/settings', async () => {
      editor = await host!.modelEditor(owner.tenantId);
      return new Response();
    });
    const initial = editor!.snapshot();
    const definition = initial.webDefinitions.find((entry) => entry.name === 'customers')!;
    const initialColumns = definition.listFields;
    expect(initialColumns).toEqual(['status', 'email', 'phone']);
    expect(definition.displayLabelField).toBe('displayLabel');
    expect(definition.displayLabelProjection).toBeDefined();
    const api = structuredClone(ObjectRegistry.getConfig(`${APP}:Customer`).api);
    const exposure = structuredClone(initial.cookbook.exposure);
    const policies = structuredClone(initial.cookbook.policies);
    const resetToAot = snapshotObjectRegistryState();
    const args = { list: memberEntry.label, label: 'Licence plate', kind: 'text', expectedRevision: initial.revision };
    if (template.structuralPath === 'mcp') {
      // Exercise the existing structural workflow HTTP handler. The product
      // has no structural field-editor UI; do not invent one or bypass the
      // host with editor.apply.
      const edit = await request('/mcp', (e) => {
        e.request.headers.set('accept', 'application/json, text/event-stream');
        e.request.headers.set('mcp-protocol-version', '2026-07-28');
        e.request.headers.set('mcp-method', 'tools/call');
        e.request.headers.set('mcp-name', 'app_add_field');
        return host!.mcp(e);
      }, {
        jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
          name: 'app_add_field', arguments: args,
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
            [CLIENT_INFO_META_KEY]: { name: 'editor-regression', version: '1' },
            [CLIENT_CAPABILITIES_META_KEY]: {},
          },
        },
      });
      expect(edit.status, await edit.clone().text()).toBe(200);
      const result = await edit.json();
      expect(result.error).toBeUndefined();
      expect(result.result.isError).not.toBe(true);
      expect(result.result.structuredContent).toMatchObject({ status: 'ok', revision: initial.revision + 1 });
    } else {
      await request('/settings/inference', async (e) => {
        const saved = await host!.workProfiles.read(e);
        expect((await host!.workProfiles.write(e, {
          settings: { design: { previewBeforeApply: true, budgets: { passes: 3 } } },
          revision: saved.revision,
        })).ok).toBe(true);
        return new Response();
      });
      designOutput = { summary: 'Add Licence plate to Customers.', personSummary: 'I’m checking the requested changes.', checks: ['Customers exists.'], ready: true,
        operations: [{ tool: 'app.addField', args }] };
      const admitted = await request('/api/assistant/design-runs', host.assistant.POST,
        { threadId: id, content: 'Add a licence plate field to Customers.' });
      expect(admitted.status, await admitted.clone().text()).toBe(202);
      const runId = (await admitted.json()).run.runId;
      await vi.waitFor(async () => {
        const status = await request(`/api/assistant/design-runs?threadId=${id}`, host!.assistant.GET);
        expect((await status.json()).run.status).toBe('waiting-approval');
      }, { timeout: 15000 });
      const pending = await (await request(`/api/assistant/threads/${id}/approvals`, host.assistant.GET)).json();
      expect(pending.approvals).toHaveLength(1);
      expect(pending.approvals[0].summary).toContain('Licence plate');
      expect(pending.approvals[0].summary).toContain('Customers');
      expect(pending.approvals[0].tool).toBe('change');
      const heldMessages = await request(`/api/assistant/threads/${id}/messages`, host.assistant.GET);
      expect(heldMessages.status).toBe(200);
      const heldCards = (await heldMessages.json()).items.filter((message: AssistantMessageWire) =>
        (message.toolCallData?.approval as AssistantApprovalView | undefined)?.id === pending.approvals[0].id,
      );
      expect(heldCards).toHaveLength(1);
      const approvalMessageId = heldCards[0].id;
      expect(heldCards[0]).toMatchObject({ role: 'tool', threadId: id });
      expect(heldCards[0].toolCallData.approval).toMatchObject({
        id: pending.approvals[0].id, tool: 'change',
        callId: pending.approvals[0].id, status: 'pending',
      });
      expect(Object.keys(heldCards[0].toolCallData)).toEqual(['approval']);
      expect(/"(args|context|designAction|requestKey|result)"\s*:/.test(JSON.stringify(heldCards[0]))).toBe(false);
      expect(editor!.snapshot().revision).toBe(initial.revision);
      const decision = await request(`/api/assistant/approvals/${pending.approvals[0].id}/decide`, host.assistant.POST, { approve: true });
      expect(decision.status, await decision.clone().text()).toBe(200);
      await vi.waitFor(async () => {
        const status = await request(`/api/assistant/design-runs?threadId=${id}`, host!.assistant.GET);
        expect((await status.json()).run.status).toBe('done');
      }, { timeout: 15000 });
      const checkpoint = JSON.parse(String((await db!.query('SELECT payload FROM _smrt_inference_design_runs WHERE id = ?', runId)).rows[0].payload));
      expect(checkpoint.outputs).toHaveLength(3);
      const completedMessages = await request(`/api/assistant/threads/${id}/messages`, host.assistant.GET);
      expect(completedMessages.status).toBe(200);
      const completedCards = (await completedMessages.json()).items.filter((message: AssistantMessageWire) =>
        (message.toolCallData?.approval as AssistantApprovalView | undefined)?.id === pending.approvals[0].id,
      );
      expect(completedCards).toHaveLength(1);
      expect(completedCards[0]).toMatchObject({
        id: approvalMessageId, role: 'tool', threadId: id,
        toolCallData: { approval: {
          id: pending.approvals[0].id, callId: pending.approvals[0].id, status: 'succeeded',
        } },
      });
      expect(completedCards[0].toolCallData.approval.summary).toContain('Licence plate');
      expect(completedCards[0].toolCallData.approval.summary).toContain('Customers');
      expect(Object.keys(completedCards[0].toolCallData)).toEqual(['approval']);
      expect(/"(args|context|designAction|requestKey|result)"\s*:/.test(JSON.stringify(completedCards[0]))).toBe(false);
      expect(designCalls).toBe(3);
    }
    for (const phase of ['applied', 'reopened']) {
      if (phase === 'reopened') {
        const runtime = host.runtime;
        await host.shutdown();
        host.dispose();
        // The runtime retains ownership of this handle. Keep it alive until
        // both hosts have drained; closing it here invalidates retained
        // runtime/collection references during a same-process reopen.
        retainedDatabases.add(db!);
        // Replay AOT registrations through a new host/editor/worker using the
        // process-owned runtime and activation slot. A genuine process restart
        // is covered by the built-product browser gate.
        resetToAot();
        const replayActivation = createActivationCoordinator({
          ...hostOptions.lazyActivation,
          packageName: APP,
          db: db!,
          readEnabled: async () => (await createCookbookHostState(
            db!, hostOptions.app!.catalog, hostOptions.app!.cookbook,
          )).enabledModelUnion(),
        });
        host = createCookbookHost({
          ...hostOptions, runtime, activation: () => replayActivation,
        });
        db = await host.runtime.database();
        await host.init();
        (globalThis as Record<string, unknown>).__onboardingRuntime = host.runtime;
      }
      generatedGet.mockClear();
      const response = await request('/api/customers', generatedGet);
      expect(response.status, `${phase}: ${await response.clone().text()}`).toBe(200);
      expect(generatedGet).not.toHaveBeenCalled();
      const listed = await response.json();
      const rows = listed.items ?? listed.data ?? listed;
      expect(rows.map((row: { id: string }) => row.id).sort()).toEqual(initialIds);
      expect(rows.find((row: { id: string }) => row.id === created.id)).toMatchObject({ name: 'REST Ada', email: '', phone: '' });
      await request('/settings', async () => {
        editor = await host!.modelEditor(owner.tenantId);
        return new Response();
      });
      const snapshot = editor!.snapshot();
      expect(snapshot.revision).toBe(initial.revision + 1);
      expect(snapshot.cookbook.policies.filter((policy) => policy.fieldName !== 'licencePlate')).toEqual(policies);
      expect(snapshot.cookbook.policies.filter((policy) => policy.fieldName === 'licencePlate')).toEqual([{
        objectRef: '@happyvertical/smrt-commerce:Customer', scopeType: 'app',
        fieldName: 'licencePlate', label: 'Licence plate',
      }]);
      expect(snapshot.cookbook.exposure).toEqual(exposure);
      expect(snapshot.cookbook.models?.lists ?? {}).toEqual(initial.cookbook.models?.lists ?? {});
      const definitions = snapshot.webDefinitions.filter((entry) => entry.name === 'customers');
      expect(definitions).toHaveLength(1);
      expect(definitions[0].objectRef).toBe(`${APP}:Customer`);
      expect(definitions[0].listFields).toEqual([...initialColumns!, 'licencePlate']);
      expect(definitions[0].displayLabelField).toBe('displayLabel');
      expect(definitions[0].displayLabelProjection).toEqual(definition.displayLabelProjection);
      expect(ObjectRegistry.getConfig(`${APP}:Customer`).api).toEqual(api);
      expect(ObjectRegistry.getTableName(`${APP}:Customer`)).toBe('customers');
      const schema = await db!.query('PRAGMA table_info(customers)');
      expect(schema.rows.filter((column) => column.name === 'licence_plate')).toHaveLength(1);
      if (phase === 'applied') {
        const saved = await itemRequest('PUT', { licencePlate: 'T1-123' });
        expect(saved.status, await saved.clone().text()).toBe(200);
      }
      const saved = await itemRequest('GET');
      expect(saved.status, await saved.clone().text()).toBe(200);
      expect(await saved.json()).toMatchObject({ id: created.id, name: 'REST Ada', licencePlate: 'T1-123' });
      expect(designCalls).toBe(template.structuralPath === 'design' ? 3 : 0);
    }
  }
}, 120_000);
