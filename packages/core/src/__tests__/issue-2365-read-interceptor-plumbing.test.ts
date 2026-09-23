/**
 * Core-side plumbing for the #2365 tenancy read gaps.
 *
 * The real tenant interceptor lives in @happyvertical/smrt-tenancy (which
 * depends on core), so core proves the SEAMS it exposes, with a plain
 * registered interceptor and the core-side tenant hooks — the same inversion
 * pattern the #1782 REST read-scope spec uses:
 *
 * 1. `resolveGetStringFilter()` — the single source of truth for
 *    `collection.get()`'s string-filter semantics that `beforeGet`
 *    interceptors must reuse (a slug string resolves to the natural key, not
 *    to `{ id }`).
 * 2. `loadFromId()` / `loadFromSlug()` / `getSavedId()` run their filters
 *    through the `beforeGet` interceptor pipeline, converting interceptor
 *    field-name keys (camelCase) to column form, preserving a leading
 *    underscore (`_meta_type`, #2417).
 * 3. Collection memory (`remember()`/`recall()`) keys its `_smrt_contexts`
 *    owner id per tenant via the dispatch tenant hooks when the item class is
 *    tenant-scoped.
 *
 * Real in-memory SQLite; no mocking.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { field } from '../decorators/index';
import {
  setDispatchTenantResolver,
  setTenantScopedClassResolver,
} from '../dispatch/tenant-resolver';
import {
  type CollectionInterceptor,
  createInterceptorContext,
  GlobalInterceptors,
  resolveGetStringFilter,
} from '../interceptors';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { getTestDatabase } from '../testing/database';

const ROW_ALPHA_ID = 'aaaa2365-aaaa-4aaa-8aaa-aaaaaaaaaa01';
const ROW_BETA_ID = 'bbbb2365-bbbb-4bbb-8bbb-bbbbbbbbbb02';

@smrt()
class ReadPlumbingDoc extends SmrtObject {
  @field({ type: 'text' })
  title = '';

  // Two-word field name so the camelCase -> snake_case conversion of
  // interceptor-injected keys is actually exercised (column: group_key).
  @field({ type: 'text' })
  groupKey = '';

  // biome linting allows `any` in test files; this mirrors the loose options
  // bag SmrtObject accepts.
  constructor(options: any = {}) {
    super(options);
    if (options.title !== undefined) this.title = options.title;
    if (options.groupKey !== undefined) this.groupKey = options.groupKey;
  }
}

class ReadPlumbingDocCollection extends SmrtCollection<ReadPlumbingDoc> {
  static readonly _itemClass = ReadPlumbingDoc;
}

// STI hierarchy for the leading-underscore column contract: an interceptor
// injecting the `_meta_type` discriminator must reach the real `_meta_type`
// column — bare toSnakeCase would strip the underscore and target a
// nonexistent `meta_type` column (#2417).
@smrt({ tableStrategy: 'sti' })
class ReadPlumbingStiBase extends SmrtObject {
  @field({ type: 'text' })
  title = '';

  // biome linting allows `any` in test files; mirrors the loose options bag.
  constructor(options: any = {}) {
    super(options);
    if (options.title !== undefined) this.title = options.title;
  }
}

@smrt()
class ReadPlumbingStiAlpha extends ReadPlumbingStiBase {}

@smrt()
class ReadPlumbingStiBeta extends ReadPlumbingStiBase {}

class ReadPlumbingStiAlphaCollection extends SmrtCollection<ReadPlumbingStiAlpha> {
  static readonly _itemClass = ReadPlumbingStiAlpha;
}

class ReadPlumbingStiBetaCollection extends SmrtCollection<ReadPlumbingStiBeta> {
  static readonly _itemClass = ReadPlumbingStiBeta;
}

describe('resolveGetStringFilter (#2365)', () => {
  it('resolves a UUID string to an id lookup', () => {
    expect(
      resolveGetStringFilter('550e8400-e29b-41d4-a716-446655440000'),
    ).toEqual({ id: '550e8400-e29b-41d4-a716-446655440000' });
    // Case-insensitive, like the get() detection it replaced.
    expect(
      resolveGetStringFilter('550E8400-E29B-41D4-A716-446655440000'),
    ).toEqual({ id: '550E8400-E29B-41D4-A716-446655440000' });
  });

  it('resolves a non-UUID string to the slug natural key', () => {
    expect(resolveGetStringFilter('my-widget')).toEqual({
      slug: 'my-widget',
      context: '',
    });
    // Near-UUID strings that do not match the shape stay slugs.
    expect(resolveGetStringFilter('550e8400-e29b-41d4-a716')).toEqual({
      slug: '550e8400-e29b-41d4-a716',
      context: '',
    });
  });
});

describe('read-path interceptor plumbing (#2365)', () => {
  let docs: ReadPlumbingDocCollection;
  // Shared handle for constructing fixture objects directly.
  let db: any;

  // A minimal read-scoping interceptor: restricts every get-shaped read to
  // groupKey 'alpha' (injected in FIELD-name form, exactly like the tenancy
  // interceptor injects `tenantId`).
  const groupInterceptor: CollectionInterceptor = {
    name: 'issue-2365-group-scope',
    priority: 50,
    beforeGet(className, filter) {
      if (className !== 'ReadPlumbingDoc') return;
      if (typeof filter === 'string') {
        return { ...resolveGetStringFilter(filter), groupKey: 'alpha' };
      }
      if (!('groupKey' in filter)) {
        return { ...filter, groupKey: 'alpha' };
      }
      return;
    },
  };

  beforeAll(async () => {
    ObjectRegistry.registerCollection(
      'ReadPlumbingDoc',
      ReadPlumbingDocCollection,
    );
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['ReadPlumbingDoc'],
    });
    docs = await ReadPlumbingDocCollection.create({ db });

    await docs.create({
      id: ROW_ALPHA_ID,
      slug: 'alpha-doc',
      title: 'alpha row',
      groupKey: 'alpha',
    });
    await docs.create({
      id: ROW_BETA_ID,
      slug: 'beta-doc',
      title: 'beta row',
      groupKey: 'beta',
    });

    GlobalInterceptors.register(groupInterceptor);
  });

  afterAll(async () => {
    GlobalInterceptors.unregister(groupInterceptor);
    await docs.db?.close?.();
  });

  it('collection.get() by slug resolves the natural key and applies the injected scope', async () => {
    const inScope = await docs.get('alpha-doc');
    expect(inScope?.title).toBe('alpha row');

    const outOfScope = await docs.get('beta-doc');
    expect(outOfScope).toBeNull();
  });

  it('loadFromSlug() hydration honours the injected scope', async () => {
    const inScope = new ReadPlumbingDoc({ db, slug: 'alpha-doc' });
    await inScope.initialize();
    expect(inScope.title).toBe('alpha row');

    const outOfScope = new ReadPlumbingDoc({ db, slug: 'beta-doc' });
    await outOfScope.initialize();
    expect(outOfScope.title).toBe('');
  });

  it('loadFromId() hydration honours the injected scope', async () => {
    const inScope = new ReadPlumbingDoc({ db, id: ROW_ALPHA_ID });
    await inScope.initialize();
    expect(inScope.title).toBe('alpha row');

    const outOfScope = new ReadPlumbingDoc({ db, id: ROW_BETA_ID });
    await outOfScope.initialize();
    expect(outOfScope.title).toBe('');
  });

  it('getSavedId() honours the injected scope', async () => {
    const inScope = new ReadPlumbingDoc({ db, slug: 'alpha-doc' });
    await inScope.initialize();
    expect(await inScope.getSavedId()).toBe(ROW_ALPHA_ID);

    const outOfScope = new ReadPlumbingDoc({ db, slug: 'beta-doc' });
    await outOfScope.initialize();
    expect(await outOfScope.getSavedId()).toBeNull();
  });

  it('getId() never adopts an out-of-scope row id', async () => {
    const inScope = new ReadPlumbingDoc({ db, slug: 'alpha-doc' });
    await inScope.initialize();
    expect(await inScope.getId()).toBe(ROW_ALPHA_ID);

    // Out of scope: the natural-key lookup must miss, so getId() mints a
    // fresh uuid instead of adopting beta's row id (which would steer a
    // subsequent save() onto beta's row).
    const outOfScope = new ReadPlumbingDoc({ db, slug: 'beta-doc' });
    await outOfScope.initialize();
    const id = await outOfScope.getId();
    expect(id).not.toBe(ROW_BETA_ID);
  });

  it('a beforeGet interceptor returning a string still resolves through the shared helper', async () => {
    const rewriting: CollectionInterceptor = {
      name: 'issue-2365-string-rewrite',
      priority: 40,
      beforeGet(className) {
        if (className !== 'ReadPlumbingDoc') return;
        return 'beta-doc';
      },
    };
    GlobalInterceptors.unregister(groupInterceptor);
    GlobalInterceptors.register(rewriting);
    try {
      const probe = new ReadPlumbingDoc({ db, slug: 'alpha-doc' });
      await probe.initialize();
      // The interceptor redirected the natural-key lookup to beta-doc.
      expect(probe.title).toBe('beta row');
    } finally {
      GlobalInterceptors.unregister(rewriting);
      GlobalInterceptors.register(groupInterceptor);
    }
  });
});

describe('leading-underscore filter keys survive interception (#2417)', () => {
  // biome linting allows `any` in test files; shared db handle.
  let db: any;
  let alphaQualifiedName: string;
  let stiInterceptor: CollectionInterceptor;

  beforeAll(async () => {
    ObjectRegistry.registerCollection(
      'ReadPlumbingStiAlpha',
      ReadPlumbingStiAlphaCollection,
    );
    ObjectRegistry.registerCollection(
      'ReadPlumbingStiBeta',
      ReadPlumbingStiBetaCollection,
    );
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: [
        'ReadPlumbingStiBase',
        'ReadPlumbingStiAlpha',
        'ReadPlumbingStiBeta',
      ],
    });

    const alphas = await ReadPlumbingStiAlphaCollection.create({ db });
    const betas = await ReadPlumbingStiBetaCollection.create({ db });
    await alphas.create({ slug: 'sti-alpha', title: 'alpha sti row' });
    await betas.create({ slug: 'sti-beta', title: 'beta sti row' });

    alphaQualifiedName =
      ObjectRegistry.getClassByConstructor(ReadPlumbingStiAlpha)
        ?.qualifiedName ?? 'ReadPlumbingStiAlpha';

    // Pins every read to the alpha discriminator — the injected key carries
    // a real leading underscore and must reach the `_meta_type` column.
    stiInterceptor = {
      name: 'issue-2365-sti-discriminator-scope',
      priority: 50,
      beforeGet: (className, filter) => {
        if (
          className !== 'ReadPlumbingStiAlpha' &&
          className !== 'ReadPlumbingStiBeta'
        ) {
          return;
        }
        if (typeof filter === 'string') {
          return {
            ...resolveGetStringFilter(filter),
            _meta_type: alphaQualifiedName,
          };
        }
        if (!('_meta_type' in filter)) {
          return { ...filter, _meta_type: alphaQualifiedName };
        }
        return;
      },
    };
    GlobalInterceptors.register(stiInterceptor);
  });

  afterAll(async () => {
    GlobalInterceptors.unregister(stiInterceptor);
    await db?.close?.();
  });

  it('an injected _meta_type discriminator reaches the real column during hydration', async () => {
    // In scope: the alpha row matches the pinned discriminator. With the
    // stripped-underscore bug this query targeted a nonexistent `meta_type`
    // column and errored instead.
    const inScope = new ReadPlumbingStiAlpha({ db, slug: 'sti-alpha' });
    await inScope.initialize();
    expect(inScope.title).toBe('alpha sti row');

    // Out of scope: the beta row exists but carries the beta discriminator,
    // so the pinned filter must miss it.
    const outOfScope = new ReadPlumbingStiBeta({ db, slug: 'sti-beta' });
    await outOfScope.initialize();
    expect(outOfScope.title).toBe('');
  });
});

describe('collection memory tenant keying via core hooks (#2365)', () => {
  let docs: ReadPlumbingDocCollection;

  beforeAll(async () => {
    ObjectRegistry.registerCollection(
      'ReadPlumbingDoc',
      ReadPlumbingDocCollection,
    );
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['ReadPlumbingDoc'],
    });
    docs = await ReadPlumbingDocCollection.create({ db });
  });

  afterEach(() => {
    setDispatchTenantResolver(undefined);
    setTenantScopedClassResolver(undefined);
  });

  afterAll(async () => {
    await docs.db?.close?.();
  });

  it('keys memory per tenant when the class is tenant-scoped and a tenant is active', async () => {
    setTenantScopedClassResolver(
      (className) => className === 'ReadPlumbingDoc',
    );

    setDispatchTenantResolver(() => 'tenant-a');
    await docs.remember({ scope: 's', key: 'k', value: { owner: 'a' } });

    setDispatchTenantResolver(() => 'tenant-b');
    await docs.remember({ scope: 's', key: 'k', value: { owner: 'b' } });
    expect(await docs.recall({ scope: 's', key: 'k' })).toEqual({
      owner: 'b',
    });

    setDispatchTenantResolver(() => 'tenant-a');
    expect(await docs.recall({ scope: 's', key: 'k' })).toEqual({
      owner: 'a',
    });

    // No active tenant (resolver returns undefined) -> shared key, which has
    // no entry yet.
    setDispatchTenantResolver(() => undefined);
    expect(await docs.recall({ scope: 's', key: 'k' })).toBeNull();
  });

  it('keeps the shared key when the class is not tenant-scoped', async () => {
    // No tenant-scoped resolver registered: tenant context must not re-key.
    setDispatchTenantResolver(() => 'tenant-a');
    await docs.remember({ scope: 'shared-s', key: 'k', value: { owner: 'x' } });

    setDispatchTenantResolver(undefined);
    expect(await docs.recall({ scope: 'shared-s', key: 'k' })).toEqual({
      owner: 'x',
    });
  });
});
