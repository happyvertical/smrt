/**
 * PostgreSQL lane for the #2365 read-path scoping seams.
 *
 * SQLite's type affinity masks the dialect risks these paths carry on
 * PostgreSQL, where `id` is a native uuid column:
 *
 * - Before the fix, a `beforeGet` interceptor rewrote every string filter to
 *   `{ id: filter, ... }`, so `collection.get('<slug>')` under a read scope
 *   raised `invalid input syntax for type uuid`. The fixed contract resolves
 *   the string through `resolveGetStringFilter()` first; this suite proves a
 *   slug lookup with an interceptor-injected predicate works against real
 *   PostgreSQL, including a uuid-column predicate bound from a JS string.
 * - Hydration (`loadFromSlug`) now routes through the interceptor pipeline
 *   with camelCase field keys converted to snake_case columns.
 * - `findSimilarToEmbedding()` pre-filters candidates by the beforeList
 *   read predicate BEFORE top-K, stringifying native-uuid candidate ids.
 *
 * Runs only when SMRT_TEST_POSTGRES_URL is set (the disposable CI PostgreSQL
 * shard, `pnpm test:postgres`).
 */

import { randomUUID } from 'node:crypto';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SmrtCollection } from '../collection';
import { field } from '../decorators/index';
import { EmbeddingProvider } from '../embeddings/provider';
import { EmbeddingStorage } from '../embeddings/storage';
import {
  type CollectionInterceptor,
  GlobalInterceptors,
  resolveGetStringFilter,
} from '../interceptors';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { getDDLStrategy } from '../schema/ddl/index';
import { getTestDatabase } from '../testing/database';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;

// Keep in sync with the literal in the @smrt() config below — the manifest
// scanner only accepts literal values inside a decorator config.
const TABLE = 'issue_2365_pg_read_docs';
const ROW_ALPHA_ID = randomUUID();
const ROW_BETA_ID = randomUUID();
const EMBED_MODEL = 'test-model-2365';

@smrt({
  tableName: 'issue_2365_pg_read_docs',
  embeddings: {
    fields: ['content'],
    autoGenerate: false,
  },
})
class Issue2365PgReadDoc extends SmrtObject {
  @field({ type: 'text' })
  title = '';

  @field({ type: 'text' })
  content = '';

  // Two-word field name: interceptor-injected keys arrive in field form
  // (camelCase) and must reach PostgreSQL as the group_key column.
  @field({ type: 'text' })
  groupKey = '';

  // biome linting allows `any` in test files; this mirrors the loose options
  // bag SmrtObject accepts.
  constructor(options: any = {}) {
    super(options);
    if (options.title !== undefined) this.title = options.title;
    if (options.content !== undefined) this.content = options.content;
    if (options.groupKey !== undefined) this.groupKey = options.groupKey;
  }
}

class Issue2365PgReadDocCollection extends SmrtCollection<Issue2365PgReadDoc> {
  static readonly _itemClass = Issue2365PgReadDoc;
}

// Scopes reads to group 'alpha' — the same injection shape as the tenancy
// interceptor (field-name keys), including a uuid-column predicate for the
// get path so uuid binding from a JS string is exercised on real PostgreSQL.
const scopeInterceptor: CollectionInterceptor = {
  name: 'issue-2365-pg-read-scope',
  priority: 50,
  beforeGet(className, filter) {
    if (className !== 'Issue2365PgReadDoc') return;
    if (typeof filter === 'string') {
      return { ...resolveGetStringFilter(filter), groupKey: 'alpha' };
    }
    if (!('groupKey' in filter)) {
      return { ...filter, groupKey: 'alpha' };
    }
    return;
  },
  beforeList(className, options) {
    if (className !== 'Issue2365PgReadDoc') return;
    const where = options.where ?? {};
    if ('groupKey' in where) return;
    return { ...options, where: { ...where, groupKey: 'alpha' } };
  },
};

describe.skipIf(!pgUrl)('#2365 read scoping on PostgreSQL (optional)', () => {
  vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

  let db: Awaited<ReturnType<typeof getDatabase>>;
  let docs: Issue2365PgReadDocCollection;

  beforeAll(async () => {
    ObjectRegistry.registerCollection(
      'Issue2365PgReadDoc',
      Issue2365PgReadDocCollection,
    );

    db = await getDatabase({
      type: 'postgres',
      url: pgUrl,
      dbid: `smrt-test-2365-${randomUUID()}`,
    } as Parameters<typeof getDatabase>[0]);

    // Fresh table per run: earlier runs of this suite (or a schema change)
    // must not leak stale rows or shape into this one. `getTestDatabase`
    // emits SQLite-flavoured application DDL, so the application table is
    // created from the class's PostgreSQL DDL directly (the issue-2070
    // pattern); getTestDatabase only installs the portable system tables.
    await db.query(`DROP TABLE IF EXISTS "${TABLE}"`);
    const registration =
      ObjectRegistry.getClassByConstructor(Issue2365PgReadDoc);
    const className =
      registration?.qualifiedName ||
      registration?.name ||
      Issue2365PgReadDoc.name;
    const schema = ObjectRegistry.getSchema(className);
    const ddl = ObjectRegistry.getSchemaDDL(className, 'postgres');
    if (!schema || !ddl) throw new Error(`Missing schema for ${className}`);
    await db.query(ddl);
    for (const indexSql of getDDLStrategy('postgres').generateIndexes(schema)) {
      await db.query(indexSql);
    }
    await getTestDatabase({ db, classes: [] });
    await db.query(
      `DELETE FROM _smrt_embeddings WHERE object_class = 'Issue2365PgReadDoc'`,
    );

    docs = await Issue2365PgReadDocCollection.create({ db });

    await docs.create({
      id: ROW_ALPHA_ID,
      slug: 'alpha-doc',
      title: 'alpha row',
      content: 'alpha content',
      groupKey: 'alpha',
    });
    await docs.create({
      id: ROW_BETA_ID,
      slug: 'beta-doc',
      title: 'beta row',
      content: 'beta content',
      groupKey: 'beta',
    });

    await EmbeddingStorage.upsert(db, {
      objectClass: 'Issue2365PgReadDoc',
      objectId: ROW_ALPHA_ID,
      fieldName: 'content',
      contentHash: 'hash-alpha',
      embedding: [0.9, 0.1, 0],
      model: EMBED_MODEL,
      dimensions: 3,
    });
    // The out-of-scope row ranks HIGHER for the probe vector, so a top-1
    // computed before scoping would be fully occupied by it.
    await EmbeddingStorage.upsert(db, {
      objectClass: 'Issue2365PgReadDoc',
      objectId: ROW_BETA_ID,
      fieldName: 'content',
      contentHash: 'hash-beta',
      embedding: [1, 0, 0],
      model: EMBED_MODEL,
      dimensions: 3,
    });

    vi.spyOn(EmbeddingProvider.prototype, 'getModelName').mockReturnValue(
      EMBED_MODEL,
    );

    GlobalInterceptors.register(scopeInterceptor);
  });

  afterAll(async () => {
    GlobalInterceptors.unregister(scopeInterceptor);
    vi.restoreAllMocks();
    try {
      await db?.query(
        `DELETE FROM _smrt_embeddings WHERE object_class = 'Issue2365PgReadDoc'`,
      );
      await db?.query(`DROP TABLE IF EXISTS "${TABLE}"`);
    } catch {
      // Best-effort cleanup; the next run drops the table anyway.
    }
  });

  it('get() by slug under a read scope resolves the natural key (no uuid cast error)', async () => {
    const inScope = await docs.get('alpha-doc');
    expect(inScope?.title).toBe('alpha row');

    const outOfScope = await docs.get('beta-doc');
    expect(outOfScope).toBeNull();
  });

  it('get() with an interceptor-injected uuid predicate binds from a JS string', async () => {
    const found = await docs.get({ id: ROW_ALPHA_ID });
    expect(found?.title).toBe('alpha row');
  });

  it('loadFromSlug() hydration converts injected camelCase keys to columns on PostgreSQL', async () => {
    const inScope = new Issue2365PgReadDoc({ db, slug: 'alpha-doc' });
    await inScope.initialize();
    expect(inScope.title).toBe('alpha row');

    const outOfScope = new Issue2365PgReadDoc({ db, slug: 'beta-doc' });
    await outOfScope.initialize();
    expect(outOfScope.title).toBe('');
  });

  it('loadFromId() hydration honours the injected scope on native uuid ids', async () => {
    const outOfScope = new Issue2365PgReadDoc({ db, id: ROW_BETA_ID });
    await outOfScope.initialize();
    expect(outOfScope.title).toBe('');
  });

  it('findSimilarToEmbedding() restricts candidates before top-K (uuid ids stringified)', async () => {
    // Probe vector matches the out-of-scope row exactly; before the fix the
    // top-1 was that row and the post-hoc filter starved the result to [].
    const results = await docs.findSimilarToEmbedding([1, 0, 0], {
      field: 'content',
      limit: 1,
    });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(ROW_ALPHA_ID);
  });
});
