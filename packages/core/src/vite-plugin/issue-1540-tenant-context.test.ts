/**
 * Test for issue #1540 (facet 2): tenant-context establishment in generated
 * SvelteKit routes.
 *
 * Generated routes for `@TenantScoped` objects must enter the tenant context
 * (from the authenticated principal's `locals.tenantId`) before touching the
 * collection, so `@TenantScoped` interceptors auto-filter every query. Without
 * it, an `optional`-mode scoped object would return cross-tenant rows. Routes
 * for non-tenant objects must NOT pull in the tenancy dependency.
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

    // Tenancy import + helper present.
    expect(collectionRoute).toContain("from '@happyvertical/smrt-tenancy'");
    expect(collectionRoute).toContain('function establishTenantContext');
    // Established after the auth guard in every handler.
    expect(collectionRoute).toContain('establishTenantContext(locals);');
    expect(itemRoute).toContain('establishTenantContext(locals);');
    // Reads `locals.tenantId` (the canonical smrt-users field).
    expect(collectionRoute).toContain('l.tenantId');
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
    expect(collectionRoute).not.toContain('establishTenantContext');
    // Auth guard is still present (every route is fail-closed).
    expect(collectionRoute).toContain('requireRouteAuth(locals,');
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
      expect(route).toContain("from '@happyvertical/smrt-tenancy'");
      expect(route).toContain('function establishTenantContext');
      expect(route).toContain('const userId = l.userId ?? user?.id');
      expect(route).toContain('const rawPermissions = l.permissions;');
      expect(route).toContain("typeof userId !== 'string' || !userId");
      expect(route).toContain('!permissions');
      expect(route).toContain('enterTenantContext(');
      expect(route).toContain('{ tenantId, userId, permissions }');
      expect(route).toContain('establishTenantContext(locals);');
    }
    // Request body ownership values are intentionally absent from the helper.
    expect(collectionRoute).not.toContain('body.tenantId');
    expect(collectionRoute).not.toContain('body.userId');
  });
});
