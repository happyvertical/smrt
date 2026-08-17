import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SmartObjectManifest } from '../scanner/types.js';
import { generateSvelteKitRoutes } from './sveltekit-generator.js';

function createManifest(
  projectRoot: string,
  objectFilePath: string,
  include?: string[],
  principalContext = false,
  fields: SmartObjectManifest['objects'][string]['fields'] = {},
): SmartObjectManifest {
  return {
    objects: {
      Widget: {
        className: 'Widget',
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
      'export function hasTenantContext() { return false; }',
      'export function enterTenantContext(context) {',
      '  globalThis.__smrtGeneratedTenantContexts.push(context);',
      '}',
    ].join('\n'),
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
      '    if (globalThis.__smrtGeneratedRouteCollection) {',
      '      return globalThis.__smrtGeneratedRouteCollection;',
      '    }',
      "    return { marker: 'collection' };",
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

  beforeEach(() => {
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
    initializeGitRepository(projectRoot);
  });

  afterEach(() => {
    vi.restoreAllMocks();

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
            pluginBuild.onResolve({ filter: /^\$lib\/server\/smrt$/ }, () => ({
              path: join(projectRoot, 'src/lib/server/smrt.ts'),
            }));
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
      locals: { user: { id: 'user-1' } },
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
      locals: { user: { id: 'user-1' } },
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

  it('executes emitted DELETE routes with safe typed 4xx errors and opaque 5xx errors', async () => {
    const route = await importGeneratedItemDelete();
    const routeCollection = globalThis as Record<string, unknown>;
    routeCollection.__smrtGeneratedRouteCollection = {
      get: async () => ({
        delete: async () => {
          throw Object.assign(new Error('foreign tenant=secret-tenant'), {
            code: 'tenant_isolation',
            publicMessage:
              'This request is not permitted for the active tenant',
            status: 403,
          });
        },
      }),
    };

    const denied = await route.DELETE({
      locals: { user: { id: 'user-1' } },
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
      get: async () => ({
        delete: async () => {
          throw Object.assign(new Error('database secret leaked'), {
            code: 'database_failed',
            status: 500,
          });
        },
      }),
    };
    const failed = await route.DELETE({
      locals: { user: { id: 'user-1' } },
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
        permissions: ['fields.policy.manage'],
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
    expect([...contexts[0].permissions]).toEqual(['fields.policy.manage']);
    expect(JSON.stringify(contexts[0])).not.toContain('forged');
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
