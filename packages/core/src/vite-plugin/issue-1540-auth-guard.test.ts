/**
 * Test for issue #1540 (increment 2c): fail-closed authorization on generated
 * SvelteKit routes.
 *
 * Every generated CRUD handler calls `requireRouteAuth(locals, mutating)`, which
 * throws 401 unless the object opts out via `@smrt({ api: { public } })`.
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

function findRouteContent(suffix: string): string {
  for (const call of vi.mocked(writeFileSync).mock.calls) {
    const path = call[0].toString();
    if (path.endsWith(suffix)) return call[1] as string;
  }
  throw new Error(`No generated route ending in ${suffix}`);
}

async function generate(api: unknown): Promise<void> {
  await generateSvelteKitRoutes(
    projectRoot,
    {
      objects: {
        Widget: {
          className: 'Widget',
          collection: 'widgets',
          fields: { name: { type: 'text' } },
          methods: {},
          decoratorConfig: { api },
        },
      },
    } as unknown as SmartObjectManifest,
    {
      enabled: true,
      routesDir: 'src/routes/api',
      objectsDir: 'src/lib/objects',
      configPath: 'src/lib/server',
      configFileName: 'smrt.ts',
    },
  );
}

describe('Issue #1540 (2c): fail-closed auth on generated routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readFileSync).mockReturnValue('');
    vi.mocked(readdirSync).mockReturnValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('defaults to fail-closed (PUBLIC_ACCESS=false) and guards every handler', async () => {
    await generate({ include: ['list', 'get', 'create', 'update', 'delete'] });

    const collectionRoute = findRouteContent('widgets/+server.ts');
    const itemRoute = findRouteContent('widgets/[id]/+server.ts');

    expect(collectionRoute).toContain(
      "const PUBLIC_ACCESS: boolean | 'read' = false;",
    );
    expect(collectionRoute).toContain('function requireRouteAuth');
    // Reads are non-mutating; writes are mutating.
    expect(collectionRoute).toContain('requireRouteAuth(locals, false);'); // GET list
    expect(collectionRoute).toContain('requireRouteAuth(locals, true);'); // POST
    expect(itemRoute).toContain('requireRouteAuth(locals, false);'); // GET item
    expect(itemRoute).toContain('requireRouteAuth(locals, true);'); // PUT + DELETE
    // 401 on missing principal.
    expect(collectionRoute).toContain(
      "throw error(401, 'Authentication required');",
    );
  });

  it('honors api.public === true (all routes public)', async () => {
    await generate({ include: ['list', 'create'], public: true });
    const collectionRoute = findRouteContent('widgets/+server.ts');
    expect(collectionRoute).toContain(
      "const PUBLIC_ACCESS: boolean | 'read' = true;",
    );
  });

  it('honors api.public === "read" (reads public, writes guarded)', async () => {
    await generate({ include: ['list', 'create'], public: 'read' });
    const collectionRoute = findRouteContent('widgets/+server.ts');
    expect(collectionRoute).toContain(
      'const PUBLIC_ACCESS: boolean | \'read\' = "read";',
    );
  });
});
