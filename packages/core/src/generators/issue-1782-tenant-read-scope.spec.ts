/**
 * Integration coverage for issue #1782: a `@TenantScoped` model marked
 * `api.public` served an anonymous request with ZERO tenant filtering — the
 * generated REST read returned rows from EVERY tenant.
 *
 * Driven through `APIGenerator.generateHandler()` against a real in-memory
 * SQLite database (per repo testing rules — nothing internal is mocked). Tenant
 * scope is simulated at the core level via `setDispatchTenantResolver` (the same
 * hook `enableTenancy()` installs): returning `undefined` models "tenancy
 * enabled, no active tenant" — exactly the anonymous public-read case. The fix
 * fails closed to NULL-tenant (global) rows only.
 *
 * Mirrors `conditional-get.spec.ts` setup.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { field } from '../decorators';
import {
  setDispatchTenantResolver,
  setTenantScopedClassResolver,
} from '../dispatch';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { getTestDatabase } from '../testing/database';
import { APIGenerator } from './rest';

// Optional-mode tenant-scoped model marked publicly readable — the #1782
// footgun. tenantId is declared explicitly so the tenant_id column exists at the
// core level (the tenancy package's column injection is not in play here).
@smrt({ tenantScoped: { mode: 'optional' }, api: { public: 'read' } })
class PublicTenantDoc extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';

  @field({ type: 'text', nullable: true })
  tenantId: string | null = null;

  constructor(options: any = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
  }
}

class PublicTenantDocCollection extends SmrtCollection<PublicTenantDoc> {
  static readonly _itemClass = PublicTenantDoc;
}

// Pattern 1 (#1782 review): tenancy is declared via the standalone
// `@TenantScoped()` decorator, NOT `@smrt({ tenantScoped })`. Here the `@smrt`
// config carries NO tenantScoped, so `ObjectRegistry.isTenantScoped` is false —
// the model is recognized as tenant-scoped ONLY through the tenancy-filled
// `setTenantScopedClassResolver` hook (what `@TenantScoped()` wires at
// `enableTenancy()`). The guard must still fail closed for it.
@smrt({ api: { public: 'read' } })
class Pattern1TenantDoc extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';

  @field({ type: 'text', nullable: true })
  tenantId: string | null = null;

  constructor(options: any = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
  }
}

class Pattern1TenantDocCollection extends SmrtCollection<Pattern1TenantDoc> {
  static readonly _itemClass = Pattern1TenantDoc;
}

describe('REST tenant-scoped public read fails closed to global rows (#1782)', () => {
  ObjectRegistry.registerCollection(
    'PublicTenantDoc',
    PublicTenantDocCollection,
  );
  ObjectRegistry.registerCollection(
    'Pattern1TenantDoc',
    Pattern1TenantDocCollection,
  );

  let db: any;
  let handler: (req: Request) => Promise<Response>;
  const ids: Record<string, string> = {};

  const seed = async (
    collection: SmrtCollection<SmrtObject>,
    into: Record<string, string>,
  ) => {
    // Seed one row per tenant plus a global (NULL-tenant) row. Inserted through
    // the collection directly (not REST) so tenantId is set — the REST writable
    // policy strips framework-managed tenantId from create bodies.
    for (const [name, tenantId] of [
      ['tenant-a-row', 'tenant-a'],
      ['tenant-b-row', 'tenant-b'],
      ['global-row', null],
    ] as const) {
      const row = await collection.create({ name, tenantId });
      await row.save();
      into[name] = (row as unknown as { id: string }).id;
    }
  };

  beforeAll(async () => {
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['PublicTenantDoc', 'Pattern1TenantDoc'],
    });

    const collection = await PublicTenantDocCollection.create({ db });
    await seed(collection, ids);

    const pattern1 = await Pattern1TenantDocCollection.create({ db });
    await seed(pattern1, {});

    const api = new APIGenerator({ basePath: '/api/v1' });
    api.registerCollection('publictenantdoc', collection);
    api.registerCollection('pattern1tenantdoc', pattern1);
    handler = api.generateHandler();
  });

  afterAll(async () => {
    await db?.close?.();
  });

  afterEach(() => {
    // Reset the ambient resolvers so no test leaks tenant scope into another.
    setDispatchTenantResolver(undefined);
    setTenantScopedClassResolver(undefined);
  });

  const list = (query = '') =>
    handler(new Request(`http://local/api/v1/publictenantdoc${query}`));

  describe('tenancy enabled, no active tenant (anonymous public read)', () => {
    beforeAll(() => {
      // Simulate `enableTenancy()` with no active tenant context.
      setDispatchTenantResolver(() => undefined);
    });

    it('list returns ONLY the global (NULL-tenant) row', async () => {
      setDispatchTenantResolver(() => undefined);
      const res = await list();
      expect(res.status).toBe(200);
      // The REST list generator returns a bare array of items.
      const body = (await res.json()) as { name: string }[];
      const names = body.map((i) => i.name).sort();
      expect(names).toEqual(['global-row']);
    });

    it('count returns ONLY the global row cardinality', async () => {
      setDispatchTenantResolver(() => undefined);
      const res = await handler(
        new Request('http://local/api/v1/publictenantdoc/count'),
      );
      expect(res.status).toBe(200);
      expect(((await res.json()) as { count: number }).count).toBe(1);
    });

    it('get /:id of a tenant row is NOT found (scoped to global)', async () => {
      setDispatchTenantResolver(() => undefined);
      const res = await handler(
        new Request(
          `http://local/api/v1/publictenantdoc/${ids['tenant-a-row']}`,
        ),
      );
      expect(res.status).toBe(404);
    });

    it('get /:id of the global row IS found', async () => {
      setDispatchTenantResolver(() => undefined);
      const res = await handler(
        new Request(`http://local/api/v1/publictenantdoc/${ids['global-row']}`),
      );
      expect(res.status).toBe(200);
      expect(((await res.json()) as { name: string }).name).toBe('global-row');
    });

    it('a client-supplied ?tenantId= cannot widen the scope', async () => {
      setDispatchTenantResolver(() => undefined);
      for (const query of [
        '?tenantId=tenant-a',
        '?tenant_id=tenant-a',
        '?tenant_id[ne]=tenant-a',
      ]) {
        const res = await list(query);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { name: string }[];
        const leaked = body.filter((i) => i.name !== 'global-row');
        expect(leaked).toEqual([]);
      }
    });
  });

  describe('tenancy disabled (no resolver)', () => {
    it('list returns ALL rows — no global-only restriction is imposed', async () => {
      setDispatchTenantResolver(undefined);
      const res = await list();
      expect(res.status).toBe(200);
      const body = (await res.json()) as { name: string }[];
      expect(body.map((i) => i.name).sort()).toEqual([
        'global-row',
        'tenant-a-row',
        'tenant-b-row',
      ]);
    });
  });

  // #1782 review (P1): a model tenant-scoped ONLY via the standalone
  // `@TenantScoped()` decorator has no `@smrt({ tenantScoped })` config, so
  // `ObjectRegistry.isTenantScoped` is false. It must still fail closed via the
  // tenancy-filled `setTenantScopedClassResolver` hook.
  describe('@TenantScoped()-only model recognized via the resolver hook', () => {
    const p1list = (query = '') =>
      handler(new Request(`http://local/api/v1/pattern1tenantdoc${query}`));

    it('is NOT ObjectRegistry-tenant-scoped (sanity: only the hook can see it)', () => {
      expect(ObjectRegistry.isTenantScoped('Pattern1TenantDoc')).toBe(false);
    });

    it('fails closed to global rows when the resolver marks it tenant-scoped', async () => {
      setDispatchTenantResolver(() => undefined);
      setTenantScopedClassResolver((name) =>
        name.includes('Pattern1TenantDoc'),
      );

      const res = await p1list();
      expect(res.status).toBe(200);
      const body = (await res.json()) as { name: string }[];
      expect(body.map((i) => i.name).sort()).toEqual(['global-row']);
    });

    it('would leak WITHOUT the resolver (proves the hook is what closes it)', async () => {
      // Same ambient no-tenant state, but the resolver is unset → the guard
      // can't recognize the Pattern-1 model → unfiltered (documents the gap the
      // hook closes).
      setDispatchTenantResolver(() => undefined);
      setTenantScopedClassResolver(undefined);

      const res = await p1list();
      expect(res.status).toBe(200);
      const body = (await res.json()) as { name: string }[];
      expect(body.map((i) => i.name).sort()).toEqual([
        'global-row',
        'tenant-a-row',
        'tenant-b-row',
      ]);
    });
  });
});
