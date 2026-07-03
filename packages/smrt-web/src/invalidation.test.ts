/**
 * Relationship-derived cache invalidation tests for smrt-web (#1761).
 *
 * A settled mutation on one collection must refresh the collections related to
 * it — with the edges derived from the manifest (`definition.relationships`),
 * not hand-wired here. Cross-collection reach requires a SHARED client from
 * {@link createSmrtWebClient}: the invalidation runs on that shared query cache.
 *
 * Per the repo mocking policy only the network boundary is mocked (the
 * generated REST client fetchers). The client-data engine, its query cache, and
 * the transaction lifecycle are all real, so a refetch is a real `list()` call
 * observable through the scripted fetcher's call counter.
 *
 * Coverage: one foreign-key relationship (Comment.articleId -> articles) and
 * one join/one-to-many relationship (Article.tags -> tags), the two edge kinds
 * the acceptance criteria call for.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  createSmrtCollection,
  createSmrtWebClient,
  newLocalId,
  type SmrtCrudFetchers,
  type SmrtWebCollection,
  type SmrtWebCollectionDefinition,
} from './index.js';

interface ArticleData {
  id?: string;
  title: string;
}
interface CommentData {
  id?: string;
  body: string;
  articleId?: string;
}
interface TagData {
  id?: string;
  label: string;
}

/**
 * `comments` with a foreign-key edge to `articles` — mirrors what
 * `@happyvertical/smrt-virt-web` emits for a `@foreignKey('Article')` field.
 */
function commentsDefinition(): SmrtWebCollectionDefinition<CommentData> {
  return {
    name: 'comments',
    className: 'Comment',
    endpoint: '/comments',
    idField: 'id',
    actions: ['create', 'delete', 'get', 'list', 'update'],
    fields: {
      body: { type: 'text', required: true },
      articleId: { type: 'foreignKey' },
    },
    relationships: [
      { field: 'articleId', kind: 'foreignKey', relatedCollection: 'articles' },
    ],
  };
}

/**
 * `articles` with a many-to-many (join) edge to `tags` — mirrors what codegen
 * emits for a `@manyToMany('Tag')` field.
 */
function articlesDefinition(): SmrtWebCollectionDefinition<ArticleData> {
  return {
    name: 'articles',
    className: 'Article',
    endpoint: '/articles',
    idField: 'id',
    actions: ['create', 'delete', 'get', 'list', 'update'],
    fields: { title: { type: 'text', required: true } },
    relationships: [
      { field: 'tags', kind: 'manyToMany', relatedCollection: 'tags' },
    ],
  };
}

/** `tags` — a leaf collection with no outbound edges. */
function tagsDefinition(): SmrtWebCollectionDefinition<TagData> {
  return {
    name: 'tags',
    className: 'Tag',
    endpoint: '/tags',
    idField: 'id',
    actions: ['create', 'delete', 'get', 'list', 'update'],
    fields: { label: { type: 'text', required: true } },
    relationships: [],
  };
}

/**
 * A scripted stand-in for a generated REST client surface: resolves the way the
 * generated fetchers do (JSON payloads, never rejects on HTTP errors) and
 * counts `list()` so a relationship-driven refetch is observable.
 */
function makeScriptedFetchers(initialRows: Array<Record<string, unknown>>) {
  const serverRows = [...initialRows];
  const calls = { list: 0, create: 0, update: 0, delete: 0 };

  const fetchers: SmrtCrudFetchers = {
    list: async () => {
      calls.list += 1;
      return serverRows.map((row) => ({ ...row }));
    },
    create: async (data) => {
      calls.create += 1;
      const created = { ...data, id: `server-${serverRows.length + 1}` };
      serverRows.push(created);
      return { ...created };
    },
    update: async (id, data) => {
      calls.update += 1;
      return { ...data, id };
    },
    delete: async () => {
      calls.delete += 1;
      return true;
    },
  };

  return { fetchers, calls };
}

/**
 * Wait until `predicate` holds, polling microtask-by-microtask. Invalidation is
 * fire-and-forget (it schedules a background refetch), so a settled mutation's
 * effect on a RELATED collection lands a few ticks later — this bridges that
 * gap without a fixed sleep. Fails loudly if it never settles.
 */
async function waitFor(
  predicate: () => boolean,
  { tries = 50 }: { tries?: number } = {},
): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  if (!predicate()) {
    throw new Error('waitFor: predicate never became true');
  }
}

describe('relationship-derived invalidation (shared client)', () => {
  const cleanups: Array<SmrtWebCollection<object>> = [];
  const track = <T extends object>(c: SmrtWebCollection<T>) => {
    cleanups.push(c as unknown as SmrtWebCollection<object>);
    return c;
  };

  afterEach(async () => {
    await Promise.all(cleanups.map((c) => c.cleanup()));
    cleanups.length = 0;
  });

  it('refetches a foreign-key-related collection when the owning collection is mutated', async () => {
    const client = createSmrtWebClient();
    const commentsBackend = makeScriptedFetchers([
      { id: 'c1', body: 'first', articleId: 'a1' },
    ]);
    const articlesBackend = makeScriptedFetchers([
      { id: 'a1', title: 'Hello' },
    ]);

    const comments = track(
      createSmrtCollection(commentsDefinition(), {
        fetchers: commentsBackend.fetchers,
        client,
        staleTimeMs: 60_000,
      }),
    );
    const articles = track(
      createSmrtCollection(articlesDefinition(), {
        fetchers: articlesBackend.fetchers,
        client,
        staleTimeMs: 60_000,
      }),
    );

    // Keep the articles collection "active" — a live subscriber, as a rendered
    // view would be — so an invalidation actually triggers a background refetch.
    const articlesSub = articles.subscribeChanges(() => {});
    await Promise.all([comments.preload(), articles.preload()]);
    expect(articlesBackend.calls.list).toBe(1);
    expect(commentsBackend.calls.list).toBe(1);

    // Mutate comments (the FK owner). Its relationships name `articles`, so once
    // the create settles the articles cache is invalidated and refetches.
    const tx = comments.insert({
      id: newLocalId(),
      body: 'second',
      articleId: 'a1',
    });
    await tx.isPersisted.promise;

    await waitFor(() => articlesBackend.calls.list >= 2);
    expect(articlesBackend.calls.list).toBeGreaterThanOrEqual(2);

    articlesSub.unsubscribe();
  });

  it('refetches a join-related collection when the owning collection is mutated', async () => {
    const client = createSmrtWebClient();
    const articlesBackend = makeScriptedFetchers([
      { id: 'a1', title: 'Hello' },
    ]);
    const tagsBackend = makeScriptedFetchers([{ id: 't1', label: 'news' }]);

    const articles = track(
      createSmrtCollection(articlesDefinition(), {
        fetchers: articlesBackend.fetchers,
        client,
        staleTimeMs: 60_000,
      }),
    );
    const tags = track(
      createSmrtCollection(tagsDefinition(), {
        fetchers: tagsBackend.fetchers,
        client,
        staleTimeMs: 60_000,
      }),
    );

    const tagsSub = tags.subscribeChanges(() => {});
    await Promise.all([articles.preload(), tags.preload()]);
    expect(tagsBackend.calls.list).toBe(1);

    // Articles' relationships name `tags` (manyToMany join). An update on an
    // article invalidates the tags cache — a join membership may have changed.
    const tx = articles.insert({ id: newLocalId(), title: 'World' });
    await tx.isPersisted.promise;

    await waitFor(() => tagsBackend.calls.list >= 2);
    expect(tagsBackend.calls.list).toBeGreaterThanOrEqual(2);

    tagsSub.unsubscribe();
  });

  it('does not refetch an UNRELATED collection sharing the same client', async () => {
    const client = createSmrtWebClient();
    const commentsBackend = makeScriptedFetchers([
      { id: 'c1', body: 'first', articleId: 'a1' },
    ]);
    // `tags` is unrelated to `comments` (comments only edges to articles).
    const tagsBackend = makeScriptedFetchers([{ id: 't1', label: 'news' }]);

    const comments = track(
      createSmrtCollection(commentsDefinition(), {
        fetchers: commentsBackend.fetchers,
        client,
        staleTimeMs: 60_000,
      }),
    );
    const tags = track(
      createSmrtCollection(tagsDefinition(), {
        fetchers: tagsBackend.fetchers,
        client,
        staleTimeMs: 60_000,
      }),
    );

    const tagsSub = tags.subscribeChanges(() => {});
    await Promise.all([comments.preload(), tags.preload()]);
    expect(tagsBackend.calls.list).toBe(1);

    const tx = comments.insert({
      id: newLocalId(),
      body: 'second',
      articleId: 'a1',
    });
    await tx.isPersisted.promise;
    // Give any (erroneous) invalidation time to fire.
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The mutated collection refetched (it is always in its own target set),
    // but the unrelated tags collection did not.
    expect(commentsBackend.calls.list).toBeGreaterThanOrEqual(2);
    expect(tagsBackend.calls.list).toBe(1);

    tagsSub.unsubscribe();
  });

  it('with a PRIVATE client, only the mutated collection refetches (no cross-collection reach)', async () => {
    // No shared client: each collection gets its own private query cache, so a
    // mutation on comments cannot reach the articles cache — documents the
    // shared-client requirement.
    const commentsBackend = makeScriptedFetchers([
      { id: 'c1', body: 'first', articleId: 'a1' },
    ]);
    const articlesBackend = makeScriptedFetchers([
      { id: 'a1', title: 'Hello' },
    ]);

    const comments = track(
      createSmrtCollection(commentsDefinition(), {
        fetchers: commentsBackend.fetchers,
        staleTimeMs: 60_000,
      }),
    );
    const articles = track(
      createSmrtCollection(articlesDefinition(), {
        fetchers: articlesBackend.fetchers,
        staleTimeMs: 60_000,
      }),
    );

    const articlesSub = articles.subscribeChanges(() => {});
    await Promise.all([comments.preload(), articles.preload()]);
    expect(articlesBackend.calls.list).toBe(1);

    const tx = comments.insert({
      id: newLocalId(),
      body: 'second',
      articleId: 'a1',
    });
    await tx.isPersisted.promise;
    await new Promise((resolve) => setTimeout(resolve, 20));

    // comments refetched on its own private cache; articles (private, separate
    // cache) was untouched.
    expect(commentsBackend.calls.list).toBeGreaterThanOrEqual(2);
    expect(articlesBackend.calls.list).toBe(1);

    articlesSub.unsubscribe();
  });
});
