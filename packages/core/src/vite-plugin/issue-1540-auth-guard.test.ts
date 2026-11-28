/**
 * Test for issue #1540 (increment 2c): fail-closed authorization on generated
 * SvelteKit routes.
 *
 * Every generated CRUD handler calls `requireRouteAccess(locals, op, mutating)`,
 * which throws 401 unless the object opts out via `@smrt({ api: { public } })`.
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
import { apiPrincipalFromLocals, authorize } from '../generators/route-authz';
import {
  createGuestRequestPrincipal,
  GUEST_MAX_LIST_LIMIT,
  guestPrincipalOf,
  isGuestAllowedOnRoute,
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
        line('const GUEST_QUALIFIED_MODEL'),
        line('const RUNTIME_MODEL'),
        line('const PERMISSION_COLLECTION'),
        line('const PUBLIC_ACCESS'),
        line('const ALLOW_SUPER_ADMIN_BYPASS'),
        line('const TENANT_COLUMNS'),
        between(
          '// The principal of this request',
          '// A write body may not name',
        ),
        bounds,
        'return { requireRouteAuth: requireRouteAccess, listBounds };',
      ].join('\n');
      const js = ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).outputText;
      const error = (status: number, message: string) =>
        Object.assign(new Error(message), { status });
      return new Function(
        'error',
        'GUEST_MAX_LIST_LIMIT',
        'guestCreateAdmission',
        'guestPrincipalOf',
        'guestReadThrottle',
        'handleGuestCreate',
        'isGuestAllowedOnRoute',
        'apiPrincipalFromLocals',
        'authorize',
        'isRuntimeModelEnabled',
        'getCurrentTenant',
        js,
      )(
        error,
        GUEST_MAX_LIST_LIMIT,
        () => null,
        guestPrincipalOf,
        () => null,
        async () => new Response(null, { status: 201 }),
        isGuestAllowedOnRoute,
        apiPrincipalFromLocals,
        authorize,
        () => true,
        () => undefined,
      ) as {
        requireRouteAuth: (
          locals: unknown,
          op: string,
          mutating: boolean,
        ) => void;
        listBounds: (
          url: URL,
          locals: unknown,
        ) => { limit: number; offset: number };
      };
    }

    const guestLocals = (
      permissions: string[],
      model: string | null = '@test/smrt:Widget',
    ) => ({
      tenantId: 'tenant-a',
      permissions,
      guestPrincipal: createGuestRequestPrincipal({
        tenantId: 'tenant-a',
        permissions,
        // The ceiling admits each slug for ONE model (#5196).
        ...(model
          ? { slugModels: permissions.map((s) => [s, model] as const) }
          : {}),
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
        statusOf(() => requireRouteAuth(guest, 'list', false)),
      ).toBeUndefined();
      expect(
        statusOf(() => requireRouteAuth(guest, 'get', false)),
      ).toBeUndefined();
      // Writes, custom actions and other collections deny as anonymous does.
      expect(statusOf(() => requireRouteAuth(guest, 'create', true))).toBe(401);
      expect(statusOf(() => requireRouteAuth(guest, 'archive', false))).toBe(
        401,
      );
      expect(
        statusOf(() =>
          requireRouteAuth(guestLocals(['widgets.create']), 'list', false),
        ),
      ).toBe(401);
      expect(
        statusOf(() =>
          requireRouteAuth(guestLocals(['gadgets.read']), 'list', false),
        ),
      ).toBe(401);
      expect(
        statusOf(() => requireRouteAuth(guestLocals([]), 'list', false)),
      ).toBe(401);
    });

    it('a slug admitted for another model, or for none, never opens this route', async () => {
      const { requireRouteAuth } = await emitted();
      // Another model that shares the collection name `widgets`.
      expect(
        statusOf(() =>
          requireRouteAuth(
            guestLocals(['widgets.read'], '@test/other:Widget'),
            'list',
            false,
          ),
        ),
      ).toBe(401);
      // No admitted-model map at all (a host that did not compute one).
      expect(
        statusOf(() =>
          requireRouteAuth(guestLocals(['widgets.read'], null), 'get', false),
        ),
      ).toBe(401);
    });

    it('update, delete and every other write stay refused for a guest, whatever it holds', async () => {
      const { requireRouteAuth } = await emitted();
      // The create grant opens ONLY the guest create pipeline, which is a
      // separate branch of the POST handler; the generic guard never admits it.
      const guest = guestLocals([
        'widgets.create',
        'widgets.update',
        'widgets.delete',
      ]);
      for (const op of ['create', 'update', 'delete', 'sync', 'archive']) {
        expect(statusOf(() => requireRouteAuth(guest, op, true))).toBe(401);
      }
    });

    it('a guest on a public route is served as the public contract says', async () => {
      // `public` routes stay public for a guest as for an anonymous caller
      // (#5195 semantics): row policies bound a guest to its permission set.
      const { requireRouteAuth } = await emitted({
        include: ['list', 'get', 'create'],
        public: 'read',
      });
      for (const guest of [
        guestLocals(['widgets.read']),
        guestLocals([]),
        guestLocals(['gadgets.read']),
      ]) {
        expect(
          statusOf(() => requireRouteAuth(guest, 'list', false)),
        ).toBeUndefined();
        // A write on a read-public route still needs sign-in.
        expect(statusOf(() => requireRouteAuth(guest, 'create', true))).toBe(
          401,
        );
      }
    });

    it('anonymous and forged callers stay 401', async () => {
      const { requireRouteAuth } = await emitted();
      expect(statusOf(() => requireRouteAuth({}, 'list', false))).toBe(401);
      expect(
        statusOf(() => requireRouteAuth({ auth: () => true }, 'list', false)),
      ).toBe(401);
      // A marker that disagrees with the locals tenant is not a guest.
      const forged = { ...guestLocals(['widgets.read']), tenantId: 'tenant-b' };
      expect(statusOf(() => requireRouteAuth(forged, 'list', false))).toBe(401);
      // A guest that also carries a user is not a guest: the user decides.
      const both = { ...guestLocals(['widgets.read']), user: { id: 'u' } };
      expect(
        statusOf(() => requireRouteAuth(both, 'list', false)),
      ).toBeUndefined();
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
