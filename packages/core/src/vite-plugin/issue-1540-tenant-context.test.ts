/**
 * Test for issue #1540 (facet 2): tenant-context establishment in generated
 * SvelteKit routes.
 *
 * Every generated route resolves the request's tenancy through core
 * (`enterRequestTenancy`, #5375) before touching the collection: the actor from
 * the authenticated principal's `locals`, the model's policy at request time,
 * and the tenant context every query then runs in. The manifest's tenancy
 * selects nothing, so no route imports the tenancy package. The decisions
 * themselves are exercised in `src/__tests__/request-tenancy.test.ts` and the
 * smrt-tenancy `effective-tenancy-*` suites.
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

async function generate(manifest: SmartObjectManifest): Promise<void> {
  const packageName = manifest.packageName ?? '@test/tenant-context';
  await generateSvelteKitRoutes(
    projectRoot,
    {
      ...manifest,
      packageName,
      objects: Object.fromEntries(
        Object.entries(manifest.objects).map(([key, objectDef]) => [
          key,
          objectDef.qualifiedName?.includes(':') || key.includes(':')
            ? objectDef
            : {
                ...objectDef,
                qualifiedName: `${packageName}:${objectDef.className}`,
              },
        ]),
      ),
    } as SmartObjectManifest,
    {
      enabled: true,
      routesDir: 'src/routes/api',
      objectsDir: 'src/lib/objects',
      configPath: 'src/lib/server',
      configFileName: 'smrt.ts',
    },
  );
}

describe('Issue #1540 (facet 2): tenant-context establishment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readFileSync).mockReturnValue('');
    vi.mocked(readdirSync).mockReturnValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('establishes tenant context in a @TenantScoped object’s routes', async () => {
    await generate({
      packageName: '@test/fields',
      objects: {
        TenantDoc: {
          className: 'TenantDoc',
          collection: 'tenantdocs',
          fields: { title: { type: 'text' } },
          methods: {},
          decoratorConfig: {
            api: { include: ['list', 'get', 'create', 'update', 'delete'] },
            tenantScoped: { mode: 'optional' },
          },
        },
      },
    } as unknown as SmartObjectManifest);

    const collectionRoute = findRouteContent('tenantdocs/+server.ts');
    const itemRoute = findRouteContent('tenantdocs/[id]/+server.ts');

    for (const route of [collectionRoute, itemRoute]) {
      // Core resolves the request's tenancy; nothing comes from the tenancy
      // package or the manifest flag.
      expect(route).toContain('enterRequestTenancy,');
      expect(route).not.toContain('@happyvertical/smrt-tenancy');
      expect(route).not.toContain('isTenantScopedModel');
      expect(route).toContain(
        'const TENANCY_MODEL = "@test/fields:TenantDoc";',
      );
      expect(route).toContain('requirePrincipal: false,');
    }
    // Entered after the auth guard in every handler, for the operation it
    // performs.
    expect(collectionRoute).toContain(
      'const tenancy = enterTenancy(locals, "list");',
    );
    expect(collectionRoute).toContain('enterTenancy(locals, "create");');
    expect(itemRoute).toContain('const tenancy = enterTenancy(locals, "get");');
    expect(itemRoute).toContain('enterTenancy(locals, "update");');
    expect(itemRoute).toContain('enterTenancy(locals, "delete");');
    // A refusal is answered with its own status.
    expect(collectionRoute).toContain(
      'if (failure) throw error(failure.status, failure.message);',
    );
  });

  it('does NOT pull tenancy into a non-tenant object’s routes', async () => {
    await generate({
      objects: {
        PlainDoc: {
          className: 'PlainDoc',
          collection: 'plaindocs',
          fields: { title: { type: 'text' } },
          methods: {},
          decoratorConfig: {
            api: { include: ['list', 'get', 'create'] },
          },
        },
      },
    } as unknown as SmartObjectManifest);

    const collectionRoute = findRouteContent('plaindocs/+server.ts');
    expect(collectionRoute).not.toContain('@happyvertical/smrt-tenancy');
    // Tenancy can be registered at run time: the route resolves it per
    // request through core exactly as for a model that declares it, with no
    // generation-time switch.
    expect(collectionRoute).not.toContain('isTenantScopedModel');
    expect(collectionRoute).toContain('enterRequestTenancy,');
    expect(collectionRoute).toContain(
      'const TENANCY_MODEL = "@test/tenant-context:PlainDoc";',
    );
    expect(collectionRoute).toContain(
      'const tenancy = enterTenancy(locals, "list");',
    );
    expect(collectionRoute).toContain('enterTenancy(locals, "create");');
    // Auth guard is still present (every route is fail-closed).
    expect(collectionRoute).toContain('requireRouteAccess(locals,');
  });

  it('publishes only a complete trusted principal for opted-in non-tenant routes', async () => {
    await generate({
      objects: {
        FieldPolicy: {
          className: 'FieldPolicy',
          collection: 'fieldpolicies',
          fields: { scopeType: { type: 'text' } },
          methods: {
            editorState: {
              name: 'editorState',
              parameters: [],
              returnType: 'Promise<unknown>',
              isPublic: true,
            },
          },
          decoratorConfig: {
            api: {
              include: ['create', 'editorState'],
              principalContext: true,
            },
          },
        },
      },
    } as unknown as SmartObjectManifest);

    const collectionRoute = findRouteContent('fieldpolicies/+server.ts');
    const actionRoute = findRouteContent(
      'fieldpolicies/[id]/editorState/+server.ts',
    );

    for (const route of [collectionRoute, actionRoute]) {
      // The complete-principal rule (tenant, user and permissions, the active
      // context refreshed with them) is core's `resolveRequestActor`; the
      // route asks for it.
      expect(route).not.toContain('@happyvertical/smrt-tenancy');
      expect(route).toContain('enterRequestTenancy,');
      expect(route).toContain('requirePrincipal: true,');
      expect(route).toContain('enterTenancy(locals, ');
    }
    // Request body ownership values are intentionally absent from the helper.
    expect(collectionRoute).not.toContain('body.tenantId');
    expect(collectionRoute).not.toContain('body.userId');
  });

  it('scopes a singleton STI base to its manifest, but not a plain model', async () => {
    await generate({
      packageName: '@test/sti',
      objects: {
        Doc: {
          className: 'Doc',
          collection: 'docs',
          fields: { title: { type: 'text' } },
          methods: {},
          decoratorConfig: {
            tableStrategy: 'sti',
            api: { include: ['list', 'get', 'create', 'update', 'delete'] },
          },
        },
        Plain: {
          className: 'Plain',
          collection: 'plains',
          fields: { title: { type: 'text' } },
          methods: {},
          decoratorConfig: { api: { include: ['list', 'get'] } },
        },
      },
    } as unknown as SmartObjectManifest);

    for (const suffix of ['docs/+server.ts', 'docs/[id]/+server.ts']) {
      const route = findRouteContent(suffix);
      expect(route).toContain(
        'const TENANCY_MODEL_SCOPE: ReadonlySet<string> = new Set(["@test/sti:Doc"]);',
      );
      expect(route).toContain('modelScope: TENANCY_MODEL_SCOPE');
    }
    for (const suffix of ['plains/+server.ts', 'plains/[id]/+server.ts']) {
      expect(findRouteContent(suffix)).not.toContain('TENANCY_MODEL_SCOPE');
    }
  });
});
