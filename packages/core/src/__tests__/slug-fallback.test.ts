/**
 * Slug derivation falls through to the next candidate (name, title, label,
 * then id) when a candidate has no ASCII letters or digits. The derivation
 * runs before any SQL, so SQLite alone covers it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { field } from '../decorators';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { snapshotObjectRegistryState } from '../test-utils';
import { getTestDatabase } from '../testing/database';

@smrt({ packageName: '@slug-fallback/models' })
class SlugFallbackThing extends SmrtObject {
  @field({ type: 'text' })
  name = '';
  @field({ type: 'text' })
  title = '';
  @field({ type: 'text' })
  label = '';
}

class SlugFallbackThingCollection extends SmrtCollection<SlugFallbackThing> {
  static readonly _itemClass = SlugFallbackThing;
}

describe('slug derivation fallback', () => {
  let restore: () => void;
  let db: Awaited<ReturnType<typeof getTestDatabase>>;
  let things: SlugFallbackThingCollection;

  beforeEach(async () => {
    restore = snapshotObjectRegistryState();
    ObjectRegistry.registerCollection(
      'SlugFallbackThing',
      SlugFallbackThingCollection,
    );
    db = await getTestDatabase({
      classes: ['SlugFallbackThing'],
      type: 'sqlite',
      url: ':memory:',
    });
    things = await SlugFallbackThingCollection.create({ db });
  });

  afterEach(async () => {
    await db?.close?.();
    restore();
  });

  const slugOf = async (data: Record<string, string>) => {
    const created = await things.create(data);
    await created.save();
    return { slug: created.slug, id: created.id };
  };

  it('uses the title when the name has no ASCII letters or digits', async () => {
    expect((await slugOf({ name: 'Привет', title: 'Hello World' })).slug).toBe(
      'hello-world',
    );
  });

  it('uses the label when name and title have no ASCII letters or digits', async () => {
    expect(
      (await slugOf({ name: '???', title: '東京', label: 'Front Desk' })).slug,
    ).toBe('front-desk');
  });

  it('falls back to the id when every candidate slugifies to nothing', async () => {
    const { slug, id } = await slugOf({ name: '🎉🎉', title: 'مرحبا' });
    expect(slug).toBe(String(id).toLowerCase());
  });

  it('keeps a slug that already succeeds unchanged', async () => {
    expect((await slugOf({ name: 'My Widget', title: 'Other' })).slug).toBe(
      'my-widget',
    );
    expect((await slugOf({ name: 'Café Zoë' })).slug).toBe('caf-zo');
  });

  it('keeps an explicit slug', async () => {
    expect((await slugOf({ name: 'Привет', slug: 'привет' })).slug).toBe(
      'привет',
    );
  });
});
