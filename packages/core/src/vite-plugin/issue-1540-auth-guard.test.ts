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
  // Route ownership inspects planned paths with lstat; nothing exists here.
  lstatSync: vi.fn(() => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
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
          qualifiedName: '@test/smrt:Widget',
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
    expect(collectionRoute).toContain('function requireRouteAccess');
    // The decision is the shared one (#5195), not an emitted copy of it.
    expect(collectionRoute).toContain('authorize({');
    expect(collectionRoute).not.toContain('function hasAuthenticatedPrincipal');
    expect(collectionRoute).not.toContain('function hasGrantedPermission');
    // Reads are non-mutating; writes are mutating.
    expect(collectionRoute).toContain(
      'requireRouteAccess(locals, "list", false);',
    ); // GET list
    expect(collectionRoute).toContain(
      'requireRouteAccess(locals, "create", true);',
    ); // POST
    expect(itemRoute).toContain('requireRouteAccess(locals, "get", false);'); // GET item
    expect(itemRoute).toContain('requireRouteAccess(locals, "update", true);'); // PUT
    expect(itemRoute).toContain('requireRouteAccess(locals, "delete", true);'); // DELETE
    expect(collectionRoute).toContain(
      "requireRouteBody(locals, 'create', body);",
    );
    expect(itemRoute).toContain("requireRouteBody(locals, 'update', body);");
    // Writes also require the operation permission (#2977); reads do not.
    expect(collectionRoute).toContain(
      'const PERMISSION_COLLECTION = "widgets";',
    );
    expect(collectionRoute).not.toContain('requireRoutePermission');
    expect(collectionRoute).toContain(
      'const ALLOW_SUPER_ADMIN_BYPASS = false;',
    );
    // The shared decision answers 401 and 403 with their codes.
    expect(collectionRoute).toContain('routeDenial(decision)');
    expect(collectionRoute).toContain(
      'const body: { message: string; code: string }',
    );
    // Must NOT fail open on a callable `locals.auth` (Auth.js puts an `auth()`
    // helper on every request, including anonymous ones).
    expect(collectionRoute).not.toContain('l.auth');
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
