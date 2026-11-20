/**
 * A cached single-target relationship follows its key field: pointing the
 * field at another row (or clearing it) makes the next load resolve the
 * current target instead of returning the stale one. An unchanged key still
 * returns the cached instance.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { field, foreignKey } from '../decorators';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { snapshotObjectRegistryState } from '../test-utils';
import { getTestDatabase } from '../testing/database';

@smrt({ packageName: '@relcache/models', tableName: 'relcache_owners' })
class RelCacheOwner extends SmrtObject {
  @field({ type: 'text' }) title = '';
}
class RelCacheOwnerCollection extends SmrtCollection<RelCacheOwner> {
  static readonly _itemClass = RelCacheOwner;
}

@smrt({ packageName: '@relcache/models', tableName: 'relcache_items' })
class RelCacheItem extends SmrtObject {
  @foreignKey('RelCacheOwner', { nullable: true })
  ownerId: string | null = null;
}
class RelCacheItemCollection extends SmrtCollection<RelCacheItem> {
  static readonly _itemClass = RelCacheItem;
}

describe('relationship cache follows the key field', () => {
  let restore: () => void;
  let db: Awaited<ReturnType<typeof getTestDatabase>>;
  let owners: RelCacheOwnerCollection;
  let items: RelCacheItemCollection;

  beforeEach(async () => {
    restore = snapshotObjectRegistryState();
    ObjectRegistry.registerCollection('RelCacheOwner', RelCacheOwnerCollection);
    ObjectRegistry.registerCollection('RelCacheItem', RelCacheItemCollection);
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['RelCacheOwner', 'RelCacheItem'],
    });
    owners = (await RelCacheOwnerCollection.create({ db })) as never;
    items = (await RelCacheItemCollection.create({ db })) as never;
  });

  afterEach(async () => {
    await db?.close?.();
    restore();
  });

  it('resolves the new target after the key is retargeted', async () => {
    const first = await owners.create({ title: 'first' } as never);
    const second = await owners.create({ title: 'second' } as never);
    const item = await items.create({ ownerId: first.id } as never);

    expect((await item.loadRelated('ownerId'))?.title).toBe('first');
    expect(item.isRelatedLoaded('ownerId')).toBe(true);

    item.ownerId = second.id as string;

    expect(item.isRelatedLoaded('ownerId')).toBe(false);
    expect((await item.loadRelated('ownerId'))?.title).toBe('second');
    expect((await item.getRelated('ownerId'))?.title).toBe('second');
  });

  it('returns null after the key is cleared and loads again once it is set', async () => {
    const first = await owners.create({ title: 'first' } as never);
    const item = await items.create({ ownerId: first.id } as never);
    await item.loadRelated('ownerId');

    item.ownerId = null;
    expect(await item.loadRelated('ownerId')).toBeNull();

    item.ownerId = first.id as string;
    expect((await item.loadRelated('ownerId'))?.title).toBe('first');
  });

  it('control: an unchanged key returns the cached instance', async () => {
    const first = await owners.create({ title: 'first' } as never);
    const item = await items.create({ ownerId: first.id } as never);

    const loaded = await item.loadRelated('ownerId');

    expect(await item.loadRelated('ownerId')).toBe(loaded);
    expect(item.isRelatedLoaded('ownerId')).toBe(true);
  });

  it('drops a seeded cache entry when the key changes', async () => {
    const first = await owners.create({ title: 'first' } as never);
    const second = await owners.create({ title: 'second' } as never);
    const item = await items.create({ ownerId: first.id } as never);
    item._setLoadedRelationship('ownerId', first);

    expect(await item.loadRelated('ownerId')).toBe(first);

    item.ownerId = second.id as string;
    expect((await item.loadRelated('ownerId'))?.title).toBe('second');
  });
});
