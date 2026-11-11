/** Regression for the exact empty-phone payload submitted after template onboarding. */
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultWriterLease } from '@happyvertical/smrt-app-runtime/sveltekit';
import { readAssistantTurnStream } from '@happyvertical/smrt-chat/assistant-turn';
import { resolveApplicationRuntime } from '@happyvertical/smrt-config';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { generateActivationRegistration } from '@happyvertical/smrt-core/activation/generate';
import { BUNDLED_COOKBOOK_TEMPLATES } from '@happyvertical/smrt-core/cookbook/tools';
import {
  modelReplacements,
  type SmartObjectManifest,
} from '@happyvertical/smrt-core/manifest';
import { generateSvelteKitRoutes } from '@happyvertical/smrt-core/vite-plugin';
import type { Profile } from '@happyvertical/smrt-profiles';
import { catalogFromManifests } from '@happyvertical/smrt-svelte/cookbook/server';
import { disableTenancy, withTenant } from '@happyvertical/smrt-tenancy';
import type { RequestEvent } from '@sveltejs/kit';
import { build } from 'esbuild';
import { afterEach, expect, it } from 'vitest';
import { createCookbookApplication } from '../host/server.js';

const APP = '@fixture/onboard';
const origin = 'http://127.0.0.1:4964';
let root: string;
let host: ReturnType<typeof createCookbookApplication> | undefined;
let release: (() => void) | undefined;
let db:
  | Awaited<ReturnType<NonNullable<typeof host>['runtime']['database']>>
  | undefined;
let sessionId: string;

afterEach(async () => {
  host?.dispose();
  await db?.close?.();
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
    params: { path: path.replace('/api/assistant/', '') },
    locals: {},
    cookies: {
      get: (name: string) => (name === 'sid' ? sessionId : undefined),
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
  BUNDLED_COOKBOOK_TEMPLATES,
)('creates a typed contact through generated REST and assistant after fresh $id onboarding with lazy activation', async (template) => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'smrt-onboard-write-'));
  const packages = resolve(import.meta.dirname, '../..');
  const manifests: SmartObjectManifest[] = [];
  mkdirSync(join(root, 'node_modules/@happyvertical'), { recursive: true });
  for (const directory of readdirSync(packages)) {
    const pkg = join(packages, directory);
    if (!existsSync(join(pkg, 'package.json'))) continue;
    const info = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
    if (!info.name?.startsWith('@happyvertical/')) continue;
    symlinkSync(pkg, join(root, 'node_modules', info.name));
    const file = join(pkg, 'dist/manifest.json');
    if (existsSync(file))
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
    mkdirSync(dirname(sourceFile), { recursive: true });
    writeFileSync(
      sourceFile,
      `import {smrt} from '@happyvertical/smrt-core';
import {${name} as Base} from '@happyvertical/smrt-${pkg}';
@smrt({packageName:'${APP}',name:'${name}'}) export class ${name} extends Base {}
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
  const errors: unknown[] = [];
  host = createCookbookApplication({
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
          if (creatingMember && toolCalls++ === 0) {
            expect(
              options?.tools?.some(
                (t: { function: { name: string } }) =>
                  t.function.name === 'customers-create',
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
                    name: 'customers-create',
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
  });
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
  expect(progress.approval.status).toBe('pending');
  const approved = await request(
    `/api/assistant/approvals/${progress.approvalId}/decide`,
    (e) => host!.assistant.handle(e),
    { approve: true },
  );
  expect(approved.status, await approved.clone().text()).toBe(200);
  // The cookbook starts empty: only approving cookbook.apply enables commerce.
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
  // Shared create forms serialize untouched optional text controls as ''.
  const made = await request('/api/customers', route.POST, {
    name: 'REST Ada',
    email: 'rest@example.test',
    phone: '',
  });
  expect(made.status, await made.clone().text()).toBe(201);
  const thread = await request(
    '/api/assistant/threads',
    (e) => host!.assistant.handle(e),
    { title: 'Create a member' },
  );
  expect(thread.status, await thread.clone().text()).toBe(201);
  const id = (await thread.json()).thread.id;
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
      ['REST Ada', 'rest@example.test'],
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
}, 120_000);
