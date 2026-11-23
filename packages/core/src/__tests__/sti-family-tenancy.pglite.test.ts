/**
 * Point reads through an STI base whose member has a different tenancy, by
 * id and by slug, on SQLite and PGlite (`SMRT_TEST_PGLITE=1`, the core
 * `test:pglite` lane): row 29 of the #5375 test-design contract.
 *
 * Core cannot import smrt-tenancy; the test installs a policy source of its
 * own. The membership predicate (`_meta_type in` the admitted types) is
 * core's own enforcement, so no tenant interceptor is needed here.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection.js';
import { field } from '../decorators/index.js';
import { setDispatchTenantResolver } from '../dispatch/tenant-resolver.js';
import { APIGenerator } from '../generators/rest.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { setTenantPolicySource } from '../request-tenancy.js';
import { getTestDatabase } from '../testing/database.js';

const databaseType = process.env.SMRT_TEST_PGLITE === '1' ? 'pglite' : 'sqlite';
const databaseUrl = databaseType === 'pglite' ? 'memory://' : ':memory:';

@smrt({
  tableStrategy: 'sti',
  api: { include: ['list', 'get'], public: 'read' },
})
class FamilyArticle extends SmrtObject {
  @field({ type: 'text' }) title = '';
}
class FamilyArticleCollection extends SmrtCollection<FamilyArticle> {
  static readonly _itemClass = FamilyArticle;
}

@smrt({ api: { include: ['list', 'get'], public: 'read' } })
class FamilyOwnedArticle extends FamilyArticle {
  @field({ type: 'text', nullable: true }) tenantId: string | null = null;
}

const keyOf = (ctor: Function) => {
  const info = ObjectRegistry.getClassByConstructor(ctor as never);
  if (!info) throw new Error('fixture not registered');
  return info.qualifiedName || info.name;
};

const BASE_ROW = '11111111-1111-4111-8111-111111111111';
const OWNED_ROW = '22222222-2222-4222-8222-222222222222';

describe(`restricted family reads by id and slug (${databaseType})`, () => {
  let db: DatabaseInterface;
  let handler: (req: Request) => Promise<Response>;
  let segment = '';

  beforeAll(async () => {
    ObjectRegistry.registerCollection(
      'FamilyArticle',
      FamilyArticleCollection as never,
    );
    db = await getTestDatabase({
      type: databaseType,
      url: databaseUrl,
      classes: [keyOf(FamilyArticle), keyOf(FamilyOwnedArticle)],
    });
    const articles = await FamilyArticleCollection.create({ db });
    await articles.create({
      id: BASE_ROW,
      slug: 'base-article',
      title: 'base article',
    } as never);
    await articles.create({
      id: OWNED_ROW,
      slug: 'owned-article',
      title: 'owned article',
      tenantId: 'tenant-a',
      _meta_type: keyOf(FamilyOwnedArticle),
    } as never);
    // Tenancy on, with the member scoped and the base not.
    const owned = keyOf(FamilyOwnedArticle);
    setDispatchTenantResolver(() => 'tenant-a');
    setTenantPolicySource({
      policyOf: (key) =>
        key === owned
          ? {
              kind: 'resolved',
              policy: {
                mode: 'optional',
                field: 'tenantId',
                allowSuperAdminBypass: false,
              },
            }
          : { kind: 'absent' },
      systemContextActive: () => false,
      superAdminBypassActive: () => false,
      hierarchyReadCollections: () => undefined,
      runInContext: (_context, fn) => fn(),
    });
    segment = String(ObjectRegistry.getClass(keyOf(FamilyArticle))?.collection);
    handler = new APIGenerator(
      { basePath: '/api', resolveTenant: () => ({ tenantId: 'tenant-a' }) },
      { db },
    ).generateHandler();
  });

  afterAll(async () => {
    setTenantPolicySource(undefined);
    setDispatchTenantResolver(undefined);
    await db?.close?.();
  });

  const status = async (path: string) =>
    (await handler(new Request(`http://local/api/${segment}/${path}`))).status;

  it('restricted family reads by id and slug', async () => {
    expect(await status(BASE_ROW)).toBe(200);
    expect(await status('base-article')).toBe(200);
    expect(await status(OWNED_ROW)).toBe(404);
    expect(await status('owned-article')).toBe(404);
    const listed = await handler(new Request(`http://local/api/${segment}`));
    const titles = ((await listed.json()) as Array<{ title: string }>).map(
      (row) => row.title,
    );
    expect(titles).toEqual(['base article']);
  });
});
