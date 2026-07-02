/**
 * Generator-level coverage for conditional GET on generated SvelteKit routes
 * (#1757): the collection (list) and item (get) templates inline the
 * conditional-GET helper, wrap their GET returns in `conditionalJson`, and
 * bake in the Cache-Control policy resolved from `@smrt({ api })` — private
 * by default, shared `s-maxage` only for public models that opt in, and NEVER
 * for non-public models. Mutation handlers are untouched.
 *
 * Tests the generator's emitted strings (per repo convention — "test
 * generators, not generated output"); the snippet's runtime behavior is
 * covered in `../generators/conditional-get.test.ts`, which imports and
 * executes it.
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

  it('inlines the helper and wraps list/get returns in conditionalJson', async () => {
    const { collectionRoute, itemRoute } = await generateAndRead(true);

    for (const content of [collectionRoute, itemRoute]) {
      expect(content).toBeDefined();
      // Helper is inlined with the ETag + If-None-Match machinery.
      expect(content).toContain("import { createHash } from 'node:crypto';");
      expect(content).toContain('function conditionalJson(');
      expect(content).toContain("request.headers.get('if-none-match')");
      expect(content).toContain('status: 304');
    }

    // List handler destructures request and returns conditionally.
    expect(collectionRoute).toContain(
      'export const GET: RequestHandler = async ({ locals, url, request })',
    );
    expect(collectionRoute).toContain(
      'return conditionalJson(request, { items: items_public, count, limit, offset });',
    );

    // Item GET handler too.
    expect(itemRoute).toContain(
      'export const GET: RequestHandler = async ({ locals, params, request })',
    );
    expect(itemRoute).toContain(
      'return conditionalJson(request, item.toPublicJSON());',
    );

    // Mutation handlers stay as-is (plain json responses, no conditional).
    expect(collectionRoute).toContain('return json(item.toPublicJSON(), { status: 201 });');
    expect(itemRoute).toContain('export const PUT: RequestHandler');
    expect(itemRoute).toMatch(/PUT[\s\S]*return json\(item\.toPublicJSON\(\)\);/);
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

    // GET-only handlers respond via conditionalJson; `json` would be unused.
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
    // Custom actions are out of the v1 conditional-GET scope.
    expect(actionRoute).not.toContain('conditionalJson');
    expect(actionRoute).not.toContain('READ_CACHE_CONTROL');
  });
});
