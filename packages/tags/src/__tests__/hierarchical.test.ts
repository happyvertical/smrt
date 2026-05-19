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

      const oldWeb = await tags.get({ slug: 'web', context: 'blog' });
      // mergeTag deletes the source row.
      expect(oldWeb?.id).not.toBe(web.id);
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
  });

  it('cleanupUnused only deletes leaves with no aliases', async () => {
    const { news } = await buildForest();
    // `news` is a leaf root with no aliases — safe to delete.
    const deleted = await tags.cleanupUnused('blog');
    expect(deleted).toBeGreaterThanOrEqual(1);
    const stillThereTech = await tags.get({ slug: 'tech', context: 'blog' });
    expect(stillThereTech).not.toBeNull();
    const goneNews = await tags.get({ slug: 'news', context: 'blog' });
    expect(goneNews?.id).not.toBe(news.id);
  });
});
