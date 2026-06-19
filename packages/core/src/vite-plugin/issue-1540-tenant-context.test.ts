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
  await generateSvelteKitRoutes(projectRoot, manifest, {
    enabled: true,
    routesDir: 'src/routes/api',
    objectsDir: 'src/lib/objects',
    configPath: 'src/lib/server',
    configFileName: 'smrt.ts',
  });
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
});
