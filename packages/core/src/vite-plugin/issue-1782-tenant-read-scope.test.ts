/**
 * Test for issue #1782 (SvelteKit transport): generated routes for a
 * `@TenantScoped` + `api.public` model must fail closed to global (NULL-tenant)
 * rows when no tenant context is active, instead of returning every tenant's
 * rows to an anonymous caller.
 *
 * Asserts the emitted route source carries the fail-closed read scope on the
 * read handlers (list, count, get /:id) and that non-tenant models are
 * unaffected. Companion to `issue-1782-tenant-read-scope.spec.ts` (REST runtime)
 * and mirrors `issue-1540-tenant-context.test.ts`.
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

describe('Issue #1782: fail-closed tenant read scope in generated routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readFileSync).mockReturnValue('');
    vi.mocked(readdirSync).mockReturnValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('scopes list/count/get to global rows for a @TenantScoped public model', async () => {
    await generate({
      objects: {
        PublicTenantDoc: {
          className: 'PublicTenantDoc',
          collection: 'publictenantdocs',
          fields: { title: { type: 'text' } },
          methods: {},
          decoratorConfig: {
            api: { public: 'read', include: ['list', 'get'] },
            tenantScoped: { mode: 'optional' },
          },
        },
      },
    } as unknown as SmartObjectManifest);

    const collectionRoute = findRouteContent('publictenantdocs/+server.ts');
    const itemRoute = findRouteContent('publictenantdocs/[id]/+server.ts');

    // The fail-closed helper is emitted and depends on isTenancyEnabled().
    expect(collectionRoute).toContain('function tenantReadScope()');
    expect(collectionRoute).toContain('isTenancyEnabled()');
    expect(collectionRoute).toContain('!hasTenantContext()');
    expect(collectionRoute).toContain('{ tenantId: null }');

    // List + count both carry the scope.
    expect(collectionRoute).toContain('const readScope = tenantReadScope();');
    expect(collectionRoute).toContain(
      'collection.list({ limit, offset, where: readScope })',
    );
    expect(collectionRoute).toContain('collection.count({ where: readScope })');

    // Single-read get scopes the id lookup to global when no tenant is active.
    expect(itemRoute).toContain('const readScope = tenantReadScope();');
    expect(itemRoute).toContain(
      'readScope ? { id: params.id, ...readScope } : params.id',
    );
  });

  it('does NOT add the read scope to a non-tenant model’s routes', async () => {
    await generate({
      objects: {
        PlainDoc: {
          className: 'PlainDoc',
          collection: 'plaindocs',
          fields: { title: { type: 'text' } },
          methods: {},
          decoratorConfig: {
            api: { public: 'read', include: ['list', 'get'] },
          },
        },
      },
    } as unknown as SmartObjectManifest);

    const collectionRoute = findRouteContent('plaindocs/+server.ts');
    const itemRoute = findRouteContent('plaindocs/[id]/+server.ts');

    expect(collectionRoute).not.toContain('tenantReadScope');
    expect(collectionRoute).not.toContain('@happyvertical/smrt-tenancy');
    expect(collectionRoute).toContain('collection.list({ limit, offset })');
    expect(itemRoute).not.toContain('tenantReadScope');
    expect(itemRoute).toContain('collection.get(params.id)');
  });
});
