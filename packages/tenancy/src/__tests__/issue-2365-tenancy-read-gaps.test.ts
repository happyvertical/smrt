/**
 * Tenancy read-gap regressions (#2365).
 *
 * Tenant isolation was enforced on collection list/get/count/query but NOT on
 * these read paths, each probed as a real cross-tenant read or a broken read
 * in the 2026-08-17 database-layer assessment (epic #2382, finding B2):
 *
 * 1. `collection.get('<slug>')` under an active tenant context — the
 *    interceptor rewrote every string filter to `{ id: filter, tenantId }`
 *    before core's UUID-vs-slug detection, so a slug lookup returned null on
 *    SQLite and raised a uuid cast error on PostgreSQL.
 * 2. Constructor hydration — `new Model({ slug })` / `{ id }` →
 *    `loadFromSlug()` / `loadFromId()` / `getSavedId()` called `db.get`
 *    directly, bypassing every read interceptor: under tenant B they happily
 *    hydrated tenant A's row.
 * 3. `semanticSearch()` computed top-K similarity across ALL tenants and only
 *    filtered afterwards via `list()` — starving results and soft-leaking
 *    which tenants have similar content.
 * 4. Collection memory (`remember()`/`recall()`) filed everything under one
 *    shared `owner_id='__collection__'` key, so learned memory crossed
 *    tenants.
 *
 * Real in-memory SQLite; the real tenant interceptor; no mocking except the
 * external embedding call (`EmbeddingProvider.embed`), per the testing policy.
 */

import {
  EmbeddingProvider,
  field,
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  TenantContextError,
  withSystemContext,
  withTenant,
} from '../context.js';
import { TenantScoped, tenantId } from '../decorators.js';
import { disableTenancy, enableTenancy } from '../interceptor.js';

const TENANT_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaa1';
const TENANT_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbb2';
const TENANT_EMPTY = 'cccccccc-3333-4333-8333-ccccccccccc3';

const VICTIM_UUID = 'dddddddd-4444-4444-8444-ddddddddddd4';
const B_DOC_UUID = 'eeeeeeee-5555-4555-8555-eeeeeeeeeee5';

// biome linting allows `any` in test files; this mirrors the loose options bag
// SmrtObject accepts.
type FixtureOptions = any;

@smrt()
@TenantScoped({ mode: 'optional' })
class ReadGapDoc extends SmrtObject {
  @field({ type: 'text' })
  title = '';

  @tenantId({ nullable: true })
  tenantId: string | null = null;

  constructor(options: FixtureOptions = {}) {
    super(options);
    if (options.title !== undefined) this.title = options.title;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
  }
}

class ReadGapDocCollection extends SmrtCollection<ReadGapDoc> {
  static readonly _itemClass = ReadGapDoc;
}

@smrt()
@TenantScoped({ mode: 'required' })
class ReadGapStrictDoc extends SmrtObject {
  @field({ type: 'text' })
  title = '';

  @tenantId({ nullable: true })
  tenantId: string | null = null;

  constructor(options: FixtureOptions = {}) {
    super(options);
    if (options.title !== undefined) this.title = options.title;
  }
}

class ReadGapStrictDocCollection extends SmrtCollection<ReadGapStrictDoc> {
  static readonly _itemClass = ReadGapStrictDoc;
}

@smrt({
  embeddings: {
    fields: ['content'],
    autoGenerate: false,
  },
})
@TenantScoped({ mode: 'optional' })
class ReadGapEmbedDoc extends SmrtObject {
  @field({ type: 'text' })
  content = '';

  @tenantId({ nullable: true })
  tenantId: string | null = null;

  constructor(options: FixtureOptions = {}) {
    super(options);
    if (options.content !== undefined) this.content = options.content;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
  }
}

class ReadGapEmbedDocCollection extends SmrtCollection<ReadGapEmbedDoc> {
  static readonly _itemClass = ReadGapEmbedDoc;
}

// NOT tenant-scoped — proves non-scoped collection memory stays shared.
@smrt()
class ReadGapPlainDoc extends SmrtObject {
  @field({ type: 'text' })
  title = '';

  constructor(options: FixtureOptions = {}) {
    super(options);
    if (options.title !== undefined) this.title = options.title;
  }
}

class ReadGapPlainDocCollection extends SmrtCollection<ReadGapPlainDoc> {
  static readonly _itemClass = ReadGapPlainDoc;
}

/**
 * Deterministic per-document vectors. Against the probe vector `[1, 0, 0]`,
 * every tenant-b document ranks ABOVE every tenant-a document, so a top-K
 * computed across tenants is fully occupied by tenant-b rows — the exact
 * starvation shape the fix removes.
 */
const VECTORS: Record<string, number[]> = {
  'tenant-a close match': [0.95, 0.05, 0],
  'tenant-a mid match': [0.8, 0.2, 0],
  'tenant-a far match': [0.1, 0.9, 0],
  'tenant-b exact one': [1, 0, 0],
  'tenant-b exact two': [0.99, 0.01, 0],
  'tenant-b exact three': [0.98, 0.02, 0],
  'similarity probe': [1, 0, 0],
};

function vectorFor(text: string): number[] {
  const vector = VECTORS[text];
  if (!vector) {
    throw new Error(`No fixture vector for text: ${text}`);
  }
  return vector;
}

describe('Tenancy read gaps (#2365)', () => {
  let docs: ReadGapDocCollection;
  let strictDocs: ReadGapStrictDocCollection;
  let embedDocs: ReadGapEmbedDocCollection;
  let plainDocs: ReadGapPlainDocCollection;
  // Shared handle for constructing fixture objects directly.
  let db: any;

  beforeAll(async () => {
    ObjectRegistry.registerCollection('ReadGapDoc', ReadGapDocCollection);
    ObjectRegistry.registerCollection(
      'ReadGapStrictDoc',
      ReadGapStrictDocCollection,
    );
    ObjectRegistry.registerCollection(
      'ReadGapEmbedDoc',
      ReadGapEmbedDocCollection,
    );
    ObjectRegistry.registerCollection(
      'ReadGapPlainDoc',
      ReadGapPlainDocCollection,
    );

    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: [
        'ReadGapDoc',
        'ReadGapStrictDoc',
        'ReadGapEmbedDoc',
        'ReadGapPlainDoc',
      ],
    });

    docs = await ReadGapDocCollection.create({ db });
    strictDocs = await ReadGapStrictDocCollection.create({ db });
    embedDocs = await ReadGapEmbedDocCollection.create({ db });
    plainDocs = await ReadGapPlainDocCollection.create({ db });

    enableTenancy();

    // External embedding calls are mocked (testing policy: mock ONLY external
    // AI/API calls); everything else is the real stack.
    vi.spyOn(EmbeddingProvider.prototype, 'embed').mockImplementation(
      async (texts: string | string[]) => {
        const textArray = Array.isArray(texts) ? texts : [texts];
        return textArray.map((text) => vectorFor(text));
      },
    );
    vi.spyOn(EmbeddingProvider.prototype, 'getModelName').mockReturnValue(
      'test-model-2365',
    );

    // Seed through the normal stack so the interceptor stamps tenant ids.
    await withTenant({ tenantId: TENANT_A }, async () => {
      await docs.create({
        id: VICTIM_UUID,
        slug: 'secret-a',
        title: 'tenant-a-original',
      });
    });
    await withTenant({ tenantId: TENANT_B }, async () => {
      await docs.create({
        id: B_DOC_UUID,
        slug: 'doc-b',
        title: 'tenant-b-doc',
      });
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    disableTenancy();
    await docs.db?.close?.();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 1. collection.get('<slug>') under tenant context
  // ───────────────────────────────────────────────────────────────────────────

  describe('get-by-slug under tenant context', () => {
    it('returns the tenant-owned row for a slug lookup (was null before the fix)', async () => {
      const found = await withTenant({ tenantId: TENANT_A }, () =>
        docs.get('secret-a'),
      );
      expect(found).not.toBeNull();
      expect(found?.title).toBe('tenant-a-original');
      expect(found?.tenantId).toBe(TENANT_A);
    });

    it("does not return another tenant's row for a slug lookup", async () => {
      const found = await withTenant({ tenantId: TENANT_B }, () =>
        docs.get('secret-a'),
      );
      expect(found).toBeNull();
    });

    it('still scopes UUID lookups to the active tenant', async () => {
      const own = await withTenant({ tenantId: TENANT_A }, () =>
        docs.get(VICTIM_UUID),
      );
      expect(own?.title).toBe('tenant-a-original');

      const foreign = await withTenant({ tenantId: TENANT_B }, () =>
        docs.get(VICTIM_UUID),
      );
      expect(foreign).toBeNull();
    });

    it('slug lookups without a tenant context stay unscoped for optional-mode classes', async () => {
      const found = await docs.get('secret-a');
      expect(found?.title).toBe('tenant-a-original');
    });

    it('withSystemContext() remains the explicit cross-tenant read path', async () => {
      const found = await withTenant({ tenantId: TENANT_B }, () =>
        withSystemContext(() => docs.get('secret-a')),
      );
      expect(found?.title).toBe('tenant-a-original');
    });

    it('throws TenantContextError for required-mode slug lookups without context', async () => {
      await expect(strictDocs.get('any-slug')).rejects.toThrow(
        TenantContextError,
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Constructor hydration / loadFromId / loadFromSlug / getSavedId
  // ───────────────────────────────────────────────────────────────────────────

  describe('hydration through the interceptor', () => {
    it("does NOT hydrate another tenant's row via new Model({ slug }) (the probed cross-tenant read)", async () => {
      await withTenant({ tenantId: TENANT_B }, async () => {
        const probe = new ReadGapDoc({ db, slug: 'secret-a' });
        await probe.initialize();
        expect(probe.title).toBe('');
        expect(probe.tenantId).toBeNull();
      });
    });

    it('hydrates the own-tenant row via new Model({ slug })', async () => {
      await withTenant({ tenantId: TENANT_A }, async () => {
        const probe = new ReadGapDoc({ db, slug: 'secret-a' });
        await probe.initialize();
        expect(probe.title).toBe('tenant-a-original');
        expect(probe.id).toBe(VICTIM_UUID);
      });
    });

    it("does NOT hydrate another tenant's row via new Model({ id })", async () => {
      await withTenant({ tenantId: TENANT_B }, async () => {
        const probe = new ReadGapDoc({ db, id: VICTIM_UUID });
        await probe.initialize();
        expect(probe.title).toBe('');
      });
    });

    it('hydrates the own-tenant row via new Model({ id })', async () => {
      await withTenant({ tenantId: TENANT_A }, async () => {
        const probe = new ReadGapDoc({ db, id: VICTIM_UUID });
        await probe.initialize();
        expect(probe.title).toBe('tenant-a-original');
      });
    });

    it('getSavedId()/isSaved() only see rows visible to the active tenant', async () => {
      await withTenant({ tenantId: TENANT_B }, async () => {
        const probe = new ReadGapDoc({ db, slug: 'secret-a' });
        await probe.initialize();
        expect(await probe.getSavedId()).toBeNull();
        expect(await probe.isSaved()).toBe(false);
      });

      await withTenant({ tenantId: TENANT_A }, async () => {
        const probe = new ReadGapDoc({ db, slug: 'secret-a' });
        await probe.initialize();
        expect(await probe.getSavedId()).toBe(VICTIM_UUID);
        expect(await probe.isSaved()).toBe(true);
      });
    });

    it('hydration without a tenant context stays unscoped for optional-mode classes', async () => {
      const probe = new ReadGapDoc({ db, slug: 'secret-a' });
      await probe.initialize();
      expect(probe.title).toBe('tenant-a-original');
    });

    it('required-mode hydration without a tenant context fails closed', async () => {
      const probe = new ReadGapStrictDoc({ db, slug: 'whatever' });
      await expect(probe.initialize()).rejects.toThrow(TenantContextError);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. semanticSearch tenant pre-filter
  // ───────────────────────────────────────────────────────────────────────────

  describe('semanticSearch under tenant context', () => {
    beforeAll(async () => {
      const seed = async (tenant: string, id: string, content: string) => {
        await withTenant({ tenantId: tenant }, async () => {
          const doc = await embedDocs.create({ id, content });
          // Runtime embedding method not part of the static SmrtObject type.
          await (
            doc as unknown as { generateEmbeddings(): Promise<unknown> }
          ).generateEmbeddings();
        });
      };

      await seed(
        TENANT_A,
        'aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaa01',
        'tenant-a close match',
      );
      await seed(
        TENANT_A,
        'aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaa02',
        'tenant-a mid match',
      );
      await seed(
        TENANT_A,
        'aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaa03',
        'tenant-a far match',
      );
      await seed(
        TENANT_B,
        'bbbb2222-bbbb-4bbb-8bbb-bbbbbbbbbb01',
        'tenant-b exact one',
      );
      await seed(
        TENANT_B,
        'bbbb2222-bbbb-4bbb-8bbb-bbbbbbbbbb02',
        'tenant-b exact two',
      );
      await seed(
        TENANT_B,
        'bbbb2222-bbbb-4bbb-8bbb-bbbbbbbbbb03',
        'tenant-b exact three',
      );
    });

    it("is not starved by other tenants' rows occupying the top-K (was [] before the fix)", async () => {
      // Every tenant-b vector outranks every tenant-a vector for this probe,
      // so the old cross-tenant top-3 contained only tenant-b rows and the
      // post-hoc tenant filter emptied it.
      const results = await withTenant({ tenantId: TENANT_A }, () =>
        embedDocs.semanticSearch('similarity probe', { limit: 3 }),
      );

      expect(results).toHaveLength(3);
      expect(results.map((r) => r.content)).toEqual([
        'tenant-a close match',
        'tenant-a mid match',
        'tenant-a far match',
      ]);
      for (const result of results) {
        expect(result.tenantId).toBe(TENANT_A);
      }
    });

    it("never returns another tenant's rows", async () => {
      const results = await withTenant({ tenantId: TENANT_B }, () =>
        embedDocs.semanticSearch('similarity probe', { limit: 10 }),
      );
      expect(results.length).toBeGreaterThan(0);
      for (const result of results) {
        expect(result.tenantId).toBe(TENANT_B);
        expect(result.content).toContain('tenant-b');
      }
    });

    it('honours minSimilarity within the tenant candidate set', async () => {
      const results = await withTenant({ tenantId: TENANT_A }, () =>
        embedDocs.semanticSearch('similarity probe', {
          limit: 10,
          minSimilarity: 0.5,
        }),
      );
      expect(results.map((r) => r.content)).toEqual([
        'tenant-a close match',
        'tenant-a mid match',
      ]);
    });

    it('returns [] for a tenant with no rows', async () => {
      const results = await withTenant({ tenantId: TENANT_EMPTY }, () =>
        embedDocs.semanticSearch('similarity probe', { limit: 3 }),
      );
      expect(results).toEqual([]);
    });

    it('stays unscoped without a tenant context for optional-mode classes', async () => {
      const results = await embedDocs.semanticSearch('similarity probe', {
        limit: 3,
      });
      expect(results.map((r) => r.content)).toEqual([
        'tenant-b exact one',
        'tenant-b exact two',
        'tenant-b exact three',
      ]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Collection memory keyed per tenant
  // ───────────────────────────────────────────────────────────────────────────

  describe('collection memory under tenant context', () => {
    it('keys remember()/recall() per tenant on tenant-scoped collections', async () => {
      await withTenant({ tenantId: TENANT_A }, () =>
        docs.remember({
          scope: 'parser/default',
          key: 'selector',
          value: { owner: 'tenant-a' },
        }),
      );
      await withTenant({ tenantId: TENANT_B }, () =>
        docs.remember({
          scope: 'parser/default',
          key: 'selector',
          value: { owner: 'tenant-b' },
        }),
      );
      await docs.remember({
        scope: 'parser/default',
        key: 'selector',
        value: { owner: 'shared' },
      });

      const recallA = await withTenant({ tenantId: TENANT_A }, () =>
        docs.recall({ scope: 'parser/default', key: 'selector' }),
      );
      const recallB = await withTenant({ tenantId: TENANT_B }, () =>
        docs.recall({ scope: 'parser/default', key: 'selector' }),
      );
      const recallShared = await docs.recall({
        scope: 'parser/default',
        key: 'selector',
      });

      expect(recallA).toEqual({ owner: 'tenant-a' });
      expect(recallB).toEqual({ owner: 'tenant-b' });
      expect(recallShared).toEqual({ owner: 'shared' });
    });

    it('does not leak memory learned outside any tenant into a tenant context', async () => {
      await docs.remember({
        scope: 'parser/global-only',
        key: 'strategy',
        value: { owner: 'shared' },
      });

      const recallA = await withTenant({ tenantId: TENANT_A }, () =>
        docs.recall({ scope: 'parser/global-only', key: 'strategy' }),
      );
      expect(recallA).toBeNull();
    });

    it('recallAll() returns only the active tenant entries', async () => {
      await withTenant({ tenantId: TENANT_A }, () =>
        docs.remember({
          scope: 'recall-all-scope',
          key: 'a-only',
          value: { owner: 'tenant-a' },
        }),
      );
      await withTenant({ tenantId: TENANT_B }, () =>
        docs.remember({
          scope: 'recall-all-scope',
          key: 'b-only',
          value: { owner: 'tenant-b' },
        }),
      );

      const all = await withTenant({ tenantId: TENANT_A }, () =>
        docs.recallAll({ scope: 'recall-all-scope' }),
      );
      expect([...all.keys()]).toEqual(['a-only']);
      expect(all.get('a-only')).toEqual({ owner: 'tenant-a' });
    });

    it("forget() removes only the active tenant's entry", async () => {
      await withTenant({ tenantId: TENANT_A }, () =>
        docs.forget({ scope: 'parser/default', key: 'selector' }),
      );

      const recallA = await withTenant({ tenantId: TENANT_A }, () =>
        docs.recall({ scope: 'parser/default', key: 'selector' }),
      );
      const recallB = await withTenant({ tenantId: TENANT_B }, () =>
        docs.recall({ scope: 'parser/default', key: 'selector' }),
      );
      const recallShared = await docs.recall({
        scope: 'parser/default',
        key: 'selector',
      });

      expect(recallA).toBeNull();
      expect(recallB).toEqual({ owner: 'tenant-b' });
      expect(recallShared).toEqual({ owner: 'shared' });
    });

    it('memory on non-tenant-scoped collections stays shared regardless of tenant context', async () => {
      await withTenant({ tenantId: TENANT_A }, () =>
        plainDocs.remember({
          scope: 'plain-scope',
          key: 'k',
          value: { owner: 'anyone' },
        }),
      );

      const noContext = await plainDocs.recall({
        scope: 'plain-scope',
        key: 'k',
      });
      const otherTenant = await withTenant({ tenantId: TENANT_B }, () =>
        plainDocs.recall({ scope: 'plain-scope', key: 'k' }),
      );

      expect(noContext).toEqual({ owner: 'anyone' });
      expect(otherTenant).toEqual({ owner: 'anyone' });
    });
  });
});
