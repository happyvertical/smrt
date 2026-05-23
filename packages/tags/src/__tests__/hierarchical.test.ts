/**
 * Tests for Tag hierarchy after R3-B migration.
 *
 * Verifies that:
 * - `Tag.parentId` (UUID, inherited from `SmrtHierarchical`) is the
 *   underlying FK after the rename from `parentSlug`.
 * - `TagCollection` public methods still accept slug strings and resolve
 *   them internally — no caller code needs to change.
 * - `moveTag` / `mergeTag` cycle protection works via the inherited
 *   `SmrtHierarchical.moveTo`.
 * - The denormalised `level` field stays in sync after `moveTag`.
 */

import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TagAliasCollection } from '../tag-aliases';
import { TagCollection } from '../tags';

function tmpDbUrl(name: string): string {
  return `file:${join(
    tmpdir(),
    `smrt-tags-test-${name}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.db`,
  )}`;
}

describe('Tag hierarchy (R3-B: slug API → UUID storage)', () => {
  let dbPath: string;
  let dbUrl: string;
  let tags: TagCollection;

  beforeEach(async () => {
    dbUrl = tmpDbUrl('hierarchy');
    dbPath = dbUrl.replace('file:', '');
    tags = await TagCollection.create({
      db: { type: 'sqlite', url: dbUrl },
    });
    // mergeTag / cleanupUnused query TagAliasCollection — make sure the
    // tag_aliases schema is materialised before those tests run, even when
    // we have no aliases to migrate.
    await TagAliasCollection.create({
      db: { type: 'sqlite', url: dbUrl },
    });
  });

  afterEach(() => {
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  /**
   * Build a small forest:
   *
   *     tech
   *     ├── web
   *     │   └── frontend
   *     └── data
   *
   *     news (separate root)
   */
  async function buildForest() {
    const tech = await tags.getOrCreate('tech', 'blog');
    const web = await tags.create({
      slug: 'web',
      name: 'Web',
      context: 'blog',
      parentId: tech.id,
      level: 1,
    });
    await web.save();
    const data = await tags.create({
      slug: 'data',
      name: 'Data',
      context: 'blog',
      parentId: tech.id,
      level: 1,
    });
    await data.save();
    const frontend = await tags.create({
      slug: 'frontend',
      name: 'Frontend',
      context: 'blog',
      parentId: web.id,
      level: 2,
    });
    await frontend.save();
    const news = await tags.getOrCreate('news', 'blog');
    return { tech, web, data, frontend, news };
  }

  it('stores parent as UUID, not slug', async () => {
    const { tech, web } = await buildForest();
    const reloaded = await tags.get({ slug: 'web', context: 'blog' });
    expect(reloaded?.parentId).toBe(tech.id);
    expect(reloaded?.parentId).not.toBe(web.parentId === 'tech' ? 'tech' : '');
  });

  it('getChildren resolves slug to UUID internally', async () => {
    const { web, data } = await buildForest();
    const children = await tags.getChildren('tech');
    const ids = children.map((c) => c.id).sort();
    expect(ids).toEqual([web.id, data.id].sort());
  });

  it('getRootTags filters by parentId IS NULL', async () => {
    const { tech, news } = await buildForest();
    const roots = await tags.getRootTags('blog');
    const slugs = roots.map((t) => t.slug).sort();
    expect(slugs).toContain(tech.slug);
    expect(slugs).toContain(news.slug);
    expect(roots.find((t) => t.slug === 'web')).toBeUndefined();
  });

  it('getHierarchy returns ancestors, current, descendants', async () => {
    const { tech, web, frontend } = await buildForest();
    const h = await tags.getHierarchy('web');
    expect(h.ancestors.map((t) => t.id)).toEqual([tech.id]);
    expect(h.current.id).toBe(web.id);
    expect(h.descendants.map((t) => t.id)).toEqual([frontend.id]);
  });

  describe('moveTag', () => {
    it('reparents by slug + recalculates level for moved tag and descendants', async () => {
      const { data, frontend } = await buildForest();
      // Move `web` under `data`: web (level 2 now) → frontend (level 3).
      await tags.moveTag('web', 'data');

      const web = await tags.get({ slug: 'web', context: 'blog' });
      expect(web?.parentId).toBe(data.id);
      expect(web?.level).toBe(2);

      const movedFrontend = await tags.get({
        slug: 'frontend',
        context: 'blog',
      });
      expect(movedFrontend?.id).toBe(frontend.id);
      expect(movedFrontend?.level).toBe(3);
    });

    it('promotes a tag to root when newParentSlug is null', async () => {
      await buildForest();
      await tags.moveTag('web', null);
      const web = await tags.get({ slug: 'web', context: 'blog' });
      expect(web?.parentId).toBeNull();
      expect(web?.level).toBe(0);
    });

    it('refuses moves that would create a cycle', async () => {
      await buildForest();
      // Moving `tech` under its own descendant `frontend` must fail.
      await expect(tags.moveTag('tech', 'frontend')).rejects.toThrow(/cycle/i);
    });

    it('throws if the source slug is unknown', async () => {
      await buildForest();
      await expect(tags.moveTag('missing', 'tech')).rejects.toThrow(
        /not found/,
      );
    });

    it('throws if the new parent slug is unknown', async () => {
      await buildForest();
      await expect(tags.moveTag('web', 'missing')).rejects.toThrow(/not found/);
    });
  });

  describe('mergeTag', () => {
    it('reparents children of source onto target and deletes source', async () => {
      const { data, web, frontend } = await buildForest();
      // Merge `web` into `data`. `frontend` should now live under `data`.
      await tags.mergeTag('web', 'data');

      const movedFrontend = await tags.get({
        slug: 'frontend',
        context: 'blog',
      });
      expect(movedFrontend?.id).toBe(frontend.id);
      expect(movedFrontend?.parentId).toBe(data.id);

      // mergeTag deletes the source row. The old code asserted
      // `oldWeb?.id !== web.id` which was trivially true when the row was
      // gone — round-2 review flagged that as not actually testing the
      // delete. Use a direct null check.
      const oldWeb = await tags.get({ slug: 'web', context: 'blog' });
      expect(oldWeb).toBeNull();
      // Silence the unused-binding lint by referencing the original web.
      expect(web.id).toBeTruthy();
    });

    it('throws when source or target slug does not resolve', async () => {
      await buildForest();
      await expect(tags.mergeTag('missing', 'tech')).rejects.toThrow(
        /not found/,
      );
      await expect(tags.mergeTag('tech', 'missing')).rejects.toThrow(
        /not found/,
      );
    });

    it('refuses to merge a tag into itself', async () => {
      // Codex round-4 finding: self-merge must fail fast — otherwise the
      // children-reparenting loop attaches the source's children to
      // itself and the recursive level-update walk has no visited set,
      // so it stack-overflows.
      await buildForest();
      await expect(tags.mergeTag('tech', 'tech')).rejects.toThrow(/itself/i);
    });

    it('refuses to merge a tag into one of its own descendants (cycle)', async () => {
      // Codex round-4 finding: merging an ancestor into its descendant
      // would create a cycle (the descendant's ancestors get reparented
      // under itself), and `updateDescendantLevels` would recurse until
      // stack overflow. The pre-merge descendant check fails fast.
      await buildForest();
      await expect(tags.mergeTag('tech', 'frontend')).rejects.toThrow(
        /descendant|cycle/i,
      );
    });

    it("doesn't rewrite aliases in OTHER contexts when merge is context-scoped", async () => {
      // Codex round-7 finding (and round-2 deferred): when
      // `mergeTag('foo', 'bar', 'blog')` is called, only blog-context
      // aliases for `foo` should be rewritten. Aliases for `foo` in
      // other contexts (e.g. 'forum') must be left alone — they
      // belong to a different tag entirely (slug+context is the
      // natural key).
      const aliases = await TagAliasCollection.create({
        db: { type: 'sqlite', url: dbUrl },
      });

      // Build same-slug tags in two different contexts.
      const blogFoo = await tags.getOrCreate('foo', 'blog');
      const blogBar = await tags.getOrCreate('bar', 'blog');
      const forumFoo = await tags.getOrCreate('foo', 'forum');
      // Silence unused-binding lints — we reference these in the
      // assertions below.
      expect(blogFoo.id).toBeTruthy();
      expect(blogBar.id).toBeTruthy();
      expect(forumFoo.id).toBeTruthy();

      await aliases.create({
        tagSlug: 'foo',
        alias: 'BlogFoo',
        language: 'en',
        context: 'blog',
      });
      await aliases.create({
        tagSlug: 'foo',
        alias: 'ForumFoo',
        language: 'en',
        context: 'forum',
      });

      await tags.mergeTag('foo', 'bar', 'blog');

      // The blog-context alias should have been rewritten to `bar`.
      const blogAliases = await aliases.list({
        where: { context: 'blog', tagSlug: 'bar' },
      });
      expect(blogAliases.map((a) => a.alias)).toContain('BlogFoo');

      // The forum-context alias must be untouched — still pointing at
      // `foo`, NOT rewritten to `bar`.
      const forumAliases = await aliases.list({
        where: { context: 'forum' },
      });
      const forumFooAliases = forumAliases.filter((a) => a.tagSlug === 'foo');
      expect(forumFooAliases.map((a) => a.alias)).toContain('ForumFoo');
      const forumBarAliases = forumAliases.filter((a) => a.tagSlug === 'bar');
      expect(forumBarAliases).toHaveLength(0);
    });

    it('migrates unscoped aliases (context="") on default-context merge', async () => {
      // Codex round-8 finding: `Tag._context` defaults to `'global'`,
      // but `TagAliasCollection.addAlias(slug, alias)` leaves the
      // alias's `_context` at its `''` default when no context is
      // passed. A strict `context: fromTag.context` filter would
      // orphan those `''`-context aliases for default-context
      // merges, leaving rows that point at a now-deleted tag.
      const aliases = await TagAliasCollection.create({
        db: { type: 'sqlite', url: dbUrl },
      });

      // Default-context (global) tags.
      const globalFoo = await tags.getOrCreate('foo');
      const globalBar = await tags.getOrCreate('bar');
      expect(globalFoo.context).toBe('global');
      expect(globalBar.context).toBe('global');

      // Alias created via `addAlias` with no context — ends up with
      // `_context = ''` (NOT 'global').
      await aliases.addAlias('foo', 'GlobalUnscoped', 'en');

      // Sanity-check the default-mismatch the bug hinges on.
      const beforeUnscoped = await aliases.list({
        where: { tagSlug: 'foo', context: '' },
      });
      expect(beforeUnscoped).toHaveLength(1);

      await tags.mergeTag('foo', 'bar');

      // After merge, the alias must have been rewritten to `bar`
      // — not orphaned at `tagSlug: 'foo'` (now deleted).
      const orphans = await aliases.list({
        where: { tagSlug: 'foo' },
      });
      expect(orphans).toHaveLength(0);

      const migrated = await aliases.list({
        where: { tagSlug: 'bar', context: '' },
      });
      expect(migrated.map((a) => a.alias)).toContain('GlobalUnscoped');
    });
  });

  it('cleanupUnused only deletes leaves with no aliases', async () => {
    await buildForest();
    // Leaves (tags with no children) in the forest are: `data` (child
    // of tech but has no children of its own), `frontend` (child of
    // web), and `news` (separate root). None has aliases, so all three
    // are deletable. `tech` and `web` are interior nodes and must stay.
    const deleted = await tags.cleanupUnused('blog');
    expect(deleted).toBe(3);

    expect(await tags.get({ slug: 'tech', context: 'blog' })).not.toBeNull();
    expect(await tags.get({ slug: 'web', context: 'blog' })).not.toBeNull();

    expect(await tags.get({ slug: 'data', context: 'blog' })).toBeNull();
    expect(await tags.get({ slug: 'frontend', context: 'blog' })).toBeNull();
    expect(await tags.get({ slug: 'news', context: 'blog' })).toBeNull();
  });

  describe('context-aware slug resolution (Copilot review findings)', () => {
    /**
     * Build a small two-context forest:
     *
     *   'blog'  context:  reviews (root) → tech (root) → web
     *   'forum' context:  tech   (root)            ← same slug, different context
     */
    async function buildAmbiguousForest() {
      const blogReviews = await tags.getOrCreate('reviews', 'blog');
      const blogTech = await tags.getOrCreate('tech', 'blog');
      const blogWeb = await tags.create({
        slug: 'web',
        name: 'Web',
        context: 'blog',
        parentId: blogTech.id,
        level: 1,
      });
      await blogWeb.save();
      const forumTech = await tags.getOrCreate('tech', 'forum');
      return { blogReviews, blogTech, blogWeb, forumTech };
    }

    it('moveTag throws when the slug is ambiguous across contexts', async () => {
      await buildAmbiguousForest();
      // Two 'tech' rows now exist (one in 'blog', one in 'forum'). Without
      // an explicit context the resolver can't tell them apart and must
      // refuse rather than silently picking one.
      await expect(tags.moveTag('tech', 'reviews')).rejects.toThrow(
        /ambiguous|multiple/i,
      );
    });

    it('moveTag resolves within the supplied context', async () => {
      const { blogReviews } = await buildAmbiguousForest();
      // Explicit context disambiguates — move blog's tech under
      // blog's reviews. forum's tech is untouched.
      await tags.moveTag('tech', 'reviews', 'blog');

      const movedBlogTech = await tags.get({ slug: 'tech', context: 'blog' });
      expect(movedBlogTech?.parentId).toBe(blogReviews.id);

      const forumTechAfter = await tags.get({
        slug: 'tech',
        context: 'forum',
      });
      expect(forumTechAfter?.parentId).toBeNull();
    });

    it('moveTag refuses to cross context boundaries', async () => {
      await buildAmbiguousForest();
      // 'tech' in blog, 'tech' in forum — moving blog/tech under
      // forum/tech should fail with a clear "contexts must match" error
      // because the resolver picks the source's context for the parent
      // lookup, then mismatches.
      await expect(tags.moveTag('tech', 'tech', 'blog')).rejects.toThrow(
        /itself|cycle|contexts must match/,
      );
    });

    it('mergeTag throws when slugs are ambiguous across contexts', async () => {
      await buildAmbiguousForest();
      // Both 'tech' rows could match — fail rather than picking one.
      await expect(tags.mergeTag('tech', 'reviews')).rejects.toThrow(
        /ambiguous|multiple|not found/i,
      );
    });

    it('mergeTag recalculates child level when source and target sit at different depths', async () => {
      // Forest: rootA → midA → leafA  (leafA.level = 2)
      //         rootB                 (rootB.level = 0)
      // Merge midA into rootB. leafA was at depth 2 under rootA→midA.
      // After merge, leafA hangs off rootB at depth 1 — level must
      // recalc, the old code left it at 2.
      const rootA = await tags.getOrCreate('root-a', 'blog');
      const midA = await tags.create({
        slug: 'mid-a',
        name: 'Mid A',
        context: 'blog',
        parentId: rootA.id,
        level: 1,
      });
      await midA.save();
      const leafA = await tags.create({
        slug: 'leaf-a',
        name: 'Leaf A',
        context: 'blog',
        parentId: midA.id,
        level: 2,
      });
      await leafA.save();
      const rootB = await tags.getOrCreate('root-b', 'blog');

      await tags.mergeTag('mid-a', 'root-b');

      const reloadedLeaf = await tags.get({
        slug: 'leaf-a',
        context: 'blog',
      });
      expect(reloadedLeaf?.parentId).toBe(rootB.id);
      // rootB.level = 0, so leafA's new level is rootB.level + 1 = 1.
      expect(reloadedLeaf?.level).toBe(1);
    });
  });
});
