/**
 * A model whose tenancy is reported at runtime for its qualified identity only
 * never gets a shared-cache policy on generated list and item reads, even when
 * it opts into `api.cache.sMaxage`: the body varies with the request's tenant,
 * which a URL-keyed shared cache cannot see.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { field } from '../decorators';
import {
  setDispatchTenantResolver,
  setTenantScopedClassResolver,
} from '../dispatch';
import { SmrtObject } from '../object';
import { ObjectRegistry } from '../registry';
import { getTestDatabase } from '../testing/database';
import { APIGenerator } from './rest';

class CachedScopeDoc extends SmrtObject {
  @field({ type: 'text' })
  name = '';

  @field({ type: 'text', nullable: true })
  tenantId: string | null = null;
}
// Registered under a package, so its identity is the qualified name only.
ObjectRegistry.register(CachedScopeDoc, {
  packageName: '@fixture/read-cache-scope',
  api: { public: 'read', include: ['list', 'get'], cache: { sMaxage: 60 } },
});
class CachedScopeDocCollection extends SmrtCollection<CachedScopeDoc> {
  static readonly _itemClass = CachedScopeDoc;
}

describe('shared-cache policy follows the runtime tenancy of the qualified model', () => {
  let db: Awaited<ReturnType<typeof getTestDatabase>>;
  let handler: (req: Request) => Promise<Response>;
  let qualified: string;
  let rowId: string;

  beforeAll(async () => {
    ObjectRegistry.registerCollection(
      'CachedScopeDoc',
      CachedScopeDocCollection,
    );
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['CachedScopeDoc'],
    });
    qualified =
      ObjectRegistry.getClass('CachedScopeDoc')?.qualifiedName ??
      'CachedScopeDoc';
    expect(qualified).toBe('@fixture/read-cache-scope:CachedScopeDoc');
    const collection = await CachedScopeDocCollection.create({ db });
    const row = await collection.create({ name: 'global-row' });
    await row.save();
    rowId = (row as unknown as { id: string }).id;
    // No collection registered with the generator: the routes are auto-discovered.
    handler = new APIGenerator(
      { basePath: '/api/v1' },
      { db },
    ).generateHandler();
  });

  afterAll(async () => {
    await db?.close?.();
  });

  afterEach(() => {
    setDispatchTenantResolver(undefined);
    setTenantScopedClassResolver(undefined);
  });

  const read = async (path: string) => {
    const res = await handler(
      new Request(`http://local/api/v1/cachedscopedocs${path}`),
    );
    expect(res.status).toBe(200);
    return res.headers.get('cache-control') ?? '';
  };

  it.each([
    ['list', ''],
    ['item', '/ID'],
  ])('a %s read of a runtime-tenancy model is never shared-cacheable', async (_kind, suffix) => {
    setDispatchTenantResolver(() => undefined);
    setTenantScopedClassResolver((name) => name === qualified);
    const header = await read(suffix.replace('ID', rowId));
    expect(header).not.toMatch(/s-maxage/);
    expect(header).toMatch(/private/);
  });

  it.each([
    ['list', ''],
    ['item', '/ID'],
  ])('control: a %s read of a model with no tenancy keeps the shared-cache opt-in', async (_kind, suffix) => {
    const header = await read(suffix.replace('ID', rowId));
    expect(header).toBe('public, max-age=0, s-maxage=60');
  });
});
