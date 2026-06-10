/**
 * Issue #1472: save() on a loaded object with a changed slug must not
 * violate the `*_pkey` primary-key constraint.
 *
 * Background
 * ----------
 * `save()` persists via upsert against the registry's natural-key conflict
 * columns (default `['slug', 'context']`, plus `'_meta_type'` for STI).
 * When the slug of an **existing** row changes, the conflict target no
 * longer matches any row, so the upsert takes the INSERT path with the
 * object's existing `id` and collides on the primary key:
 *
 *     duplicate key value violates unique constraint "contents_pkey"
 *
 * Net effect before the fix: natural-key fields were effectively immutable
 * for any persisted SmrtObject.
 *
 * Resolution
 * ----------
 * SmrtObject now tracks whether it is backed by an existing database row
 * (`isPersisted`), set during hydration (collection get/list/query,
 * `loadFromId()`, `loadFromSlug()`) and after a successful `save()`.
 * Persisted objects upsert with `['id']` as the conflict target, so
 * natural-key edits update the existing row in place. New objects keep the
 * natural-key conflict columns so ingestion-style dedup (create /
 * getOrUpsert against a known slug) still updates matching rows instead of
 * inserting duplicates.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { field } from '../decorators';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { getTestDatabase } from '../testing/database';

@smrt({ tableName: 'issue_1472_contents' })
class Issue1472Content extends SmrtObject {
  @field()
  title: string = '';

  @field()
  status: string = 'draft';

  constructor(options: Record<string, any> = {}) {
    super(options as any);
    if (options.title !== undefined) this.title = options.title;
    if (options.status !== undefined) this.status = options.status;
  }
}

class Issue1472ContentCollection extends SmrtCollection<Issue1472Content> {
  static readonly _itemClass = Issue1472Content;
}

// STI hierarchy mirroring the `contents` table from the original report.
@smrt({ tableName: 'issue_1472_sti_contents', tableStrategy: 'sti' })
class Issue1472StiContent extends SmrtObject {
  @field()
  title: string = '';

  constructor(options: Record<string, any> = {}) {
    super(options as any);
    if (options.title !== undefined) this.title = options.title;
  }
}

@smrt()
class Issue1472StiArticle extends Issue1472StiContent {}

class Issue1472StiContentCollection extends SmrtCollection<Issue1472StiContent> {
  static readonly _itemClass = Issue1472StiContent;
}

function requireFound<T>(value: T | null | undefined): T {
  if (!value) throw new Error('expected a loaded instance');
  return value;
}

describe('Issue #1472: save() after renaming a natural-key field', () => {
  let db: Awaited<ReturnType<typeof getTestDatabase>>;
  let contents: Issue1472ContentCollection;

  beforeEach(async () => {
    db = await getTestDatabase({
      classes: [
        'Issue1472Content',
        'Issue1472StiContent',
        'Issue1472StiArticle',
      ],
    });
    ObjectRegistry.registerCollection(
      'Issue1472Content',
      Issue1472ContentCollection,
    );
    contents = (await Issue1472ContentCollection.create({
      db,
    })) as Issue1472ContentCollection;
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  it('renames the slug of an object loaded via collection.get() (issue repro)', async () => {
    const item = await contents.create({
      title: 'A',
      slug: 'old-slug',
      status: 'draft',
    });

    const loaded = requireFound(await contents.get(String(item.id)));
    expect(loaded.isPersisted).toBe(true);

    loaded.slug = 'new-slug';
    await loaded.save();

    const all = await db.list('issue_1472_contents', {});
    expect(all).toHaveLength(1);
    expect((all[0] as Record<string, unknown>).slug).toBe('new-slug');
    expect((all[0] as Record<string, unknown>).id).toBe(item.id);
  });

  it('renames the slug of an object hydrated via list()', async () => {
    await contents.create({ title: 'B', slug: 'list-slug', status: 'draft' });

    const [loaded] = await contents.list({ where: { slug: 'list-slug' } });
    expect(loaded.isPersisted).toBe(true);

    loaded.slug = 'list-slug-renamed';
    await loaded.save();

    const all = await db.list('issue_1472_contents', {});
    expect(all).toHaveLength(1);
    expect((all[0] as Record<string, unknown>).slug).toBe('list-slug-renamed');
  });

  it('renames the slug of an object hydrated via loadFromSlug()', async () => {
    const item = await contents.create({
      title: 'C',
      slug: 'slug-load',
      status: 'draft',
    });

    const loaded = new Issue1472Content({ db, slug: 'slug-load' });
    await loaded.initialize();
    expect(loaded.id).toBe(item.id);
    expect(loaded.isPersisted).toBe(true);

    loaded.slug = 'slug-load-renamed';
    await loaded.save();

    const all = await db.list('issue_1472_contents', {});
    expect(all).toHaveLength(1);
    expect((all[0] as Record<string, unknown>).slug).toBe('slug-load-renamed');
  });

  it('renames the slug on the same in-memory instance returned by create()', async () => {
    const item = await contents.create({
      title: 'D',
      slug: 'create-slug',
      status: 'draft',
    });
    // A successful save() marks the object as persisted.
    expect(item.isPersisted).toBe(true);

    item.slug = 'create-slug-renamed';
    await item.save();

    const all = await db.list('issue_1472_contents', {});
    expect(all).toHaveLength(1);
    expect((all[0] as Record<string, unknown>).slug).toBe(
      'create-slug-renamed',
    );
    expect((all[0] as Record<string, unknown>).id).toBe(item.id);
  });

  it('still updates status (non-natural-key field) on a loaded object', async () => {
    const item = await contents.create({
      title: 'E',
      slug: 'status-slug',
      status: 'draft',
    });

    const loaded = requireFound(await contents.get(String(item.id)));
    loaded.status = 'published';
    await loaded.save();

    const all = await db.list('issue_1472_contents', {});
    expect(all).toHaveLength(1);
    expect((all[0] as Record<string, unknown>).status).toBe('published');
  });

  it('keeps natural-key dedup for new (non-persisted) objects', async () => {
    // Ingestion-style flows (e.g. re-scrapes) rely on saving a brand-new
    // object with a known slug to update the existing row instead of
    // inserting a duplicate. That behavior must survive the #1472 fix.
    await contents.create({ title: 'F', slug: 'dedup-slug', status: 'draft' });

    const rescraped = new Issue1472Content({
      db,
      slug: 'dedup-slug',
      title: 'F (rescraped)',
      _skipLoad: true,
    });
    await rescraped.initialize();
    expect(rescraped.isPersisted).toBe(false);
    (rescraped as any)._id = crypto.randomUUID();
    await rescraped.save();

    const all = await db.list('issue_1472_contents', {});
    expect(all).toHaveLength(1);
    expect((all[0] as Record<string, unknown>).title).toBe('F (rescraped)');
  });

  it('resets persistence on delete() so a re-save inserts a fresh row', async () => {
    const item = await contents.create({
      title: 'G',
      slug: 'delete-slug',
      status: 'draft',
    });
    expect(item.isPersisted).toBe(true);

    await item.delete();
    expect(item.isPersisted).toBe(false);

    await item.save();
    const all = await db.list('issue_1472_contents', {});
    expect(all).toHaveLength(1);
    expect((all[0] as Record<string, unknown>).slug).toBe('delete-slug');
  });

  it('renames the slug of a loaded STI child without violating the PK', async () => {
    ObjectRegistry.registerCollection(
      'Issue1472StiContent',
      Issue1472StiContentCollection,
    );
    const stiContents = await Issue1472StiContentCollection.create({ db });

    const article = await stiContents.create({
      _meta_type: 'Issue1472StiArticle',
      title: 'STI Article',
      slug: 'sti-old-slug',
    });

    const loaded = requireFound(await stiContents.get(String(article.id)));
    expect(loaded.isPersisted).toBe(true);
    expect(loaded).toBeInstanceOf(Issue1472StiArticle);

    loaded.slug = 'sti-new-slug';
    await loaded.save();

    const all = await db.list('issue_1472_sti_contents', {});
    expect(all).toHaveLength(1);
    expect((all[0] as Record<string, unknown>).slug).toBe('sti-new-slug');
    expect((all[0] as Record<string, unknown>).id).toBe(article.id);
  });
});
