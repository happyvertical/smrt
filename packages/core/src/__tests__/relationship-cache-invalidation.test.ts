/**
 * A cached single-target relationship follows its key field: pointing the
 * field at another row (or clearing it) makes the next load resolve the
 * current target instead of returning the stale one. An unchanged key still
 * returns the cached instance.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmrtCollection } from '../collection';
import { field, foreignKey } from '../decorators';
import { TenantIsolationError } from '../errors';
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

// The single-table family uses the package's own identity (no packageName),
// so the generated test manifest and the runtime registration agree on it.
@smrt({ tableName: 'relcache_parties', tableStrategy: 'sti' })
class RelCacheParty extends SmrtObject {
  @field() tenantId: string | null = null;
  @field({ type: 'text' }) title = '';
}
class RelCachePartyCollection extends SmrtCollection<RelCacheParty> {
  static readonly _itemClass = RelCacheParty;
}

@smrt()
class RelCacheOrg extends RelCacheParty {}

@smrt()
class RelCachePerson extends RelCacheParty {}

@smrt({ tableName: 'relcache_bills' })
class RelCacheBill extends SmrtObject {
  @field() tenantId: string | null = null;
  @foreignKey('RelCacheOrg', { nullable: true, validateSubtype: true })
  orgId: string | null = null;
}
class RelCacheBillCollection extends SmrtCollection<RelCacheBill> {
  static readonly _itemClass = RelCacheBill;
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

  /** Hold the next target load until the test releases it. */
  function gateNextOwnerLoad() {
    let reached!: () => void;
    let release!: () => void;
    const atGate = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = RelCacheOwner.prototype.initialize;
    const spy = vi
      .spyOn(RelCacheOwner.prototype, 'initialize')
      .mockImplementationOnce(async function (
        this: RelCacheOwner,
        ...args: unknown[]
      ) {
        reached();
        await released;
        return (original as any).apply(this, args);
      });
    return { atGate, release, spy };
  }

  it('keeps a load that finishes after the key changed from being cached under the new key', async () => {
    const first = await owners.create({ title: 'first' } as never);
    const second = await owners.create({ title: 'second' } as never);
    const item = await items.create({ ownerId: first.id } as never);
    const gate = gateNextOwnerLoad();
    try {
      const loading = item.loadRelated('ownerId');
      await gate.atGate;
      item.ownerId = second.id as string;
      gate.release();

      expect((await loading)?.title).toBe('second');
      expect((await item.getRelated('ownerId'))?.title).toBe('second');
      expect(item.isRelatedLoaded('ownerId')).toBe(true);
    } finally {
      gate.spy.mockRestore();
    }
  });

  it('keeps a miss that finishes after the key changed from being cached under the new key', async () => {
    const second = await owners.create({ title: 'second' } as never);
    const item = await items.create({} as never);
    // Names a row that does not exist (in memory only; never saved).
    item.ownerId = '00000000-0000-4000-8000-000000000000';
    const gate = gateNextOwnerLoad();
    try {
      const loading = item.loadRelated('ownerId');
      await gate.atGate;
      item.ownerId = second.id as string;
      gate.release();

      expect((await loading)?.title).toBe('second');
      expect((await item.getRelated('ownerId'))?.title).toBe('second');
    } finally {
      gate.spy.mockRestore();
    }
  });

  it('a seeded collection relationship stays cached when assigned back to its field', async () => {
    const item = await items.create({} as never);
    const list = [await owners.create({ title: 'listed' } as never)];
    item._setLoadedRelationship('listedOwners', list);
    (item as any).listedOwners = list.slice();
    expect(item.isRelatedLoaded('listedOwners')).toBe(true);
  });

  describe('typed (validateSubtype) single-table target', () => {
    let parties: RelCachePartyCollection;
    let bills: RelCacheBillCollection;

    beforeEach(async () => {
      ObjectRegistry.registerCollection(
        'RelCacheParty',
        RelCachePartyCollection,
      );
      ObjectRegistry.registerCollection('RelCacheBill', RelCacheBillCollection);
      await db.close?.();
      db = await getTestDatabase({
        type: 'sqlite',
        url: ':memory:',
        classes: ['RelCacheParty', 'RelCacheBill'],
      });
      parties = (await RelCachePartyCollection.create({ db })) as never;
      bills = (await RelCacheBillCollection.create({ db })) as never;
    });

    /**
     * Hold the next discriminator read of the single table (the row fetch
     * that decides the stored subtype) until the test releases it.
     */
    function gateNextDiscriminatorRead() {
      let reached!: () => void;
      let release!: () => void;
      const atGate = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = db.get.bind(db);
      let gated = false;
      const spy = vi
        .spyOn(db, 'get')
        .mockImplementation(async (table: string, ...rest: unknown[]) => {
          if (!gated && table === 'relcache_parties') {
            gated = true;
            reached();
            await released;
          }
          return (original as any)(table, ...rest);
        });
      return { atGate, release, spy };
    }

    async function seed() {
      const person = await parties.create({
        _meta_type: '@happyvertical/smrt-core:RelCachePerson',
        tenantId: 'tenant-a',
        title: 'person',
      } as never);
      const org = await parties.create({
        _meta_type: '@happyvertical/smrt-core:RelCacheOrg',
        tenantId: 'tenant-a',
        title: 'org',
      } as never);
      const otherTenantOrg = await parties.create({
        _meta_type: '@happyvertical/smrt-core:RelCacheOrg',
        tenantId: 'tenant-b',
        title: 'other tenant org',
      } as never);
      const bill = await bills.create({
        tenantId: 'tenant-a',
        orgId: org.id,
      } as never);
      return { person, org, otherTenantOrg, bill };
    }

    it('loads the current target when the key moves off a sibling-subtype row during the subtype read', async () => {
      const { person, org, bill } = await seed();
      // In memory only: the key names a sibling-subtype row.
      bill.orgId = person.id as string;
      const gate = gateNextDiscriminatorRead();
      try {
        const loading = bill.loadRelated('orgId');
        await gate.atGate;
        bill.orgId = org.id as string;
        gate.release();

        const loaded = await loading;
        expect(loaded?.id).toBe(org.id);
        expect(loaded).toBeInstanceOf(RelCacheOrg);
        expect((await bill.getRelated('orgId'))?.id).toBe(org.id);
      } finally {
        gate.spy.mockRestore();
      }
    });

    it('still applies tenant isolation to the target loaded after the key moved', async () => {
      const { person, otherTenantOrg, bill } = await seed();
      bill.orgId = person.id as string;
      const gate = gateNextDiscriminatorRead();
      try {
        const loading = bill.loadRelated('orgId');
        await gate.atGate;
        bill.orgId = otherTenantOrg.id as string;
        gate.release();

        await expect(loading).rejects.toThrow(TenantIsolationError);
        expect(bill.isRelatedLoaded('orgId')).toBe(false);
      } finally {
        gate.spy.mockRestore();
      }
    });

    it('control: a sibling-subtype key that stays put is still refused', async () => {
      const { person, bill } = await seed();
      bill.orgId = person.id as string;

      await expect(bill.loadRelated('orgId')).rejects.toThrow('points to');
    });
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
