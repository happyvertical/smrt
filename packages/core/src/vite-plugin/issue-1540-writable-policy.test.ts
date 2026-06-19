/**
 * Test for issue #1540 (increment 2b): writable-field allowlist on generated
 * create/update routes (mass-assignment guard).
 *
 * Generated SvelteKit create (POST) and update (PUT) handlers must run the
 * request body through `applyWritablePolicy`, which strips framework /
 * server-managed (`id`, `tenantId`, timestamps, `_`-prefixed) and
 * `@field({ readonly: true })` fields, and — when `api.writable` is set —
 * intersects with that allowlist.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SmartObjectManifest } from '../scanner/types';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

import { generateSvelteKitRoutes } from './sveltekit-generator';

const projectRoot = '/test/project';

function writtenRouteFiles(): Map<string, string> {
  const files = new Map<string, string>();
  for (const call of vi.mocked(writeFileSync).mock.calls) {
    const path = call[0].toString();
    if (path.endsWith('+server.ts')) {
      files.set(path, call[1] as string);
    }
  }
  return files;
}

function findRouteContent(suffix: string): string {
  for (const [path, content] of writtenRouteFiles()) {
    if (path.endsWith(suffix)) return content;
  }
  throw new Error(`No generated route ending in ${suffix}`);
}

describe('Issue #1540 (2b): writable-field allowlist on generated routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readFileSync).mockReturnValue('');
    vi.mocked(readdirSync).mockReturnValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  async function generate(manifest: SmartObjectManifest): Promise<void> {
    await generateSvelteKitRoutes(projectRoot, manifest, {
      enabled: true,
      routesDir: 'src/routes/api',
      objectsDir: 'src/lib/objects',
      configPath: 'src/lib/server',
      configFileName: 'smrt.ts',
    });
  }

  it('injects the mass-assignment guard into POST and PUT handlers', async () => {
    await generate({
      objects: {
        Widget: {
          className: 'Widget',
          collection: 'widgets',
          fields: {
            name: { type: 'text' },
            secretKey: { type: 'text', readonly: true },
          },
          methods: {},
          decoratorConfig: {
            api: { include: ['list', 'get', 'create', 'update', 'delete'] },
          },
        },
      },
    } as unknown as SmartObjectManifest);

    const collectionRoute = findRouteContent('widgets/+server.ts');
    const itemRoute = findRouteContent('widgets/[id]/+server.ts');

    // Helper present in both files that have a write handler.
    expect(collectionRoute).toContain('function applyWritablePolicy');
    expect(itemRoute).toContain('function applyWritablePolicy');

    // POST + PUT bodies are routed through the guard.
    expect(collectionRoute).toContain(
      'const data = applyWritablePolicy(await request.json());',
    );
    expect(itemRoute).toContain(
      'const data = applyWritablePolicy(await request.json());',
    );

    // Server-managed fields are always stripped; read-only fields are listed.
    expect(collectionRoute).toContain("'tenantId'");
    expect(collectionRoute).toContain('READONLY_FIELDS');
    expect(collectionRoute).toContain('"secretKey"');

    // No explicit allowlist configured → null (strip-only mode).
    expect(collectionRoute).toContain(
      'const WRITABLE_ALLOWLIST: string[] | null = null;',
    );
  });

  it('emits the configured writable allowlist', async () => {
    await generate({
      objects: {
        Gadget: {
          className: 'Gadget',
          collection: 'gadgets',
          fields: { name: { type: 'text' }, price: { type: 'decimal' } },
          methods: {},
          decoratorConfig: {
            api: {
              include: ['create', 'update'],
              writable: ['name', 'price'],
            },
          },
        },
      },
    } as unknown as SmartObjectManifest);

    const collectionRoute = findRouteContent('gadgets/+server.ts');
    expect(collectionRoute).toContain(
      'const WRITABLE_ALLOWLIST: string[] | null = ["name","price"];',
    );
  });
});
