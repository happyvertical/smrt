/**
 * `registerCollection` changes what registry lookups return (the item's
 * collection constructor and, for a junction collection, the item's internal
 * kind), so it must invalidate every generation-keyed memo.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../../collection';
import { SmrtObject } from '../../object';
import { ObjectRegistry, smrt } from '../../registry';
import { snapshotObjectRegistryState } from '../../test-utils';
import { getRegistryGeneration } from '../generation';

let restore: () => void;
beforeEach(() => {
  restore = snapshotObjectRegistryState();
  ObjectRegistry.clear();
});
afterEach(() => restore());

type CollectionCtor = Parameters<typeof ObjectRegistry.registerCollection>[1];

describe('registerCollection bumps registry generation', () => {
  it('bumps each time it changes the item collection constructor', () => {
    const Item = class GenItem extends SmrtObject {
      label = '';
    };
    smrt({ packageName: '@fixture/gen-bump' })(Item);
    const First = class GenItems extends SmrtCollection<
      InstanceType<typeof Item>
    > {
      static readonly _itemClass = Item;
    } as unknown as CollectionCtor;
    const Second = class GenItemsAgain extends SmrtCollection<
      InstanceType<typeof Item>
    > {
      static readonly _itemClass = Item;
    } as unknown as CollectionCtor;

    let before = getRegistryGeneration();
    ObjectRegistry.registerCollection('@fixture/gen-bump:GenItem', First);
    expect(getRegistryGeneration()).toBeGreaterThan(before);
    expect(
      ObjectRegistry.getClass('@fixture/gen-bump:GenItem')
        ?.collectionConstructor,
    ).toBe(First);

    before = getRegistryGeneration();
    ObjectRegistry.registerCollection('@fixture/gen-bump:GenItem', Second);
    expect(getRegistryGeneration()).toBeGreaterThan(before);
  });
});
