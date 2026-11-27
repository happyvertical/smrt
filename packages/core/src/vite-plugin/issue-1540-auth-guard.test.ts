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
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createGuestRequestPrincipal,
  GUEST_MAX_LIST_LIMIT,
  guestPrincipalOf,
  isGuestLocals,
  isGuestOperationAllowed,
} from '../guest-request';
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
    expect(collectionRoute).toContain('function requireRouteAuth');
    // Reads are non-mutating; writes are mutating.
    expect(collectionRoute).toContain(
      'requireRouteAuth(locals, false, "list");',
    ); // GET list
    expect(collectionRoute).toContain('requireRouteAuth(locals, true);'); // POST
    expect(itemRoute).toContain('requireRouteAuth(locals, false, "get");'); // GET item
    expect(itemRoute).toContain('requireRouteAuth(locals, true);'); // PUT + DELETE
    // Writes also require the operation permission (#2977); reads do not.
    expect(collectionRoute).toContain(
      'const PERMISSION_COLLECTION = "widgets";',
    );
    expect(collectionRoute).toContain(
      'requireRoutePermission(locals, "create");',
    );
    expect(itemRoute).toContain('requireRoutePermission(locals, "update");');
    expect(itemRoute).toContain('requireRoutePermission(locals, "delete");');
    expect(collectionRoute).not.toContain(
      'requireRoutePermission(locals, "read")',
    );
    expect(collectionRoute).toContain("throw error(403, 'Permission denied');");
    // 401 on missing principal.
    expect(collectionRoute).toContain(
      "throw error(401, 'Authentication required');",
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

  describe('guest callers (#5196)', () => {
    /** Run the emitted guard and bounds helpers of a generated route. */
    async function emitted(api: unknown = { include: ['list', 'get'] }) {
      await generate(api);
      const route = findRouteContent('widgets/+server.ts');
      const line = (prefix: string): string => {
        const start = route.indexOf(prefix);
        if (start < 0) throw new Error(`missing ${prefix}`);
        return route.slice(start, route.indexOf('\n', start));
      };
      const between = (from: string, to: string): string => {
        const a = route.indexOf(from);
        const b = route.indexOf(to, a);
        if (a < 0 || b < 0) throw new Error(`missing ${from}`);
        return route.slice(a, b);
      };
      const bounds = (() => {
        const a = route.indexOf('function listBounds(');
        return route.slice(a, route.indexOf('\n}\n', a) + 3);
      })();
      const source = [
        line('const GUEST_MODEL'),
        line('const PERMISSION_COLLECTION'),
        line('const PUBLIC_ACCESS'),
        between(
          'function hasAuthenticatedPrincipal(',
          'function hasGrantedPermission(',
        ),
        bounds,
        'return { requireRouteAuth, listBounds };',
      ].join('\n');
      const js = ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).outputText;
      const error = (status: number, message: string) =>
        Object.assign(new Error(message), { status });
      return new Function(
        'error',
        'GUEST_MAX_LIST_LIMIT',
        'guestPrincipalOf',
        'isGuestLocals',
        'isGuestOperationAllowed',
        'isRuntimeModelEnabled',
        'getCurrentTenant',
        js,
      )(
        error,
        GUEST_MAX_LIST_LIMIT,
        guestPrincipalOf,
        isGuestLocals,
        isGuestOperationAllowed,
        () => true,
        () => undefined,
      ) as {
        requireRouteAuth: (
          locals: unknown,
          mutating: boolean,
          op?: 'list' | 'get',
        ) => void;
        listBounds: (
          url: URL,
          locals: unknown,
        ) => { limit: number; offset: number };
      };
    }

    const guestLocals = (permissions: string[]) => ({
      tenantId: 'tenant-a',
      permissions,
      guestPrincipal: createGuestRequestPrincipal({
        tenantId: 'tenant-a',
        permissions,
      }),
    });
    const statusOf = (fn: () => void): number | undefined => {
      try {
        fn();
      } catch (error) {
        return (error as { status?: number }).status;
      }
      return undefined;
    };

    it('admits a guest only to the read operation its grant covers', async () => {
      const { requireRouteAuth } = await emitted();
      const guest = guestLocals(['widgets.read']);
      expect(
        statusOf(() => requireRouteAuth(guest, false, 'list')),
      ).toBeUndefined();
      expect(
        statusOf(() => requireRouteAuth(guest, false, 'get')),
      ).toBeUndefined();
      // Writes, custom actions (no operation) and other collections deny.
      expect(statusOf(() => requireRouteAuth(guest, true))).toBe(403);
      expect(statusOf(() => requireRouteAuth(guest, false))).toBe(403);
      expect(
        statusOf(() =>
          requireRouteAuth(guestLocals(['widgets.create']), false, 'list'),
        ),
      ).toBe(403);
      expect(
        statusOf(() =>
          requireRouteAuth(guestLocals(['gadgets.read']), false, 'list'),
        ),
      ).toBe(403);
      expect(
        statusOf(() => requireRouteAuth(guestLocals([]), false, 'list')),
      ).toBe(403);
    });

    it('anonymous and forged callers stay 401', async () => {
      const { requireRouteAuth } = await emitted();
      expect(statusOf(() => requireRouteAuth({}, false, 'list'))).toBe(401);
      expect(
        statusOf(() => requireRouteAuth({ auth: () => true }, false, 'list')),
      ).toBe(401);
      // A marker that disagrees with the locals tenant is not a guest.
      const forged = { ...guestLocals(['widgets.read']), tenantId: 'tenant-b' };
      expect(statusOf(() => requireRouteAuth(forged, false, 'list'))).toBe(401);
      // A guest that also carries a user is not a guest.
      const both = { ...guestLocals(['widgets.read']), user: { id: 'u' } };
      expect(statusOf(() => requireRouteAuth(both, true))).toBeUndefined();
    });

    it('caps a guest page at 100 and leaves other callers at the route maximum', async () => {
      const { listBounds } = await emitted();
      const url = new URL('https://x.test/api?limit=1000');
      expect(listBounds(url, guestLocals(['widgets.read'])).limit).toBe(100);
      expect(listBounds(url, {}).limit).toBe(1000);
      expect(
        listBounds(new URL('https://x.test/api'), guestLocals(['widgets.read']))
          .limit,
      ).toBeLessThanOrEqual(100);
    });
  });
});
