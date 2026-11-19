/**
 * Test for issue #1540 (increment 2b): writable-field allowlist on generated
 * create/update routes (mass-assignment guard).
 *
 * Generated SvelteKit create (POST) and update (PUT) handlers must run the
 * request body through core's `prepareWriteInput` (#5195), which skips
 * server-managed keys and refuses a protected field (read-only, outside
 * `api.writable`, `_`-prefixed) the body would set or change. The policy is
 * read from the registry at run time, so nothing about it is baked into the
 * emitted source; `protected-field-writes.test.ts` executes the routes.
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
          qualifiedName: '@test/smrt:Widget',
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

    // POST + PUT bodies go through the shared rule; the update compares
    // against the loaded item.
    expect(collectionRoute).toContain(
      'const body: unknown = await request.json();',
    );
    expect(collectionRoute).toContain(
      'const data = prepareWriteInput(target.collectionName, target.data);',
    );
    expect(itemRoute).toContain('const body: unknown = await request.json();');
    expect(itemRoute).toContain(
      'const data = prepareWriteInput("Widget", body, item);',
    );

    // No route-local copy of the policy.
    for (const route of [collectionRoute, itemRoute]) {
      expect(route).not.toContain('function applyWritablePolicy');
      expect(route).not.toContain('READONLY_FIELDS');
      expect(route).not.toContain('WRITABLE_ALLOWLIST');
    }
  });

  it('does not bake the writable allowlist into the route', async () => {
    await generate({
      objects: {
        Gadget: {
          qualifiedName: '@test/smrt:Gadget',
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
    expect(collectionRoute).toContain('prepareWriteInput(');
    expect(collectionRoute).not.toContain('WRITABLE_ALLOWLIST');
  });
});
