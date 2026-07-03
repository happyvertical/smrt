/**
 * Integration coverage for conditional GET on generated REST read routes,
 * driven through `APIGenerator.generateHandler()` against a real in-memory
 * SQLite database (per repo testing rules — nothing internal is mocked).
 * Asserts the HTTP semantics end to end: strong ETags on list/get,
 * `If-None-Match` → 304 with an empty body, ETag change after a mutation, the
 * Cache-Control policy per model config (private by default, shared `s-maxage`
 * only for public models that opt in), and that mutations/non-GET responses
 * are untouched. Mirrors the `rest-routes.spec.ts` setup.
 *
 * ETag v2 (#1765): the validator source is now the change feed's per-table
 * version (#1758) rather than the v1 response-body hash (#1757). All the v1
 * HTTP semantics above are preserved — this file is their regression guard —
 * and the final block adds the v2 headline: a matching `If-None-Match` answers
 * `304` WITHOUT executing the underlying collection query (query observation).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { registerChangeFeedWriter } from '../change-feed';
import { SmrtCollection } from '../collection';
import { field } from '../decorators';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { getTestDatabase } from '../testing/database';
import { APIGenerator } from './rest';

// Public model with the shared-cache opt-in → public, max-age=0, s-maxage=300.
@smrt({ api: { public: true, cache: { sMaxage: 300 } } })
class CondGetPublicCached extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
  }
}

class CondGetPublicCachedCollection extends SmrtCollection<CondGetPublicCached> {
  static readonly _itemClass = CondGetPublicCached;
}

// Public model WITHOUT a cache opt-in → default private, no-cache.
@smrt({ api: { public: true } })
class CondGetPublicPlain extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
  }
}

class CondGetPublicPlainCollection extends SmrtCollection<CondGetPublicPlain> {
  static readonly _itemClass = CondGetPublicPlain;
}

// NON-public model that (mis)configures sMaxage — shared-cache headers must
// NEVER be emitted for it; reads served behind auth stay private.
@smrt({ api: { cache: { sMaxage: 600 } } })
class CondGetPrivateCached extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
  }
}

class CondGetPrivateCachedCollection extends SmrtCollection<CondGetPrivateCached> {
  static readonly _itemClass = CondGetPrivateCached;
}

// Tenant-scoped model that (mis)configures public reads + sMaxage — the
// cross-tenant cache-leak guard (#1757 review): its body varies with the
// session-cookie tenant context, so shared caches must NEVER store it.
@smrt({
  tenantScoped: true,
  api: { public: 'read', cache: { sMaxage: 600 } },
})
class CondGetTenantScoped extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
  }
}

class CondGetTenantScopedCollection extends SmrtCollection<CondGetTenantScoped> {
  static readonly _itemClass = CondGetTenantScoped;
}

describe('REST conditional GET + cache-control policy (#1757)', () => {
  ObjectRegistry.registerCollection(
    'CondGetPublicCached',
    CondGetPublicCachedCollection,
  );
  ObjectRegistry.registerCollection(
    'CondGetPublicPlain',
    CondGetPublicPlainCollection,
  );
  ObjectRegistry.registerCollection(
    'CondGetPrivateCached',
    CondGetPrivateCachedCollection,
  );
  ObjectRegistry.registerCollection(
    'CondGetTenantScoped',
    CondGetTenantScopedCollection,
  );

  let db: any;
  let handler: (req: Request) => Promise<Response>;

  beforeAll(async () => {
    // ETag v2 (#1765) derives the validator from the change-feed table version,
    // so a mutation only changes the ETag when it appends a change entry.
    // Re-register defensively in case another suite cleared GlobalInterceptors.
    registerChangeFeedWriter();
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: [
        'CondGetPublicCached',
        'CondGetPublicPlain',
        'CondGetPrivateCached',
        'CondGetTenantScoped',
      ],
    });

    const api = new APIGenerator({
      basePath: '/api/v1',
      // Passthrough auth so the non-public model's reads are reachable — the
      // point under test is the header policy, not the auth gate (#1540 owns
      // that).
      authMiddleware: () => async (req) => req,
    });
    api.registerCollection(
      'publiccached',
      await CondGetPublicCachedCollection.create({ db }),
    );
    api.registerCollection(
      'publicplain',
      await CondGetPublicPlainCollection.create({ db }),
    );
    api.registerCollection(
      'privatecached',
      await CondGetPrivateCachedCollection.create({ db }),
    );
    api.registerCollection(
      'tenantscoped',
      await CondGetTenantScopedCollection.create({ db }),
    );
    handler = api.generateHandler();
  });

  afterAll(async () => {
    await db?.close?.();
  });

  const create = (path: string, body: Record<string, unknown>) =>
    handler(
      new Request(`http://local/api/v1/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );

  describe('ETag + 304 semantics on list and get', () => {
    let itemId: string;

    beforeAll(async () => {
      const res = await create('publicplain', { name: 'first' });
      expect(res.status).toBe(201);
      itemId = ((await res.json()) as any).id;
    });

    it('list responses carry a strong ETag and the private default policy', async () => {
      const res = await handler(new Request('http://local/api/v1/publicplain'));
      expect(res.status).toBe(200);
      expect(res.headers.get('etag')).toMatch(/^"[A-Za-z0-9_-]+"$/);
      expect(res.headers.get('cache-control')).toBe('private, no-cache');
    });

    it('a matching If-None-Match on list returns 304 with an empty body', async () => {
      const first = await handler(
        new Request('http://local/api/v1/publicplain'),
      );
      const etag = first.headers.get('etag') as string;

      const revalidated = await handler(
        new Request('http://local/api/v1/publicplain', {
          headers: { 'if-none-match': etag },
        }),
      );
      expect(revalidated.status).toBe(304);
      expect(await revalidated.text()).toBe('');
      // 304 still carries the validator + policy so caches stay primed.
      expect(revalidated.headers.get('etag')).toBe(etag);
      expect(revalidated.headers.get('cache-control')).toBe(
        'private, no-cache',
      );
    });

    it('a matching If-None-Match on get /:id returns 304 with an empty body', async () => {
      const first = await handler(
        new Request(`http://local/api/v1/publicplain/${itemId}`),
      );
      expect(first.status).toBe(200);
      const etag = first.headers.get('etag') as string;
      expect(etag).toMatch(/^"/);

      const revalidated = await handler(
        new Request(`http://local/api/v1/publicplain/${itemId}`, {
          headers: { 'if-none-match': etag },
        }),
      );
      expect(revalidated.status).toBe(304);
      expect(await revalidated.text()).toBe('');
    });

    it('a stale If-None-Match returns 200 with the full body', async () => {
      const res = await handler(
        new Request(`http://local/api/v1/publicplain/${itemId}`, {
          headers: { 'if-none-match': '"long-gone"' },
        }),
      );
      expect(res.status).toBe(200);
      expect(((await res.json()) as any).id).toBe(itemId);
    });

    it('a mutation changes the ETag: the old one revalidates as 200 + new ETag', async () => {
      const before = await handler(
        new Request(`http://local/api/v1/publicplain/${itemId}`),
      );
      const oldEtag = before.headers.get('etag') as string;

      const update = await handler(
        new Request(`http://local/api/v1/publicplain/${itemId}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'renamed' }),
        }),
      );
      expect(update.status).toBe(200);

      const after = await handler(
        new Request(`http://local/api/v1/publicplain/${itemId}`, {
          headers: { 'if-none-match': oldEtag },
        }),
      );
      expect(after.status).toBe(200);
      const newEtag = after.headers.get('etag') as string;
      expect(newEtag).not.toBe(oldEtag);
      expect(((await after.json()) as any).name).toBe('renamed');

      // And the new ETag now revalidates to 304.
      const settled = await handler(
        new Request(`http://local/api/v1/publicplain/${itemId}`, {
          headers: { 'if-none-match': newEtag },
        }),
      );
      expect(settled.status).toBe(304);
    });

    it('mutations after a list change the list ETag too', async () => {
      const before = await handler(
        new Request('http://local/api/v1/publicplain'),
      );
      const oldEtag = before.headers.get('etag') as string;

      const res = await create('publicplain', { name: 'second' });
      expect(res.status).toBe(201);

      const after = await handler(
        new Request('http://local/api/v1/publicplain', {
          headers: { 'if-none-match': oldEtag },
        }),
      );
      expect(after.status).toBe(200);
      expect(after.headers.get('etag')).not.toBe(oldEtag);
    });

    it('404 reads carry no ETag or cache-control', async () => {
      const res = await handler(
        new Request('http://local/api/v1/publicplain/does-not-exist'),
      );
      expect(res.status).toBe(404);
      expect(res.headers.get('etag')).toBeNull();
      expect(res.headers.get('cache-control')).toBeNull();
    });
  });

  describe('Cache-Control policy per model config', () => {
    it('public + cache.sMaxage opts reads into shared caching', async () => {
      const res = await handler(
        new Request('http://local/api/v1/publiccached'),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe(
        'public, max-age=0, s-maxage=300',
      );
    });

    it('public without a cache opt-in stays private', async () => {
      const res = await handler(new Request('http://local/api/v1/publicplain'));
      expect(res.headers.get('cache-control')).toBe('private, no-cache');
    });

    it('NON-public models NEVER emit shared-cache headers, even with sMaxage configured', async () => {
      const created = await create('privatecached', { name: 'secret' });
      expect(created.status).toBe(201);
      const id = ((await created.json()) as any).id;

      for (const path of ['privatecached', `privatecached/${id}`]) {
        const res = await handler(new Request(`http://local/api/v1/${path}`));
        expect(res.status).toBe(200);
        const cacheControl = res.headers.get('cache-control') as string;
        expect(cacheControl).toBe('private, no-cache');
        expect(cacheControl).not.toContain('s-maxage');
        expect(cacheControl).not.toContain('public');
      }
    });

    it('tenant-scoped models NEVER emit shared-cache headers, even public + sMaxage (#1757 review)', async () => {
      const created = await create('tenantscoped', { name: 'tenant-a-row' });
      expect(created.status).toBe(201);
      const id = ((await created.json()) as any).id;

      for (const path of ['tenantscoped', `tenantscoped/${id}`]) {
        const res = await handler(new Request(`http://local/api/v1/${path}`));
        expect(res.status).toBe(200);
        const cacheControl = res.headers.get('cache-control') as string;
        expect(cacheControl).toBe('private, no-cache');
        expect(cacheControl).not.toContain('s-maxage');
        expect(cacheControl).not.toContain('public');
      }
    });

    it('tenant-scoped reads still support conditional revalidation (304)', async () => {
      const first = await handler(
        new Request('http://local/api/v1/tenantscoped'),
      );
      const etag = first.headers.get('etag') as string;
      expect(etag).toMatch(/^"/);

      const revalidated = await handler(
        new Request('http://local/api/v1/tenantscoped', {
          headers: { 'if-none-match': etag },
        }),
      );
      expect(revalidated.status).toBe(304);
      expect(await revalidated.text()).toBe('');
      expect(revalidated.headers.get('cache-control')).toBe(
        'private, no-cache',
      );
    });

    it('conditional revalidation still works on shared-cacheable reads', async () => {
      const first = await handler(
        new Request('http://local/api/v1/publiccached'),
      );
      const etag = first.headers.get('etag') as string;

      const revalidated = await handler(
        new Request('http://local/api/v1/publiccached', {
          headers: { 'if-none-match': etag },
        }),
      );
      expect(revalidated.status).toBe(304);
      expect(await revalidated.text()).toBe('');
      expect(revalidated.headers.get('cache-control')).toBe(
        'public, max-age=0, s-maxage=300',
      );
    });
  });

  describe('mutations and non-GET responses stay as-is', () => {
    it('POST responses carry no ETag and no cache-control', async () => {
      const res = await create('publicplain', { name: 'no-etag' });
      expect(res.status).toBe(201);
      expect(res.headers.get('etag')).toBeNull();
      expect(res.headers.get('cache-control')).toBeNull();
    });

    it('PUT responses carry no ETag and no cache-control', async () => {
      const created = await create('publicplain', { name: 'mutate-me' });
      const id = ((await created.json()) as any).id;

      const res = await handler(
        new Request(`http://local/api/v1/publicplain/${id}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'mutated' }),
        }),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('etag')).toBeNull();
      expect(res.headers.get('cache-control')).toBeNull();
    });

    it('If-None-Match on a mutation is ignored (no 304 for PUT)', async () => {
      const created = await create('publicplain', { name: 'cond-put' });
      const id = ((await created.json()) as any).id;
      const read = await handler(
        new Request(`http://local/api/v1/publicplain/${id}`),
      );
      const etag = read.headers.get('etag') as string;

      const res = await handler(
        new Request(`http://local/api/v1/publicplain/${id}`, {
          method: 'PUT',
          headers: {
            'content-type': 'application/json',
            'if-none-match': etag,
          },
          body: JSON.stringify({ name: 'cond-put-2' }),
        }),
      );
      expect(res.status).toBe(200);
      expect(((await res.json()) as any).name).toBe('cond-put-2');
    });
  });

  // ETag v2 headline (#1765): the whole point of moving the ETag source to the
  // per-table change-feed version is that a matching If-None-Match can answer
  // 304 without the collection query ever running. Prove it by spying on the
  // collection and asserting it is never touched on the conditional hit.
  describe('ETag v2: a matching If-None-Match skips the collection query (#1765)', () => {
    let qdb: any;
    let collection: CondGetPublicPlainCollection;
    let qhandler: (req: Request) => Promise<Response>;

    beforeAll(async () => {
      registerChangeFeedWriter();
      qdb = await getTestDatabase({
        type: 'sqlite',
        url: ':memory:',
        classes: ['CondGetPublicPlain'],
      });
      collection = await CondGetPublicPlainCollection.create({ db: qdb });
      const api = new APIGenerator({
        basePath: '/api/v1',
        authMiddleware: () => async (req) => req,
      });
      api.registerCollection('q1765', collection);
      qhandler = api.generateHandler();

      const created = await qhandler(
        new Request('http://local/api/v1/q1765', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'seed' }),
        }),
      );
      expect(created.status).toBe(201);
    });

    afterAll(async () => {
      await qdb?.close?.();
    });

    it('list: a 304 revalidation does NOT call collection.list (zero-query)', async () => {
      const first = await qhandler(new Request('http://local/api/v1/q1765'));
      expect(first.status).toBe(200);
      const etag = first.headers.get('etag') as string;

      const listSpy = vi.spyOn(collection, 'list');
      try {
        const revalidated = await qhandler(
          new Request('http://local/api/v1/q1765', {
            headers: { 'if-none-match': etag },
          }),
        );
        expect(revalidated.status).toBe(304);
        expect(await revalidated.text()).toBe('');
        // The headline assertion: the underlying query never ran.
        expect(listSpy).not.toHaveBeenCalled();

        // Control: a non-conditional read on the same route DOES run the query,
        // proving the spy would have caught a query if one had happened.
        const fresh = await qhandler(new Request('http://local/api/v1/q1765'));
        expect(fresh.status).toBe(200);
        expect(listSpy).toHaveBeenCalled();
      } finally {
        listSpy.mockRestore();
      }
    });

    it('get: a 304 revalidation does NOT call collection.get (zero-query)', async () => {
      const listRes = await qhandler(new Request('http://local/api/v1/q1765'));
      const rows = (await listRes.json()) as Array<{ id: string }>;
      const id = rows[0].id;

      const first = await qhandler(
        new Request(`http://local/api/v1/q1765/${id}`),
      );
      expect(first.status).toBe(200);
      const etag = first.headers.get('etag') as string;

      const getSpy = vi.spyOn(collection, 'get');
      try {
        const revalidated = await qhandler(
          new Request(`http://local/api/v1/q1765/${id}`, {
            headers: { 'if-none-match': etag },
          }),
        );
        expect(revalidated.status).toBe(304);
        expect(await revalidated.text()).toBe('');
        expect(getSpy).not.toHaveBeenCalled();
      } finally {
        getSpy.mockRestore();
      }
    });

    it('a write to the table advances the version, so the stale ETag re-runs the query as 200', async () => {
      const first = await qhandler(new Request('http://local/api/v1/q1765'));
      const staleEtag = first.headers.get('etag') as string;

      // Any framework write to the table (here a create) bumps its version.
      const created = await qhandler(
        new Request('http://local/api/v1/q1765', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'another' }),
        }),
      );
      expect(created.status).toBe(201);

      const listSpy = vi.spyOn(collection, 'list');
      try {
        const after = await qhandler(
          new Request('http://local/api/v1/q1765', {
            headers: { 'if-none-match': staleEtag },
          }),
        );
        expect(after.status).toBe(200);
        expect(after.headers.get('etag')).not.toBe(staleEtag);
        // The version moved, so this is a real read — the query runs.
        expect(listSpy).toHaveBeenCalled();
      } finally {
        listSpy.mockRestore();
      }
    });
  });
});
