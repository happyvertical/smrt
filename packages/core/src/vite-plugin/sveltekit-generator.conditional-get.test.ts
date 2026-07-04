/**
 * Generator-level coverage for conditional GET on generated SvelteKit routes
 * (ETag v2, #1765): the collection (list) and item (get) templates inline the
 * `conditionalVersionedRead` helper, wrap their GET query in it (so a matching
 * If-None-Match answers 304 without the query running), and bake in the
 * Cache-Control policy resolved from `@smrt({ api })` — private by default,
 * shared `s-maxage` only for public models that opt in, and NEVER for
 * non-public or tenant-scoped models. Mutation handlers are untouched.
 *
 * Tests the generator's emitted strings (per repo convention — "test
 * generators, not generated output"); the version-first runtime behavior is
 * covered end to end in `../generators/conditional-get.spec.ts` over the same
 * core primitives the emitted route calls.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SmartObjectManifest } from '../scanner/types';

// Mock node:fs module (same setup as sveltekit-generator.test.ts).
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

// Import after mocking
import { generateSvelteKitRoutes } from './sveltekit-generator';

const projectRoot = '/test/project';

function manifestFor(api: unknown): SmartObjectManifest {
  return {
    objects: {
      Product: {
        className: 'Product',
        collection: 'products',
        fields: {},
        methods: {},
        decoratorConfig: { api },
      },
    },
  } as unknown as SmartObjectManifest;
}

async function generateAndRead(api: unknown): Promise<{
  collectionRoute: string;
  itemRoute: string;
}> {
  await generateSvelteKitRoutes(projectRoot, manifestFor(api), {
    enabled: true,
    routesDir: 'src/routes/api',
    objectsDir: 'src/lib/objects',
  });

  const calls = vi.mocked(writeFileSync).mock.calls;
  const collectionRoute = calls.find((call) =>
    call[0].toString().endsWith('products/+server.ts'),
  )?.[1] as string;
  const itemRoute = calls.find((call) =>
    call[0].toString().includes('products/[id]/+server.ts'),
  )?.[1] as string;
  return { collectionRoute, itemRoute };
}

describe('SvelteKit generated routes: conditional GET (#1757)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readFileSync).mockReturnValue('');
    vi.mocked(readdirSync).mockReturnValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('inlines the v2 helper and wraps list/get queries in conditionalVersionedRead', async () => {
    const { collectionRoute, itemRoute } = await generateAndRead(true);

    for (const content of [collectionRoute, itemRoute]) {
      expect(content).toBeDefined();
      // v2 helper is inlined, importing its version primitives from smrt-core
      // and deriving the ETag from the per-table change-feed version.
      expect(content).toContain("from '@happyvertical/smrt-core'");
      expect(content).toContain('async function conditionalVersionedRead(');
      expect(content).toContain('getTableVersion(db, tableName)');
      expect(content).toContain("request.headers.get('if-none-match')");
      expect(content).toContain('status: 304');
    }

    // List handler wraps its query in the version-first helper (the query
    // thunk runs only on a cache miss) and returns the payload from the thunk.
    expect(collectionRoute).toContain(
      'export const GET: RequestHandler = async ({ locals, url, request })',
    );
    expect(collectionRoute).toContain(
      'return conditionalVersionedRead(request, collection.db, collection.tableName, async () => {',
    );
    expect(collectionRoute).toContain(
      'return { items: items_public, count, limit, offset };',
    );

    // Item GET handler too.
    expect(itemRoute).toContain(
      'export const GET: RequestHandler = async ({ locals, params, request })',
    );
    expect(itemRoute).toContain(
      'return conditionalVersionedRead(request, collection.db, collection.tableName, async () => {',
    );
    expect(itemRoute).toContain('return item.toPublicJSON(publicJsonOptions);');

    // Mutation handlers stay as-is (plain json responses, no conditional).
    expect(collectionRoute).toContain(
      'return json(item.toPublicJSON(publicJsonOptions), { status: 201 });',
    );
    expect(itemRoute).toContain('export const PUT: RequestHandler');
    expect(itemRoute).toMatch(
      /PUT[\s\S]*return json\(item\.toPublicJSON\(publicJsonOptions\)\);/,
    );
  });

  it('keeps the v1 body-hash helper for routes with a custom serializer (#1765)', async () => {
    // A custom serializer can render data from RELATED tables (e.g. content's
    // serializeContent loads assets/references), which the per-table change-feed
    // version cannot observe — so a version-derived 304 would serve stale
    // serialized fields. Such routes must stay on the v1 body-hash ETag.
    const { collectionRoute, itemRoute } = await generateAndRead({
      serializers: {
        item: { exportName: 'serializeThing', importPath: '$lib/serializers' },
      },
    });

    for (const content of [collectionRoute, itemRoute]) {
      expect(content).toBeDefined();
      // v1 body-hash helper, NOT the v2 version source.
      expect(content).toContain("import { createHash } from 'node:crypto';");
      expect(content).toContain('function conditionalJson(');
      expect(content).not.toContain('conditionalVersionedRead');
      expect(content).not.toContain('getTableVersion');
    }
    // The serialized payload is hashed by conditionalJson (query-first).
    expect(collectionRoute).toContain(
      'return conditionalJson(request, { items: serializedItems, count, limit, offset });',
    );
    expect(itemRoute).toContain('applyReadPermissionRedaction(');
    expect(itemRoute).toContain('serializedItem, publicJsonOptions');
  });

  it('bakes the private default policy into routes for non-public models', async () => {
    const { collectionRoute, itemRoute } = await generateAndRead({
      include: ['list', 'get', 'update'],
    });

    for (const content of [collectionRoute, itemRoute]) {
      expect(content).toContain(
        "const READ_CACHE_CONTROL = 'private, no-cache';",
      );
      expect(content).not.toContain('s-maxage');
    }
  });

  it('bakes the shared policy into routes for public models with sMaxage', async () => {
    const { collectionRoute, itemRoute } = await generateAndRead({
      public: true,
      cache: { sMaxage: 120 },
    });

    for (const content of [collectionRoute, itemRoute]) {
      expect(content).toContain(
        "const READ_CACHE_CONTROL = 'public, max-age=0, s-maxage=120';",
      );
    }
  });

  it('NEVER bakes shared-cache headers for non-public models, even with sMaxage', async () => {
    const { collectionRoute, itemRoute } = await generateAndRead({
      cache: { sMaxage: 900 },
    });

    for (const content of [collectionRoute, itemRoute]) {
      expect(content).toContain(
        "const READ_CACHE_CONTROL = 'private, no-cache';",
      );
      expect(content).not.toContain('s-maxage');
      expect(content).not.toContain("READ_CACHE_CONTROL = 'public");
    }
  });

  it('NEVER bakes shared-cache headers for tenant-scoped models (any form), even public + sMaxage (#1757 review)', async () => {
    // Both representations: @smrt({ tenantScoped: true }) and the
    // @TenantScoped({ mode: 'optional' }) decorator (scanner merges it into
    // decoratorConfig.tenantScoped as an object). 'optional' mode is still
    // unsafe: cookie'd vs anonymous requests get different bodies at one URL.
    for (const tenantScoped of [true, { mode: 'optional' }]) {
      vi.clearAllMocks();
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(readFileSync).mockReturnValue('');
      vi.mocked(readdirSync).mockReturnValue([]);

      const manifest: SmartObjectManifest = {
        objects: {
          Product: {
            className: 'Product',
            collection: 'products',
            fields: {},
            methods: {},
            decoratorConfig: {
              tenantScoped,
              api: { public: 'read', cache: { sMaxage: 900 } },
            },
          },
        },
      } as unknown as SmartObjectManifest;

      await generateSvelteKitRoutes(projectRoot, manifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
      });

      const calls = vi.mocked(writeFileSync).mock.calls;
      const collectionRoute = calls.find((call) =>
        call[0].toString().endsWith('products/+server.ts'),
      )?.[1] as string;
      const itemRoute = calls.find((call) =>
        call[0].toString().includes('products/[id]/+server.ts'),
      )?.[1] as string;

      for (const content of [collectionRoute, itemRoute]) {
        expect(content).toBeDefined();
        expect(content).toContain(
          "const READ_CACHE_CONTROL = 'private, no-cache';",
        );
        expect(content).not.toContain('s-maxage');
        expect(content).not.toContain("READ_CACHE_CONTROL = 'public");
      }
    }
  });

  it('keeps public-without-opt-in models on the private policy', async () => {
    const { collectionRoute } = await generateAndRead({ public: true });
    expect(collectionRoute).toContain(
      "const READ_CACHE_CONTROL = 'private, no-cache';",
    );
  });

  it('omits the unused json import on read-only routes', async () => {
    const { collectionRoute, itemRoute } = await generateAndRead({
      include: ['list', 'get'],
    });

    // GET-only handlers respond via conditionalVersionedRead; `json` unused.
    expect(collectionRoute).toContain("import { error } from '@sveltejs/kit';");
    expect(itemRoute).toContain("import { error } from '@sveltejs/kit';");

    // With mutations included, `json` is still imported for them.
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readFileSync).mockReturnValue('');
    vi.mocked(readdirSync).mockReturnValue([]);
    const withMutations = await generateAndRead(true);
    expect(withMutations.collectionRoute).toContain(
      "import { error, json } from '@sveltejs/kit';",
    );
    expect(withMutations.itemRoute).toContain(
      "import { error, json } from '@sveltejs/kit';",
    );
  });

  it('does not touch custom action routes or the knowledge route posture', async () => {
    const manifest: SmartObjectManifest = {
      objects: {
        Product: {
          className: 'Product',
          collection: 'products',
          fields: {},
          methods: {
            summarize: {
              name: 'summarize',
              parameters: [],
              returnType: 'Promise<string>',
              isPublic: true,
            },
          },
          decoratorConfig: {
            api: { include: ['list', 'summarize'] },
          },
        },
      },
    } as unknown as SmartObjectManifest;

    await generateSvelteKitRoutes(projectRoot, manifest, {
      enabled: true,
      routesDir: 'src/routes/api',
      objectsDir: 'src/lib/objects',
    });

    const actionRoute = vi
      .mocked(writeFileSync)
      .mock.calls.find((call) =>
        call[0].toString().includes('products/[id]/summarize/+server.ts'),
      )?.[1] as string;

    expect(actionRoute).toBeDefined();
    // Custom actions are out of the conditional-GET scope.
    expect(actionRoute).not.toContain('conditionalVersionedRead');
    expect(actionRoute).not.toContain('READ_CACHE_CONTROL');
  });
});
