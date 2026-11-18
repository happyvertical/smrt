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
          qualifiedName: '@test/smrt:PublicTenantDoc',
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

    // The scope is resolved at request time by core, from the live registry,
    // exactly as runtime REST resolves it; no manifest-derived helper.
    expect(collectionRoute).not.toContain('function tenantReadScope()');
    expect(collectionRoute).toContain(
      "import { applyWhereScope, resolveAnonymousTenantReadScope } from '@happyvertical/smrt-core';",
    );
    // List + count both carry the scope, applied by the helper the runtime
    // REST route uses so no spelling of the tenant key survives beside it.
    expect(collectionRoute).toContain(
      'const where = applyWhereScope(query.where, resolveAnonymousTenantReadScope("@test/smrt:PublicTenantDoc")) ?? {};',
    );
    expect(collectionRoute).not.toContain('...tenantReadScope()');
    // #2367 added the deterministic ordering; the read scope still rides along.
    expect(collectionRoute).toContain(
      'collection.list({ limit, offset, orderBy, where })',
    );
    expect(collectionRoute).toContain('collection.count({ where })');

    // Single-read get scopes the id lookup to global when no tenant is active.
    expect(itemRoute).toContain(
      'const readScope = resolveAnonymousTenantReadScope("@test/smrt:PublicTenantDoc");',
    );
    expect(itemRoute).toContain(
      'readScope ? { id: params.id, ...readScope } : params.id',
    );
  });

  it('scopes custom item GET action host loads to global rows', async () => {
    await generate({
      objects: {
        PublicTenantDoc: {
          qualifiedName: '@test/smrt:PublicTenantDoc',
          className: 'PublicTenantDoc',
          collection: 'publictenantdocs',
          fields: { title: { type: 'text' } },
          methods: {
            listVersions: {
              name: 'listVersions',
              parameters: [],
              returnType: 'Promise<any>',
              isPublic: true,
            },
          },
          decoratorConfig: {
            api: {
              public: 'read',
              include: ['listVersions'],
              routes: {
                listVersions: { method: 'GET', path: 'versions' },
              },
            },
            tenantScoped: { mode: 'optional' },
          },
        },
      },
    } as unknown as SmartObjectManifest);

    const actionRoute = findRouteContent(
      'publictenantdocs/[id]/versions/+server.ts',
    );

    expect(actionRoute).toContain(
      'const readScope = resolveAnonymousTenantReadScope("@test/smrt:PublicTenantDoc");',
    );
    expect(actionRoute).toContain(
      'readScope ? { id: params.id, ...readScope } : params.id',
    );
    expect(actionRoute).toContain('await item.listVersions()');
  });

  it('passes custom collection GET options through the fail-closed read scope', async () => {
    await generate({
      objects: {
        PublicTenantDoc: {
          qualifiedName: '@test/smrt:PublicTenantDoc',
          className: 'PublicTenantDoc',
          collection: 'publictenantdocs',
          fields: { title: { type: 'text' } },
          methods: {},
          decoratorConfig: {
            api: false,
            tenantScoped: { mode: 'optional' },
          },
        },
        PublicTenantDocCollection: {
          qualifiedName: '@test/smrt:PublicTenantDocCollection',
          className: 'PublicTenantDocCollection',
          collection: 'publictenantdocs',
          fields: {},
          methods: {
            getBySlug: {
              name: 'getBySlug',
              parameters: [{ name: 'options', type: 'any' }],
              returnType: 'Promise<any>',
              isPublic: true,
            },
          },
          decoratorConfig: {
            api: {
              public: 'read',
              include: ['getBySlug'],
              routes: {
                getBySlug: { method: 'GET', path: 'by-slug' },
              },
            },
          },
          extends: 'SmrtCollection',
          extendsTypeArg: 'PublicTenantDoc',
        },
      },
    } as unknown as SmartObjectManifest);

    const collectionActionRoute = findRouteContent(
      'publictenantdocs/by-slug/+server.ts',
    );

    // Core's shared helper takes ownership out of the caller's options and
    // sets the request's scope under the ownership field, resolving tenancy
    // and the super-admin bypass at request time.
    expect(collectionActionRoute).toContain(
      'const scopedOptions = scopeTenantReadOptions("@test/smrt:PublicTenantDoc", options);',
    );
    expect(collectionActionRoute).toContain(
      "import { enterTenantContext, getCurrentTenant } from '@happyvertical/smrt-tenancy';",
    );
    expect(collectionActionRoute).toContain(
      'await typedCollection.getBySlug(scopedOptions)',
    );
  });

  it('resolves the scope of a model without manifest tenancy at request time, with no tenancy import', async () => {
    await generate({
      objects: {
        PlainDoc: {
          qualifiedName: '@test/smrt:PlainDoc',
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

    // Tenancy can be registered at runtime, so every read asks core; for a
    // model that is not tenant-scoped the answer is no scope at all.
    expect(collectionRoute).not.toContain('@happyvertical/smrt-tenancy');
    expect(collectionRoute).toContain(
      'resolveAnonymousTenantReadScope("@test/smrt:PlainDoc")',
    );
    expect(collectionRoute).toContain(
      'collection.list({ limit, offset, orderBy, where })',
    );
    expect(itemRoute).not.toContain('@happyvertical/smrt-tenancy');
    expect(itemRoute).toContain(
      'const readScope = resolveAnonymousTenantReadScope("@test/smrt:PlainDoc");',
    );
  });
});
