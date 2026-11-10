import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AIClient } from '@happyvertical/ai';
import { clearCache, loadConfig } from '@happyvertical/smrt-config';
import { build } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmrtCollection } from '../collection.js';
import { clearManifestCache } from '../manifest/manifest-loader.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import type { SmartObjectManifest } from '../scanner/types.js';
import { snapshotObjectRegistryState } from '../test-utils.js';
import { generateSvelteKitRoutes } from './sveltekit-generator.js';

// Canonical instance injection prevents provider/env/file configuration fallback.
const fixtureAi = { embed: async () => [] } as unknown as AIClient;

function createManifest(
  projectRoot: string,
  objectFilePath: string,
  include?: string[],
  principalContext = false,
  fields: SmartObjectManifest['objects'][string]['fields'] = {},
): SmartObjectManifest {
  return {
    version: '1',
    timestamp: 0,
    objects: {
      Widget: {
        className: 'Widget',
        name: 'Widget',
        collection: 'widgets',
        qualifiedName: '@test/generated-helper-app:Widget',
        decoratorConfig: {
          api:
            include || principalContext
              ? { ...(include ? { include } : {}), principalContext }
              : true,
        },
        fields,
        filePath: objectFilePath,
        methods: {},
      },
    },
    packageName: '@test/generated-helper-app',
  };
}

function writeWorkspaceTenancyShim(projectRoot: string): void {
  const packageDir = join(
    projectRoot,
    'node_modules',
    '@happyvertical',
    'smrt-tenancy',
  );
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify(
      {
        exports: { '.': './index.js' },
        name: '@happyvertical/smrt-tenancy',
        type: 'module',
        version: '1.0.0',
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(packageDir, 'index.js'),
    [
      'globalThis.__smrtGeneratedTenantContexts ??= [];',
      'export function getCurrentTenant() { return globalThis.__smrtGeneratedActiveTenantContext; }',
      'export function hasTenantContext() { return Boolean(globalThis.__smrtGeneratedActiveTenantContext); }',
      'export function isSuperAdminBypass() { return false; }',
      'export function isTenancyEnabled() { return true; }',
      'export function enterTenantContext(context) {',
      '  globalThis.__smrtGeneratedActiveTenantContext = context;',
      '  globalThis.__smrtGeneratedTenantContexts.push(context);',
      '}',
    ].join('\n'),
  );
}

/**
 * A real `node_modules/@happyvertical/smrt-users` package, so the generated
 * `_resources` route's `import ... from '@happyvertical/smrt-users/sveltekit'`
 * (#2663) both (a) is detected as resolvable by `consumerHasSmrtUsers` and
 * (b) actually resolves and executes when the emitted route is bundled and
 * run — proving the import genuinely works, not just that a file was
 * written.
 */
function writeWorkspaceUsersShim(projectRoot: string): void {
  const packageDir = join(
    projectRoot,
    'node_modules',
    '@happyvertical',
    'smrt-users',
  );
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify(
      {
        exports: {
          './sveltekit': {
            types: './sveltekit.d.ts',
            import: './sveltekit.js',
          },
        },
        name: '@happyvertical/smrt-users',
        type: 'module',
        version: '1.0.0',
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(packageDir, 'sveltekit.js'),
    [
      'globalThis.__smrtGeneratedResourceListOptions ??= [];',
      'export function createResourceListHandler(options) {',
      '  return async () => {',
      '    await options.ensureRegistry();',
      '    globalThis.__smrtGeneratedResourceListOptions.push(options);',
      '    return new Response(JSON.stringify({ resources: [] }), {',
      "      headers: { 'content-type': 'application/json' },",
      '    });',
      '  };',
      '}',
    ].join('\n'),
  );
  writeFileSync(
    join(packageDir, 'sveltekit.d.ts'),
    'export declare function createResourceListHandler(options: { ensureRegistry: () => void | Promise<void>; kebabRoutes?: boolean }): () => Promise<Response>;\n',
  );
}

function writeWorkspaceCoreShim(projectRoot: string): void {
  const packageDir = join(
    projectRoot,
    'node_modules',
    '@happyvertical',
    'smrt-core',
  );
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify(
      {
        exports: {
          '.': './index.js',
        },
        name: '@happyvertical/smrt-core',
        type: 'module',
        version: '1.0.0',
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(packageDir, 'index.js'),
    [
      'globalThis.__smrtGeneratedHelperCalls ??= [];',
      'globalThis.__smrtGeneratedHelperRegistrations ??= [];',
      'export const ObjectRegistry = {',
      '  async getCollection(...args) {',
      '    globalThis.__smrtGeneratedHelperCalls.push(args);',
      '    if (globalThis.__smrtGeneratedCollectionResolver) return globalThis.__smrtGeneratedCollectionResolver(...args);',
      '    if (globalThis.__smrtGeneratedRouteCollection) {',
      '      return globalThis.__smrtGeneratedRouteCollection;',
      '    }',
      "    return { marker: 'collection' };",
      '  },',
      '  registerCollection(...args) {',
      '    return globalThis.__smrtGeneratedCollectionBinding?.(...args);',
      '  },',
      '  registerPackageManifest(manifest) {',
      '    return globalThis.__smrtGeneratedCollectionMetadata?.(manifest);',
      '  },',
      '  register(...args) {',
      '    globalThis.__smrtGeneratedHelperRegistrations.push(args);',
      '  },',
      '};',
      // Conditional-GET helpers the emitted list route imports (#1765). Kept
      // deliberately trivial: these tests assert list bounds and ordering
      // (#2367), not ETag semantics, which conditional-get.spec.ts covers.
      'export function canonicalReadRepresentation(request) { return new URL(request.url).search; }',
      'export function computeTableVersionEtag(version, representation) {',
      "  return 'W/\"' + version + '-' + representation + '\"';",
      '}',
      'export async function getTableVersion() { return 1; }',
      'export function ifNoneMatchHasConcreteMatch() { return false; }',
      'export function ifNoneMatchSatisfied() { return false; }',
      'export function normalizeCustomActionFailure() { return undefined; }',
      // The real route-access helper (#3416): generated routes resolve
      // collections through it over the app's config module.
      `export { createGeneratedCollectionAccess } from ${JSON.stringify(
        fileURLToPath(
          new URL('../generated-collection-access.ts', import.meta.url),
        ),
      )};`,
      'export function normalizeTypedHttpError(error) {',
      "  if (!error || typeof error !== 'object' || !Number.isInteger(error.status) || error.status < 400 || error.status > 499) return undefined;",
      "  const code = typeof error.code === 'string' ? error.code : error.status === 403 ? 'permission_denied' : 'request_rejected';",
      "  const message = typeof error.publicMessage === 'string' && error.publicMessage.length > 0 ? error.publicMessage : error instanceof Error && error.message.length > 0 ? error.message : 'Request rejected';",
      '  return { code, message, ok: false, status: error.status };',
      '}',
    ].join('\n'),
  );
}

function isIgnoredByGit(projectRoot: string, relativePath: string): boolean {
  const result = spawnSync(
    'git',
    ['check-ignore', '--no-index', '--quiet', relativePath],
    { cwd: projectRoot },
  );
  if (result.error) throw result.error;
  return result.status === 0;
}

function initializeGitRepository(projectRoot: string): void {
  const result = spawnSync('git', ['init', '--quiet'], { cwd: projectRoot });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git init failed with status ${result.status}`);
  }
}

describe('generated SvelteKit helper runtime', () => {
  const originalScopedDbGetter = globalThis.__smrtGetRequestScopedDatabase;
  let projectRoot = '';

  beforeEach(async () => {
    (globalThis as Record<string, unknown>).__smrtGeneratedHelperCalls = [];
    (globalThis as Record<string, unknown>).__smrtGeneratedHelperRegistrations =
      [];
    projectRoot = mkdtempSync(join(tmpdir(), 'smrt-sveltekit-helper-'));
    mkdirSync(join(projectRoot, 'src/lib/objects'), {
      recursive: true,
    });
    writeFileSync(
      join(projectRoot, 'package.json'),
      JSON.stringify(
        {
          name: 'generated-helper-app',
          type: 'module',
          version: '1.0.0',
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(projectRoot, 'src/lib/objects/Widget.ts'),
      'export class Widget {}\n',
    );
    writeWorkspaceCoreShim(projectRoot);
    writeWorkspaceTenancyShim(projectRoot);
    const fixtureConfig = join(projectRoot, 'smrt.config.json');
    writeFileSync(
      fixtureConfig,
      JSON.stringify({
        ai: {
          provider: 'openai',
          apiKeyEnv: 'SMRT_AI_API_KEY',
          baseUrl: 'http://127.0.0.1:9',
          model: 'fixture-model',
        },
      }),
    );
    await loadConfig({
      configPath: fixtureConfig,
      searchParents: false,
      cache: false,
    });
    initializeGitRepository(projectRoot);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearCache();

    if (originalScopedDbGetter) {
      globalThis.__smrtGetRequestScopedDatabase = originalScopedDbGetter;
    } else {
      delete globalThis.__smrtGetRequestScopedDatabase;
    }

    rmSync(projectRoot, { force: true, recursive: true });
    projectRoot = '';
    delete (globalThis as Record<string, unknown>).__smrtGeneratedHelperCalls;
    delete (globalThis as Record<string, unknown>)
      .__smrtGeneratedHelperRegistrations;
    delete (globalThis as Record<string, unknown>)
      .__smrtGeneratedRouteCollection;
    delete (globalThis as Record<string, unknown>)
      .__smrtGeneratedTenantContexts;
    delete (globalThis as Record<string, unknown>)
      .__smrtGeneratedActiveTenantContext;
  });

  async function importGeneratedHelper() {
    const objectFilePath = join(projectRoot, 'src/lib/objects/Widget.ts');
    await generateSvelteKitRoutes(
      projectRoot,
      createManifest(projectRoot, objectFilePath),
      {
        configFileName: 'smrt.ts',
        configPath: 'src/lib/server',
        enabled: true,
        objectsDir: 'src/lib/objects',
        routesDir: 'src/routes/api',
      },
    );

    return await import(
      pathToFileURL(join(projectRoot, 'src/lib/server/smrt.ts')).href
    );
  }

  async function bundleGeneratedRoute(routePath: string, outputFile: string) {
    const svelteKitShim = join(projectRoot, 'sveltekit-shim.ts');
    writeFileSync(
      svelteKitShim,
      [
        'export function error(status: number, message: string): never {',
        '  throw Object.assign(new Error(message), { status });',
        '}',
        'export function json(body: unknown, init: ResponseInit = {}): Response {',
        '  return new Response(JSON.stringify(body), init);',
        '}',
      ].join('\n'),
    );
    const bundled = await build({
      bundle: true,
      entryPoints: [join(projectRoot, routePath)],
      format: 'esm',
      plugins: [
        {
          name: 'generated-route-test-aliases',
          setup(pluginBuild) {
            pluginBuild.onResolve({ filter: /^@sveltejs\/kit$/ }, () => ({
              path: svelteKitShim,
            }));
            pluginBuild.onResolve(
              { filter: /^\$lib\/server\/smrt(-register)?$/ },
              (args) => ({
                path: join(
                  projectRoot,
                  `src/lib/server/${args.path.slice(12)}.ts`,
                ),
              }),
            );
          },
        },
      ],
      platform: 'node',
      write: false,
    });
    const outputPath = join(projectRoot, outputFile);
    writeFileSync(outputPath, bundled.outputFiles[0].text);
    return await import(`${pathToFileURL(outputPath).href}?${Date.now()}`);
  }

  async function importGeneratedCollectionPost(principalContext = false) {
    const objectFilePath = join(projectRoot, 'src/lib/objects/Widget.ts');
    await generateSvelteKitRoutes(
      projectRoot,
      createManifest(projectRoot, objectFilePath, ['create'], principalContext),
      {
        configFileName: 'smrt.ts',
        configPath: 'src/lib/server',
        enabled: true,
        objectsDir: 'src/lib/objects',
        routesDir: 'src/routes/api',
      },
    );

    return await bundleGeneratedRoute(
      'src/routes/api/widgets/+server.ts',
      principalContext
        ? 'generated-principal-post-route.mjs'
        : 'generated-post-route.mjs',
    );
  }

  async function importGeneratedItemActionPost() {
    const objectFilePath = join(projectRoot, 'src/lib/objects/Widget.ts');
    const manifest = createManifest(projectRoot, objectFilePath, ['inspect']);
    manifest.objects.Widget.methods = {
      inspect: {
        async: false,
        isStatic: false,
        isPublic: true,
        name: 'inspect',
        parameters: [{ name: 'options', type: 'any', optional: false }],
        returnType: 'Promise<unknown>',
      },
    };
    manifest.objects.Widget.decoratorConfig = {
      api: {
        include: ['inspect'],
        routes: {
          inspect: { method: 'POST', path: 'inspect' },
        },
      },
    };

    await generateSvelteKitRoutes(projectRoot, manifest, {
      configFileName: 'smrt.ts',
      configPath: 'src/lib/server',
      enabled: true,
      objectsDir: 'src/lib/objects',
      routesDir: 'src/routes/api',
    });

    return await bundleGeneratedRoute(
      'src/routes/api/widgets/[id]/inspect/+server.ts',
      'generated-item-action-post-route.mjs',
    );
  }

  async function importGeneratedRuntimeReportAction(
    actionName: 'run' | 'archive',
  ) {
    const objectFilePath = join(projectRoot, 'src/lib/objects/Widget.ts');
    const manifest = createManifest(projectRoot, objectFilePath, [actionName]);
    manifest.objects.Widget.methods = {
      [actionName]: {
        async: true,
        isStatic: false,
        isPublic: true,
        name: actionName,
        parameters:
          actionName === 'archive'
            ? [{ name: 'options', type: 'any', optional: false }]
            : [],
        returnType: 'Promise<unknown>',
      },
    };
    manifest.objects.Widget.decoratorConfig = {
      api: {
        include: [actionName],
        principalContext: true,
        routes: {
          [actionName]: { method: 'POST', path: actionName, scope: 'item' },
        },
      },
      operationPermissions: {
        [actionName]: { action: actionName === 'run' ? 'read' : 'create' },
      },
      tenantScoped: { mode: 'required' },
    };

    await generateSvelteKitRoutes(projectRoot, manifest, {
      configFileName: 'smrt.ts',
      configPath: 'src/lib/server',
      enabled: true,
      objectsDir: 'src/lib/objects',
      routesDir: 'src/routes/api',
    });

    return await bundleGeneratedRoute(
      `src/routes/api/widgets/[id]/${actionName}/+server.ts`,
      `generated-runtime-report-${actionName}-route.mjs`,
    );
  }

  async function importGeneratedCollectionList(
    fields: SmartObjectManifest['objects'][string]['fields'] = {},
  ) {
    const objectFilePath = join(projectRoot, 'src/lib/objects/Widget.ts');
    await generateSvelteKitRoutes(
      projectRoot,
      createManifest(projectRoot, objectFilePath, ['list'], false, fields),
      {
        configFileName: 'smrt.ts',
        configPath: 'src/lib/server',
        enabled: true,
        objectsDir: 'src/lib/objects',
        routesDir: 'src/routes/api',
      },
    );

    return await bundleGeneratedRoute(
      'src/routes/api/widgets/+server.ts',
      'generated-list-route.mjs',
    );
  }

  async function importGeneratedItemDelete() {
    const objectFilePath = join(projectRoot, 'src/lib/objects/Widget.ts');
    await generateSvelteKitRoutes(
      projectRoot,
      createManifest(projectRoot, objectFilePath, ['delete']),
      {
        configFileName: 'smrt.ts',
        configPath: 'src/lib/server',
        enabled: true,
        objectsDir: 'src/lib/objects',
        routesDir: 'src/routes/api',
      },
    );
    return await bundleGeneratedRoute(
      'src/routes/api/widgets/[id]/+server.ts',
      'generated-delete-route.mjs',
    );
  }

  it('prefers the request-scoped database when no explicit db override is provided', async () => {
    const requestScopedDb = {
      type: 'sqlite',
      url: 'request-scoped.db',
    };
    globalThis.__smrtGetRequestScopedDatabase = () => requestScopedDb as never;

    const helper = await importGeneratedHelper();

    await helper.getCollection('Widget');

    expect(
      (globalThis as Record<string, unknown>).__smrtGeneratedHelperCalls,
    ).toEqual([
      [
        'Widget',
        expect.objectContaining({
          db: requestScopedDb,
        }),
      ],
    ]);
  });

  it('keeps explicit db overrides ahead of the request-scoped database', async () => {
    const requestScopedDb = {
      type: 'sqlite',
      url: 'request-scoped.db',
    };
    const explicitDb = {
      type: 'sqlite',
      url: 'explicit.db',
    };
    globalThis.__smrtGetRequestScopedDatabase = () => requestScopedDb as never;

    const helper = await importGeneratedHelper();

    await helper.getCollection('Widget', {
      db: explicitDb,
    });

    expect(
      (globalThis as Record<string, unknown>).__smrtGeneratedHelperCalls,
    ).toEqual([
      [
        'Widget',
        expect.objectContaining({
          db: expect.objectContaining({
            type: 'sqlite',
            url: 'explicit.db',
          }),
        }),
      ],
    ]);
  });

  it('executes emitted POST routes with safe typed 4xx errors and opaque 5xx errors', async () => {
    const route = await importGeneratedCollectionPost();
    const routeCollection = globalThis as Record<string, unknown>;
    routeCollection.__smrtGeneratedRouteCollection = {
      create: async () => {
        throw Object.assign(new Error('tenant=secret-tenant'), {
          code: 'tenant_isolation',
          publicMessage: 'This request is not permitted for the active tenant',
          status: 403,
        });
      },
    };

    const denied = await route.POST({
      locals: { permissions: ['widgets.create'], user: { id: 'user-1' } },
      request: new Request('http://localhost/api/widgets', {
        body: JSON.stringify({ name: 'Widget' }),
        method: 'POST',
      }),
    });
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toEqual({
      error: {
        code: 'tenant_isolation',
        message: 'This request is not permitted for the active tenant',
        ok: false,
        status: 403,
      },
    });

    routeCollection.__smrtGeneratedRouteCollection = {
      create: async () => {
        throw Object.assign(new Error('database secret leaked'), {
          code: 'database_failed',
          status: 500,
        });
      },
    };
    const failed = await route.POST({
      locals: { permissions: ['widgets.create'], user: { id: 'user-1' } },
      request: new Request('http://localhost/api/widgets', {
        body: JSON.stringify({ name: 'Widget' }),
        method: 'POST',
      }),
    });
    expect(failed.status).toBe(500);
    await expect(failed.json()).resolves.toEqual({
      error: 'Internal server error',
    });
  });

  it.each([
    ['absent', undefined, undefined],
    ['null', 'null', null],
    ['empty object', '{}', {}],
    ['populated object', JSON.stringify({ symbol: 'HV' }), { symbol: 'HV' }],
  ])('preserves %s custom POST options in generated routes', async (_label, rawBody, expectedOptions) => {
    const route = await importGeneratedItemActionPost();
    const routeCollection = globalThis as Record<string, unknown>;
    let receivedOptions: unknown = 'not-called';
    routeCollection.__smrtGeneratedRouteCollection = {
      get: async () => ({
        inspect: async (options: unknown) => {
          receivedOptions = options;
          return { received: options };
        },
      }),
    };

    const response = await route.POST({
      locals: { permissions: ['widgets.inspect'], user: { id: 'user-1' } },
      params: { id: 'widget-1' },
      request: new Request('http://localhost/api/widgets/widget-1/inspect', {
        ...(rawBody === undefined
          ? {}
          : { body: rawBody, headers: { 'content-type': 'application/json' } }),
        method: 'POST',
      }),
    });

    expect(response.status).toBe(200);
    expect(receivedOptions).toEqual(expectedOptions);
  });

  it.each([
    'run',
    'archive',
  ] as const)('rejects conflicting ambient authority before generated %s action lookup', async (actionName) => {
    const route = await importGeneratedRuntimeReportAction(actionName);
    let lookups = 0;
    (globalThis as Record<string, unknown>).__smrtGeneratedRouteCollection = {
      get: async () => {
        lookups += 1;
        return { [actionName]: async () => ({ ok: true }) };
      },
    };
    (globalThis as Record<string, unknown>).__smrtGeneratedActiveTenantContext =
      {
        permissions: new Set(['widgets.read', 'widgets.create']),
        tenantId: 'tenant-b',
        userId: 'user-b',
      };

    await expect(
      route.POST({
        locals: {
          permissions: ['widgets.read', 'widgets.create'],
          tenantId: 'tenant-a',
          user: { id: 'user-a' },
        },
        params: { id: 'report-b' },
        request: new Request(
          `http://localhost/api/widgets/report-b/${actionName}`,
          {
            ...(actionName === 'archive'
              ? {
                  body: JSON.stringify({ archived: true }),
                  headers: { 'content-type': 'application/json' },
                }
              : {}),
            method: 'POST',
          },
        ),
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(lookups).toBe(0);
  });

  it.each(
    (['run', 'archive'] as const).flatMap((actionName) =>
      (
        [
          [
            'permissionSet',
            { permissionSet: ['widgets.read', 'widgets.create'] },
          ],
          [
            'smrtPermissions',
            { smrtPermissions: ['widgets.read', 'widgets.create'] },
          ],
          [
            'tenantContext.permissions',
            {
              tenantContext: {
                permissions: new Set(['widgets.read', 'widgets.create']),
              },
            },
          ],
        ] as const
      ).map(([permissionSource, permissionLocals]) => ({
        actionName,
        permissionLocals,
        permissionSource,
      })),
    ),
  )('rejects conflicting ambient authority before generated $actionName lookup with $permissionSource', async ({
    actionName,
    permissionLocals,
  }) => {
    const route = await importGeneratedRuntimeReportAction(actionName);
    let lookups = 0;
    (globalThis as Record<string, unknown>).__smrtGeneratedRouteCollection = {
      get: async () => {
        lookups += 1;
        return { [actionName]: async () => ({ ok: true }) };
      },
    };
    (globalThis as Record<string, unknown>).__smrtGeneratedActiveTenantContext =
      {
        permissions: new Set(['widgets.read', 'widgets.create']),
        tenantId: 'tenant-b',
        userId: 'user-b',
      };

    await expect(
      route.POST({
        locals: {
          ...permissionLocals,
          tenantId: 'tenant-a',
          user: { id: 'user-a' },
        },
        params: { id: 'report-b' },
        request: new Request(
          `http://localhost/api/widgets/report-b/${actionName}`,
          {
            ...(actionName === 'archive'
              ? {
                  body: JSON.stringify({ archived: true }),
                  headers: { 'content-type': 'application/json' },
                }
              : {}),
            method: 'POST',
          },
        ),
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(lookups).toBe(0);
  });

  it('rejects an incomplete generated-action principal before lookup', async () => {
    const route = await importGeneratedRuntimeReportAction('run');
    let lookups = 0;
    (globalThis as Record<string, unknown>).__smrtGeneratedRouteCollection = {
      get: async () => {
        lookups += 1;
        return { run: async () => ({ ok: true }) };
      },
    };
    (globalThis as Record<string, unknown>).__smrtGeneratedActiveTenantContext =
      {
        permissions: new Set(['widgets.read']),
        tenantId: 'tenant-b',
        userId: 'user-b',
      };

    await expect(
      route.POST({
        locals: {
          permissionSet: ['widgets.read'],
          user: { id: 'user-a' },
        },
        params: { id: 'report-b' },
        request: new Request('http://localhost/api/widgets/report-b/run', {
          method: 'POST',
        }),
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(lookups).toBe(0);
  });

  it('preserves verified active context capabilities while refreshing generated-action authority', async () => {
    const route = await importGeneratedRuntimeReportAction('run');
    const database = { marker: 'tenant-database' };
    const user = { id: 'loaded-user' };
    const metadata = { requestId: 'request-1' };
    let actionContext: Record<string, unknown> | undefined;
    (globalThis as Record<string, unknown>).__smrtGeneratedRouteCollection = {
      get: async () => ({
        run: async () => {
          actionContext = (globalThis as Record<string, unknown>)
            .__smrtGeneratedActiveTenantContext as Record<string, unknown>;
          return { ok: true };
        },
      }),
    };
    (globalThis as Record<string, unknown>).__smrtGeneratedActiveTenantContext =
      {
        database,
        metadata,
        permissions: new Set(['stale.permission']),
        superAdminBypass: true,
        tenantId: 'tenant-a',
        user,
        userId: 'user-a',
      };

    const response = await route.POST({
      locals: {
        tenantContext: {
          permissions: new Set(['widgets.read']),
          superAdminBypass: true,
          tenantId: 'tenant-a',
          userId: 'user-a',
        },
        user: { id: 'user-a' },
      },
      params: { id: 'report-a' },
      request: new Request('http://localhost/api/widgets/report-a/run', {
        method: 'POST',
      }),
    });

    expect(response.status).toBe(200);
    expect(actionContext).toMatchObject({
      database,
      metadata,
      superAdminBypass: true,
      tenantId: 'tenant-a',
      user,
      userId: 'user-a',
    });
    expect(actionContext).toBeDefined();
    expect([
      ...((actionContext as Record<string, unknown>)
        .permissions as Set<string>),
    ]).toEqual(['widgets.read']);
  });

  it('rejects an unbound ambient super-admin context before generated-action lookup', async () => {
    const route = await importGeneratedRuntimeReportAction('run');
    let lookups = 0;
    (globalThis as Record<string, unknown>).__smrtGeneratedRouteCollection = {
      get: async () => {
        lookups += 1;
        return { run: async () => ({ ok: true }) };
      },
    };
    (globalThis as Record<string, unknown>).__smrtGeneratedActiveTenantContext =
      {
        permissions: new Set<string>(),
        superAdminBypass: true,
        tenantId: 'tenant-a',
      };

    await expect(
      route.POST({
        locals: {
          permissions: ['widgets.read'],
          tenantId: 'tenant-a',
          user: { id: 'user-a' },
        },
        params: { id: 'report-a' },
        request: new Request('http://localhost/api/widgets/report-a/run', {
          method: 'POST',
        }),
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(lookups).toBe(0);
  });

  it('executes emitted DELETE routes with safe typed 4xx errors and opaque 5xx errors', async () => {
    const route = await importGeneratedItemDelete();
    const routeCollection = globalThis as Record<string, unknown>;
    routeCollection.__smrtGeneratedRouteCollection = {
      get: async () => ({ id: 'foreign-policy' }),
      delete: async () => {
        throw Object.assign(new Error('foreign tenant=secret-tenant'), {
          code: 'tenant_isolation',
          publicMessage: 'This request is not permitted for the active tenant',
          status: 403,
        });
      },
    };

    const denied = await route.DELETE({
      locals: { permissions: ['widgets.delete'], user: { id: 'user-1' } },
      params: { id: 'foreign-policy' },
    });
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toEqual({
      error: {
        code: 'tenant_isolation',
        message: 'This request is not permitted for the active tenant',
        ok: false,
        status: 403,
      },
    });

    routeCollection.__smrtGeneratedRouteCollection = {
      get: async () => ({ id: 'foreign-policy' }),
      delete: async () => {
        throw Object.assign(new Error('database secret leaked'), {
          code: 'database_failed',
          status: 500,
        });
      },
    };
    const failed = await route.DELETE({
      locals: { permissions: ['widgets.delete'], user: { id: 'user-1' } },
      params: { id: 'foreign-policy' },
    });
    expect(failed.status).toBe(500);
    await expect(failed.json()).resolves.toEqual({
      error: 'Internal server error',
    });
  });

  it('uses only trusted session locals to establish opted-in principal context', async () => {
    const route = await importGeneratedCollectionPost(true);
    const routeCollection = globalThis as Record<string, unknown>;
    routeCollection.__smrtGeneratedRouteCollection = {
      create: async () => ({
        toPublicJSON: () => ({ id: 'created-policy' }),
      }),
    };

    const response = await route.POST({
      locals: {
        permissions: ['fields.policy.manage', 'widgets.create'],
        tenantId: 'trusted-tenant',
        user: { id: 'trusted-user' },
      },
      request: new Request('http://localhost/api/widgets', {
        body: JSON.stringify({
          tenantId: 'forged-tenant',
          userId: 'forged-user',
        }),
        method: 'POST',
      }),
    });
    expect(response.status).toBe(201);
    const contexts = (globalThis as Record<string, unknown>)
      .__smrtGeneratedTenantContexts as Array<{
      permissions: Set<string>;
      tenantId: string;
      userId: string;
    }>;
    expect(contexts).toHaveLength(1);
    expect(contexts[0].tenantId).toBe('trusted-tenant');
    expect(contexts[0].userId).toBe('trusted-user');
    expect([...contexts[0].permissions]).toEqual([
      'fields.policy.manage',
      'widgets.create',
    ]);
    expect(JSON.stringify(contexts[0])).not.toContain('forged');
  });

  it.each([
    {
      label: 'named HTTP CLI',
      cli: { include: ['inspect', 'peek', 'submit'] },
    },
    { label: 'REST only with CLI disabled', cli: false as const },
    { label: 'REST only with CLI omitted', cli: undefined },
    {
      label: 'external named HTTP CLI',
      cli: { include: ['inspect', 'peek', 'submit'] },
      external: true,
    },
    {
      label: 'external REST with CLI disabled',
      cli: false as const,
      external: true,
    },
    { label: 'external REST with CLI omitted', cli: undefined, external: true },
  ])('initializes the exact cross-package collection resource without rebuilding its item namespace (#4320): $label', async ({
    cli,
    ...fixture
  }) => {
    const external = 'external' in fixture && fixture.external;
    clearManifestCache();
    const restore = snapshotObjectRegistryState();
    const itemKey = '@fixture/model4320:RouteItem4320';
    const resourceKey = '@fixture/resource4320:RouteResource4320';
    class RouteItem4320 extends SmrtObject {}
    class DecoyItem4320 extends SmrtObject {}
    Object.defineProperty(DecoyItem4320, 'name', { value: 'RouteItem4320' });
    class ItemCollection4320 extends SmrtCollection<RouteItem4320> {
      static readonly _itemClass = RouteItem4320;
    }
    class RouteResource4320 extends ItemCollection4320 {
      async inspect() {
        return { count: await this.count(), receiver: this.constructor.name };
      }
      static async peek() {
        return { receiver: this.name };
      }
      async submit() {
        return { count: await this.count() };
      }
    }
    let db:
      | Awaited<
          ReturnType<typeof import('../testing/database.js')['getTestDatabase']>
        >
      | undefined;
    const state = globalThis as Record<string, unknown>;
    try {
      smrt({
        packageName: '@fixture/model4320',
        tableName: 'route_items_4320',
        collection: 'routeitems4320',
        api: { include: ['list', 'get'] },
      })(RouteItem4320);
      smrt({
        packageName: '@fixture/decoy4320',
        tableName: 'decoy_items_4320',
        api: false,
      })(DecoyItem4320);
      smrt({
        packageName: '@fixture/resource4320',
        collection: 'routeresources4320',
        api: {
          include: ['inspect', 'peek', 'submit'],
          routes: {
            inspect: { method: 'GET' },
            peek: { method: 'GET' },
            submit: { method: 'POST' },
          },
        },
        cli,
      })(RouteResource4320);
      expect(
        ObjectRegistry.getClassByConstructor(RouteItem4320)?.qualifiedName,
      ).toBe(itemKey);
      expect(
        ObjectRegistry.getClassByConstructor(DecoyItem4320)
          ?.collectionConstructor,
      ).toBeUndefined();
      ObjectRegistry.registerCollection(itemKey, ItemCollection4320);
      const { getTestDatabase } = await import('../testing/database.js');
      db = await getTestDatabase({ classes: [itemKey] });
      await db.insert('route_items_4320', {
        id: '00000000-0000-4000-8000-000000004320',
        slug: 'owned',
        context: '',
      });
      const { MCPGenerator } = await import('../generators/mcp.js');
      const resourceTools = async () =>
        (await new MCPGenerator({ classNames: [resourceKey] }).generateTools())
          .map((tool) => tool.name)
          .filter((name) => name.startsWith('routeresource4320_'))
          .sort();
      const previousResourceTools = await resourceTools();
      state.__smrt4320Core = await import('../index.js');
      state.__smrt4320Constructors = {
        RouteItem4320,
        RouteResource4320,
        ItemCollection4320,
      };
      state.__smrt4320Db = db;
      state.__smrt4320Ai = fixtureAi;
      state.__smrt4320FactoryKeys = [];
      state.__smrt4320Instances = [];
      // The emitted module receives the actual core exports and registry, not
      // a mocked factory. It must construct and initialize against this DB.
      writeFileSync(
        join(projectRoot, 'node_modules/@happyvertical/smrt-core/index.js'),
        `export const { ObjectRegistry, createGeneratedCollectionAccess, normalizeCustomActionFailure, normalizeTypedHttpError, canonicalReadRepresentation, computeTableVersionEtag, getTableVersion, ifNoneMatchHasConcreteMatch, ifNoneMatchSatisfied } = globalThis.__smrt4320Core;`,
      );
      const objectFilePath = join(projectRoot, 'src/lib/objects/Widget.ts');
      writeFileSync(
        objectFilePath,
        'export const { RouteItem4320, RouteResource4320, ItemCollection4320 } = globalThis.__smrt4320Constructors;',
      );
      const method = (name: string, isStatic = false) => ({
        name,
        isStatic,
        isPublic: true,
        async: true,
        returnType: 'Promise<unknown>',
        parameters: [],
      });
      const manifest: SmartObjectManifest = {
        version: '1',
        timestamp: 0,
        packageName: '@fixture/resource4320',
        objects: {
          [itemKey]: {
            className: 'RouteItem4320',
            name: 'RouteItem4320',
            qualifiedName: itemKey,
            packageName: '@fixture/model4320',
            collection: 'routeitems4320',
            fields: {},
            methods: {},
            filePath: objectFilePath,
            decoratorConfig: {
              tableName: 'route_items_4320',
              api: { include: ['list', 'get'] },
            },
          },
          '@fixture/model4320:ItemCollection4320': {
            className: 'ItemCollection4320',
            name: 'ItemCollection4320',
            qualifiedName: '@fixture/model4320:ItemCollection4320',
            packageName: '@fixture/model4320',
            collection: 'routeitems4320',
            extends: 'SmrtCollection',
            extendsTypeArg: itemKey,
            fields: {},
            methods: {},
            filePath: objectFilePath,
            decoratorConfig: { api: false },
          },
          [resourceKey]: {
            className: 'RouteResource4320',
            name: 'RouteResource4320',
            qualifiedName: resourceKey,
            packageName: '@fixture/resource4320',
            collection: 'routeresources4320',
            extends: 'ItemCollection4320',
            extendsQualified: '@fixture/model4320:ItemCollection4320',
            fields: {},
            methods: {
              inspect: method('inspect'),
              peek: method('peek', true),
              submit: method('submit'),
            },
            filePath: objectFilePath,
            decoratorConfig: {
              api: {
                include: ['inspect', 'peek', 'submit'],
                routes: {
                  inspect: { method: 'GET' },
                  peek: { method: 'GET' },
                  submit: { method: 'POST' },
                },
              },
              cli,
            },
          },
        },
      };
      if (external) {
        const modelDir = join(projectRoot, 'node_modules/@fixture/model4320');
        const resourceDir = join(
          projectRoot,
          'node_modules/@fixture/resource4320',
        );
        for (const [name, directory, exports] of [
          ['@fixture/model4320', modelDir, 'RouteItem4320, ItemCollection4320'],
          ['@fixture/resource4320', resourceDir, 'RouteResource4320'],
        ]) {
          mkdirSync(join(directory, 'dist'), { recursive: true });
          writeFileSync(
            join(directory, 'package.json'),
            JSON.stringify({
              name,
              version: '1.0.0',
              type: 'module',
              exports: { '.': './index.js' },
            }),
          );
          writeFileSync(
            join(directory, 'index.js'),
            `export const { ${exports} } = globalThis.__smrt4320Constructors;`,
          );
        }
        manifest.packageName = '@test/generated-helper-app';
        manifest.smrtDependencies = ['@fixture/resource4320'];
        for (const [key, definition] of Object.entries(manifest.objects)) {
          definition.filePath = join(
            key === resourceKey ? resourceDir : modelDir,
            'index.js',
          );
        }
        writeFileSync(
          join(resourceDir, 'dist/manifest.json'),
          JSON.stringify({
            ...manifest,
            packageName: '@fixture/resource4320',
          }),
        );
        const { smrtConsumer } = await import('../consumer-plugin/index.js');
        const consumer = smrtConsumer({
          packages: ['@fixture/resource4320'],
          projectRoot,
          generateTypes: false,
          disableScanning: true,
        });
        const hook = consumer.buildStart;
        if (!hook) throw new Error('Consumer buildStart missing');
        const handler = typeof hook === 'function' ? hook : hook.handler;
        await handler.call(
          {} as ThisParameterType<typeof handler>,
          {} as Parameters<typeof handler>[0],
        );
        expect(existsSync(join(projectRoot, '.smrt/register.js'))).toBe(true);
      }
      await generateSvelteKitRoutes(projectRoot, manifest, {
        configFileName: 'smrt.ts',
        configPath: 'src/lib/server',
        enabled: true,
        objectsDir: 'src/lib/objects',
        routesDir: 'src/routes/api',
      });
      writeFileSync(
        join(projectRoot, 'src/lib/server/smrt.ts'),
        `import {ObjectRegistry} from '@happyvertical/smrt-core'; export const runtime = { classOptions(){ return {db:globalThis.__smrt4320Db,ai:globalThis.__smrt4320Ai}; }, async getCollection(name){ globalThis.__smrt4320FactoryKeys.push(name); const value = await ObjectRegistry.getCollection(name,{db:globalThis.__smrt4320Db,ai:globalThis.__smrt4320Ai}); globalThis.__smrt4320Instances.push(value); return value; } };`,
      );
      const inspect = await bundleGeneratedRoute(
        'src/routes/api/routeresources4320/inspect/+server.ts',
        'cross-package-inspect.mjs',
      );
      const request = (path: string, method = 'GET') =>
        new Request(`http://localhost/api/${path}`, { method });
      await expect(
        inspect.GET({
          locals: {},
          request: request('routeresources4320/inspect'),
        }),
      ).rejects.toMatchObject({ status: 401 });
      expect(state.__smrt4320FactoryKeys).toEqual([]);
      const response = await inspect.GET({
        locals: { user: { id: 'human' } },
        request: request('routeresources4320/inspect'),
      });
      expect(response.status, JSON.stringify(state.__smrt4320FactoryKeys)).toBe(
        200,
      );
      expect(await response.json()).toMatchObject({
        result: { count: 1, receiver: 'RouteResource4320' },
      });
      expect(state.__smrt4320FactoryKeys).toEqual([resourceKey]);
      if (!cli) {
        expect(ObjectRegistry.getClass(resourceKey)).toBeUndefined();
        expect(await resourceTools()).toEqual(previousResourceTools);
      }
      const [actual] =
        state.__smrt4320Instances as SmrtCollection<SmrtObject>[];
      expect(actual).toBeInstanceOf(RouteResource4320);
      expect(actual.db).toBe(db);
      expect(actual.tableName).toBe('route_items_4320');
      expect(
        ObjectRegistry.getClassByConstructor(RouteItem4320)?.qualifiedName,
      ).toBe(itemKey);
      expect(
        ObjectRegistry.getClass('@fixture/resource4320:RouteItem4320'),
      ).toBeUndefined();
      const peek = await bundleGeneratedRoute(
        'src/routes/api/routeresources4320/peek/+server.ts',
        'cross-package-peek.mjs',
      );
      expect(
        await (
          await peek.GET({
            locals: { user: { id: 'service' } },
            request: request('routeresources4320/peek'),
          })
        ).json(),
      ).toMatchObject({ result: { receiver: 'RouteResource4320' } });
      const submit = await bundleGeneratedRoute(
        'src/routes/api/routeresources4320/submit/+server.ts',
        'cross-package-submit.mjs',
      );
      await expect(
        submit.POST({
          locals: {
            user: { id: 'actor' },
            permissions: ['routeresources4320.submit'],
          },
          request: request('routeresources4320/submit', 'POST'),
        }),
      ).rejects.toMatchObject({ status: 403 });
      expect(
        (
          await submit.POST({
            locals: {
              user: { id: 'actor' },
              permissions: ['routeitems4320.submit'],
            },
            request: request('routeresources4320/submit', 'POST'),
          })
        ).status,
      ).toBe(200);
      const ordinary = await bundleGeneratedRoute(
        'src/routes/api/routeitems4320/+server.ts',
        'ordinary-model4320.mjs',
      );
      const listed = await ordinary.GET({
        locals: { user: { id: 'human' } },
        request: request('routeitems4320'),
        url: new URL('http://localhost/api/routeitems4320'),
      });
      expect(listed.status).toBe(200);
      expect(JSON.stringify(await listed.json())).toContain(
        '00000000-0000-4000-8000-000000004320',
      );
      expect((state.__smrt4320FactoryKeys as string[]).at(-1)).toBe(itemKey);
      const instances =
        state.__smrt4320Instances as SmrtCollection<SmrtObject>[];
      expect(instances.at(-1)).not.toBe(actual);
    } finally {
      await db?.close?.();
      restore();
      clearManifestCache();
      for (const key of Object.keys(state))
        if (key.startsWith('__smrt4320')) delete state[key];
    }
  });

  it('executes an explicitly named collection action through its real registered constructor and item authority', async () => {
    const restore = snapshotObjectRegistryState();
    class ActionItem4171 extends SmrtObject {}
    class ActionFacade4171 extends SmrtCollection<ActionItem4171> {
      static readonly _itemClass = ActionItem4171;
      static calls: unknown[] = [];
      static async submit(options: Record<string, unknown>) {
        this.calls.push(options);
        if (options.fail)
          throw Object.assign(new Error('Rejected by domain action'), {
            status: 409,
            code: 'domain_conflict',
          });
        return { accepted: options };
      }
    }
    try {
      smrt({
        packageName: '@fixture/collection-actions',
        collection: 'actionitems',
        api: false,
        cli: false,
      })(ActionItem4171);
      smrt({
        packageName: '@fixture/collection-actions',
        collection: 'actionfacades',
        api: { include: ['submit'], principalContext: true },
        cli: { include: ['submit'] },
      })(ActionFacade4171);
      const key =
        ObjectRegistry.getClassByConstructor(ActionItem4171)?.qualifiedName;
      if (!key)
        throw new Error('Expected qualified collection item registration');
      expect(key).toBe('@fixture/collection-actions:ActionItem4171');
      const actual = await ObjectRegistry.getCollection(key, {
        db: { type: 'sqlite', url: ':memory:' },
        ai: fixtureAi,
      });
      (globalThis as Record<string, unknown>).__smrt4171Constructors = {
        ActionItem4171,
        ActionFacade4171,
      };
      expect(actual.constructor).toBe(ActionFacade4171);
      (
        globalThis as Record<string, unknown>
      ).__smrtGeneratedCollectionMetadata = (manifest: SmartObjectManifest) =>
        ObjectRegistry.registerPackageManifest(manifest);
      (globalThis as Record<string, unknown>).__smrtGeneratedCollectionBinding =
        (
          name: string,
          ctor: Parameters<typeof ObjectRegistry.registerCollection>[1],
        ) => ObjectRegistry.registerCollection(name, ctor);
      const objectFilePath = join(projectRoot, 'src/lib/objects/Widget.ts');
      writeFileSync(
        objectFilePath,
        'export const { ActionItem4171, ActionFacade4171 } = globalThis.__smrt4171Constructors;',
      );
      const manifest = createManifest(projectRoot, objectFilePath);
      manifest.objects.Widget.className = 'ActionItem4171';
      manifest.objects.Widget.collection = 'actionitems';
      manifest.objects.Widget.decoratorConfig = { api: false };
      manifest.objects.Widget.qualifiedName = key;
      manifest.objects[key] = manifest.objects.Widget;
      delete manifest.objects.Widget;
      manifest.objects.ActionFacade4171 = {
        className: 'ActionFacade4171',
        name: 'ActionFacade4171',
        collection: 'actionfacades',
        extends: 'SmrtCollection',
        extendsTypeArg: 'ActionItem4171',
        fields: {},
        filePath: objectFilePath,
        decoratorConfig: {
          collection: 'actionfacades',
          api: { include: ['submit'], principalContext: true },
          cli: { include: ['submit'] },
        },
        methods: {
          submit: {
            name: 'submit',
            isStatic: true,
            isPublic: true,
            async: true,
            returnType: 'Promise<unknown>',
            parameters: [
              {
                name: 'options',
                type: 'Record<string, unknown>',
                optional: false,
              },
            ],
          },
        },
      };
      await generateSvelteKitRoutes(projectRoot, manifest, {
        configFileName: 'smrt.ts',
        configPath: 'src/lib/server',
        enabled: true,
        objectsDir: 'src/lib/objects',
        routesDir: 'src/routes/api',
      });
      (
        globalThis as Record<string, unknown>
      ).__smrtGeneratedCollectionResolver = (
        name: string,
        options: Parameters<typeof ObjectRegistry.getCollection>[1],
      ) =>
        ObjectRegistry.getCollection(name, {
          ...options,
          db: actual.db,
          ai: fixtureAi,
        });
      const route = await bundleGeneratedRoute(
        'src/routes/api/actionfacades/submit/+server.ts',
        'collection-action.mjs',
      );
      const request = () =>
        new Request('http://localhost/api/actionfacades/submit', {
          method: 'POST',
          body: JSON.stringify({
            opaque: { nested: 'unchanged' },
            tenantId: 'forged',
          }),
        });
      await expect(
        route.POST({ locals: {}, request: request() }),
      ).rejects.toMatchObject({ status: 401 });
      await expect(
        route.POST({
          locals: {
            user: { id: 'actor' },
            permissions: ['actionfacades.submit'],
          },
          request: request(),
        }),
      ).rejects.toMatchObject({ status: 403 });
      expect(ActionFacade4171.calls).toEqual([]);
      const response = await route.POST({
        locals: {
          user: { id: 'actor' },
          tenantId: 'trusted-tenant',
          permissions: ['actionitems.submit'],
        },
        request: request(),
      });
      expect(response.status).toBe(200);
      expect(ActionFacade4171.calls).toEqual([
        { opaque: { nested: 'unchanged' }, tenantId: 'forged' },
      ]);
      expect(
        (globalThis as Record<string, unknown>)
          .__smrtGeneratedActiveTenantContext,
      ).toMatchObject({ tenantId: 'trusted-tenant', userId: 'actor' });
      const failed = await route.POST({
        locals: {
          user: { id: 'actor' },
          tenantId: 'trusted-tenant',
          permissions: ['actionitems.submit'],
        },
        request: new Request('http://localhost/api/actionfacades/submit', {
          method: 'POST',
          body: JSON.stringify({ fail: true }),
        }),
      });
      expect(failed.status).toBe(409);
      const helperCalls = (globalThis as Record<string, unknown>)
        .__smrtGeneratedHelperCalls as Array<[string, unknown]>;
      expect(helperCalls.map(([name]) => name)).toEqual([
        '@test/generated-helper-app:ActionFacade4171',
        '@test/generated-helper-app:ActionFacade4171',
      ]);
    } finally {
      restore();
      delete (globalThis as Record<string, unknown>).__smrt4171Constructors;
      delete (globalThis as Record<string, unknown>)
        .__smrtGeneratedCollectionBinding;
      delete (globalThis as Record<string, unknown>)
        .__smrtGeneratedCollectionResolver;
      delete (globalThis as Record<string, unknown>)
        .__smrtGeneratedCollectionMetadata;
    }
  });

  describe('generated write routes enforce operation permissions (#2977)', () => {
    async function importGeneratedWrite(
      include: string[],
      routeFile: string,
      outputFile: string,
      decoratorConfig?: Record<string, unknown>,
    ) {
      const objectFilePath = join(projectRoot, 'src/lib/objects/Widget.ts');
      const manifest = createManifest(projectRoot, objectFilePath, include);
      if (decoratorConfig) {
        manifest.objects.Widget.decoratorConfig = decoratorConfig;
      }
      await generateSvelteKitRoutes(projectRoot, manifest, {
        configFileName: 'smrt.ts',
        configPath: 'src/lib/server',
        enabled: true,
        objectsDir: 'src/lib/objects',
        routesDir: 'src/routes/api',
      });
      return await bundleGeneratedRoute(routeFile, outputFile);
    }

    function trackCreate() {
      const calls: unknown[] = [];
      (globalThis as Record<string, unknown>).__smrtGeneratedRouteCollection = {
        create: async (data: unknown) => {
          calls.push(data);
          return { toPublicJSON: () => ({ id: 'created' }) };
        },
      };
      return calls;
    }

    function postRequest() {
      return new Request('http://localhost/api/widgets', {
        body: JSON.stringify({ name: 'Widget' }),
        method: 'POST',
      });
    }

    it('rejects an authenticated principal without the create permission with 403', async () => {
      const route = await importGeneratedWrite(
        ['create'],
        'src/routes/api/widgets/+server.ts',
        'perm-post-route.mjs',
      );
      const calls = trackCreate();
      for (const locals of [
        { user: { id: 'user-1' } },
        { permissions: [], user: { id: 'user-1' } },
        {
          permissions: ['widgets.read', 'widgets.update'],
          user: { id: 'user-1' },
        },
        { permissions: 'widgets.create', user: { id: 'user-1' } },
        { smrtAuth: true },
        {
          tenantContext: { permissions: new Set(['widgets.read']) },
          user: { id: 'user-1' },
        },
      ]) {
        await expect(
          route.POST({ locals, request: postRequest() }),
        ).rejects.toMatchObject({ status: 403 });
      }
      expect(calls).toHaveLength(0);
    });

    it('checks authentication before permission (401 for anonymous callers)', async () => {
      const route = await importGeneratedWrite(
        ['create'],
        'src/routes/api/widgets/+server.ts',
        'perm-post-anon-route.mjs',
      );
      const calls = trackCreate();
      await expect(
        route.POST({ locals: {}, request: postRequest() }),
      ).rejects.toMatchObject({ status: 401 });
      expect(calls).toHaveLength(0);
    });

    it('allows the create permission from every supported session snapshot', async () => {
      const route = await importGeneratedWrite(
        ['create'],
        'src/routes/api/widgets/+server.ts',
        'perm-post-granted-route.mjs',
      );
      const calls = trackCreate();
      for (const locals of [
        { permissions: ['widgets.create'], user: { id: 'user-1' } },
        { permissions: new Set(['widgets.create']), user: { id: 'user-1' } },
        { permissionSet: ['widgets.create'], user: { id: 'user-1' } },
        { smrtPermissions: new Set(['widgets.create']), smrtAuth: true },
        {
          tenantContext: { permissions: new Set(['widgets.create']) },
          user: { id: 'user-1' },
        },
        { tenantContext: { superAdminBypass: true }, user: { id: 'admin-1' } },
      ]) {
        const response = await route.POST({ locals, request: postRequest() });
        expect(response.status).toBe(201);
      }
      expect(calls).toHaveLength(6);
    });

    it('requires update for PUT and delete for DELETE', async () => {
      const route = await importGeneratedWrite(
        ['update', 'delete'],
        'src/routes/api/widgets/[id]/+server.ts',
        'perm-item-route.mjs',
      );
      const saved: string[] = [];
      const item = {
        save: async () => {
          saved.push('save');
        },
        toPublicJSON: () => ({ id: 'widget-1' }),
      };
      (globalThis as Record<string, unknown>).__smrtGeneratedRouteCollection = {
        delete: async () => {
          saved.push('delete');
        },
        get: async () => item,
        withAuditMutation: async (
          bound: typeof item,
          _action: string,
          mutate: (bound: typeof item) => Promise<void>,
        ) => mutate(bound),
      };
      const putRequest = () =>
        new Request('http://localhost/api/widgets/widget-1', {
          body: JSON.stringify({ name: 'Renamed' }),
          method: 'PUT',
        });

      await expect(
        route.PUT({
          locals: { permissions: ['widgets.delete'], user: { id: 'user-1' } },
          params: { id: 'widget-1' },
          request: putRequest(),
        }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        route.DELETE({
          locals: { permissions: ['widgets.update'], user: { id: 'user-1' } },
          params: { id: 'widget-1' },
        }),
      ).rejects.toMatchObject({ status: 403 });
      expect(saved).toEqual([]);

      const updated = await route.PUT({
        locals: { permissions: ['widgets.update'], user: { id: 'user-1' } },
        params: { id: 'widget-1' },
        request: putRequest(),
      });
      expect(updated.status).toBe(200);
      const deleted = await route.DELETE({
        locals: { permissions: ['widgets.delete'], user: { id: 'user-1' } },
        params: { id: 'widget-1' },
      });
      expect(deleted.status).toBeLessThan(300);
      expect(saved).toEqual(['save', 'delete']);
    });

    it('requires <collection>.<method> for mutating custom actions', async () => {
      const route = await importGeneratedItemActionPost();
      let invoked = 0;
      (globalThis as Record<string, unknown>).__smrtGeneratedRouteCollection = {
        get: async () => ({
          inspect: async () => {
            invoked += 1;
            return { ok: true };
          },
        }),
      };
      const request = () =>
        new Request('http://localhost/api/widgets/widget-1/inspect', {
          method: 'POST',
        });
      await expect(
        route.POST({
          locals: { permissions: ['widgets.update'], user: { id: 'user-1' } },
          params: { id: 'widget-1' },
          request: request(),
        }),
      ).rejects.toMatchObject({ status: 403 });
      expect(invoked).toBe(0);
      const response = await route.POST({
        locals: { permissions: ['widgets.inspect'], user: { id: 'user-1' } },
        params: { id: 'widget-1' },
        request: request(),
      });
      expect(response.status).toBe(200);
      expect(invoked).toBe(1);
    });

    it('uses an explicit @smrt collection in the permission slug', async () => {
      const route = await importGeneratedWrite(
        ['create'],
        'src/routes/api/widgets/+server.ts',
        'perm-post-collection-route.mjs',
        { api: { include: ['create'] }, collection: 'gadgets' },
      );
      trackCreate();
      await expect(
        route.POST({
          locals: { permissions: ['widgets.create'], user: { id: 'user-1' } },
          request: postRequest(),
        }),
      ).rejects.toMatchObject({ status: 403 });
      const response = await route.POST({
        locals: { permissions: ['gadgets.create'], user: { id: 'user-1' } },
        request: postRequest(),
      });
      expect(response.status).toBe(201);
    });

    it('keeps public: true writes open and public: read writes permission-gated', async () => {
      const open = await importGeneratedWrite(
        ['create'],
        'src/routes/api/widgets/+server.ts',
        'perm-post-public-route.mjs',
        { api: { include: ['create'], public: true } },
      );
      trackCreate();
      const response = await open.POST({ locals: {}, request: postRequest() });
      expect(response.status).toBe(201);

      const readOnly = await importGeneratedWrite(
        ['create'],
        'src/routes/api/widgets/+server.ts',
        'perm-post-public-read-route.mjs',
        { api: { include: ['create'], public: 'read' } },
      );
      await expect(
        readOnly.POST({
          locals: { user: { id: 'user-1' } },
          request: postRequest(),
        }),
      ).rejects.toMatchObject({ status: 403 });
    });
  });

  it('migrates the default route directory without ignoring handwritten handlers', async () => {
    const handwrittenRoute = join(
      projectRoot,
      'src/routes/api/_resources/+server.ts',
    );
    mkdirSync(join(projectRoot, 'src/routes/api/_resources'), {
      recursive: true,
    });
    writeFileSync(
      handwrittenRoute,
      'export const GET = () => new Response("handwritten");\n',
    );
    writeFileSync(
      join(projectRoot, '.gitignore'),
      [
        'node_modules/',
        '# SMRT auto-generated routes (from Vite plugin)',
        'src/routes/api/**/+server.ts',
        '# Application-owned output',
        'coverage/',
        '',
      ].join('\n'),
    );

    const manifest = createManifest(
      projectRoot,
      join(projectRoot, 'src/lib/objects/Widget.ts'),
    );
    const options = {
      configFileName: 'smrt.ts',
      configPath: 'src/lib/server',
      enabled: true,
      objectsDir: 'src/lib/objects',
      routesDir: 'src/routes/api',
    };

    await generateSvelteKitRoutes(projectRoot, manifest, options);
    await generateSvelteKitRoutes(projectRoot, manifest, options);

    const gitignore = readFileSync(join(projectRoot, '.gitignore'), 'utf-8');
    const generatedCollectionRoute = 'src/routes/api/widgets/+server.ts';
    expect(gitignore).toContain('# Application-owned output');
    expect(gitignore).toContain('coverage/');
    expect(gitignore).toContain(generatedCollectionRoute);
    expect(gitignore).toContain('src/routes/api/widgets/\\[id\\]/+server.ts');
    expect(gitignore).not.toContain('src/routes/api/**/+server.ts');
    expect(readFileSync(handwrittenRoute, 'utf-8')).toContain('handwritten');
    expect(
      readFileSync(join(projectRoot, generatedCollectionRoute), 'utf-8'),
    ).toContain('export const GET');
    expect(isIgnoredByGit(projectRoot, generatedCollectionRoute)).toBe(true);
    expect(
      isIgnoredByGit(projectRoot, 'src/routes/api/widgets/[id]/+server.ts'),
    ).toBe(true);
    expect(
      isIgnoredByGit(projectRoot, 'src/routes/api/_resources/+server.ts'),
    ).toBe(false);
  });

  it('generates and executes the _resources route for import-only smrt-users (#2663, #4493)', async () => {
    writeWorkspaceUsersShim(projectRoot);
    writeFileSync(
      join(projectRoot, '.gitignore'),
      ['node_modules/', ''].join('\n'),
    );

    const manifest = createManifest(
      projectRoot,
      join(projectRoot, 'src/lib/objects/Widget.ts'),
    );
    const options = {
      configFileName: 'smrt.ts',
      configPath: 'src/lib/server',
      enabled: true,
      objectsDir: 'src/lib/objects',
      routesDir: 'src/routes/api',
    };

    await generateSvelteKitRoutes(projectRoot, manifest, options);

    const resourcesRoutePath = join(
      projectRoot,
      'src/routes/api/_resources/+server.ts',
    );
    const routeContent = readFileSync(resourcesRoutePath, 'utf-8');
    expect(routeContent).toContain(
      "from '@happyvertical/smrt-users/sveltekit'",
    );
    expect(routeContent).toContain("import '$lib/server/smrt';");

    // Proves the emitted import actually resolves and the handler executes
    // end to end — not merely that a file with the right text was written.
    const route = await bundleGeneratedRoute(
      'src/routes/api/_resources/+server.ts',
      'resources-bundle.mjs',
    );
    const response: Response = await route.GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ resources: [] });
    expect(
      (globalThis as Record<string, unknown>)
        .__smrtGeneratedResourceListOptions,
    ).toHaveLength(1);

    expect(
      isIgnoredByGit(projectRoot, 'src/routes/api/_resources/+server.ts'),
    ).toBe(true);
  });

  it('uses the configured routesDir for exact generated ignores', async () => {
    const handwrittenRoute = join(
      projectRoot,
      'src/routes/generated-api/manual/+server.ts',
    );
    mkdirSync(join(projectRoot, 'src/routes/generated-api/manual'), {
      recursive: true,
    });
    writeFileSync(
      handwrittenRoute,
      'export const GET = () => new Response("manual");\n',
    );

    await generateSvelteKitRoutes(
      projectRoot,
      createManifest(
        projectRoot,
        join(projectRoot, 'src/lib/objects/Widget.ts'),
      ),
      {
        configFileName: 'smrt.ts',
        configPath: 'src/lib/server',
        enabled: true,
        objectsDir: 'src/lib/objects',
        routesDir: 'src/routes/generated-api',
      },
    );

    const gitignore = readFileSync(join(projectRoot, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('src/routes/generated-api/widgets/+server.ts');
    expect(gitignore).not.toContain('src/routes/api/**/+server.ts');
    expect(
      isIgnoredByGit(
        projectRoot,
        'src/routes/generated-api/widgets/+server.ts',
      ),
    ).toBe(true);
    expect(
      isIgnoredByGit(projectRoot, 'src/routes/generated-api/manual/+server.ts'),
    ).toBe(false);
  });

  /**
   * #2367. The emitted list route paged with LIMIT/OFFSET and no ORDER BY —
   * which is not pagination: PostgreSQL may return rows in any order and pick a
   * different one per query, so page 2 could repeat or skip page 1's rows. It
   * also parsed its bounds with `Number(x) || 50`, which binds NaN for any
   * non-numeric input, folds a deliberate `limit=0` into 50, and has no ceiling.
   */
  describe('generated list route bounds and ordering (#2367)', () => {
    async function listWithQuery(
      query: string,
      fields: SmartObjectManifest['objects'][string]['fields'] = {},
    ) {
      const route = await importGeneratedCollectionList(fields);
      const calls: Array<Record<string, unknown>> = [];
      (globalThis as Record<string, unknown>).__smrtGeneratedRouteCollection = {
        count: async () => 0,
        db: { type: 'sqlite', url: ':memory:' },
        list: async (options: Record<string, unknown>) => {
          calls.push(options);
          return [];
        },
        tableName: 'widgets',
      };

      const invoke = () =>
        route.GET({
          // The auth guard runs before bounds parsing (authenticate first,
          // then validate input), so the caller must be authenticated for the
          // bounds assertions below to be reached at all.
          locals: { user: { id: 'user-1' } },
          request: new Request(`http://localhost/api/widgets${query}`),
          url: new URL(`http://localhost/api/widgets${query}`),
        });

      return { calls, invoke };
    }

    it('pages deterministically with a total-order tiebreak', async () => {
      const { calls, invoke } = await listWithQuery('');
      const response = await invoke();
      expect(response.status).toBe(200);
      expect(calls[0]).toMatchObject({
        limit: 50,
        offset: 0,
        orderBy: ['created_at DESC', 'id ASC'],
      });
    });

    it('tiebreaks on a declared primary key, not a synthetic id', async () => {
      // Scanner manifests carry the flag under `_meta`, not at the top level.
      // A custom-primary-key class has no `id` column at all, so an `id`
      // tiebreak would fail every unqualified list request for it.
      const { calls, invoke } = await listWithQuery('', {
        sku: { _meta: { primaryKey: true }, type: 'text' },
      });
      await invoke();
      expect(calls[0]).toMatchObject({
        orderBy: ['created_at DESC', 'sku ASC'],
      });
    });

    it('clamps an oversized page to the ceiling', async () => {
      const { calls, invoke } = await listWithQuery('?limit=100000000');
      await invoke();
      expect(calls[0]).toMatchObject({ limit: 1000 });
    });

    it('honours an explicit limit=0 instead of folding it into the default', async () => {
      const { calls, invoke } = await listWithQuery('?limit=0');
      await invoke();
      expect(calls[0]).toMatchObject({ limit: 0 });
    });

    it.each([
      ['abc'],
      ['1.5'],
      ['-1'],
      ['1e3'],
    ])('rejects ?limit=%s with a 400 instead of binding NaN', async (raw) => {
      const { calls, invoke } = await listWithQuery(
        `?limit=${encodeURIComponent(raw)}`,
      );
      await expect(invoke()).rejects.toMatchObject({ status: 400 });
      // Rejected before the collection is queried at all.
      expect(calls).toHaveLength(0);
    });

    it('rejects a malformed ?offset the same way', async () => {
      const { invoke } = await listWithQuery('?offset=abc');
      await expect(invoke()).rejects.toMatchObject({ status: 400 });
    });
  });
});
