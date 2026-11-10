import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../../collection.js';
import { SmrtObject } from '../../object.js';
import { ObjectRegistry } from '../../registry.js';
import { snapshotObjectRegistryState } from '../../test-utils.js';
import { isCollectionRegistration } from '../collection-resolution.js';
import type { RegisteredClass } from '../types.js';

const lookup = { findClass: () => undefined, getInheritanceChain: () => [] };
// RegisteredClass historically types constructors as model-only. These fixtures
// retain the real constructor value to test collection classification itself.
const registration = (
  classConstructor: unknown,
  extendsName = 'DomainCollection',
) =>
  ({
    name: 'Actions',
    constructor: classConstructor,
    extends: extendsName,
  }) as unknown as RegisteredClass;

describe('#4171 undecorated collection ancestry', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = snapshotObjectRegistryState();
  });
  afterEach(() => {
    restore();
  });

  it('recognizes a real collection through an unregistered domain parent', () => {
    class Item extends SmrtObject {}
    class DomainCollection extends SmrtCollection<Item> {
      static readonly _itemClass = Item;
      inheritedBehavior() {
        return 'canonical';
      }
    }
    class Actions extends DomainCollection {}
    expect(new Actions().inheritedBehavior()).toBe('canonical');
    expect(
      isCollectionRegistration('Actions', registration(Actions), lookup),
    ).toBe(true);
  });

  it('does not trust a model constructor name or an _itemClass property', () => {
    class Item extends SmrtObject {}
    const Pretender = class SmrtCollection extends SmrtObject {
      static _itemClass = Item;
    };
    expect(
      isCollectionRegistration('Actions', registration(Pretender), lookup),
    ).toBe(false);
    ObjectRegistry.register(Item, {
      packageName: '@fixture/ownership4171',
      tableName: 'ownership_4171',
    });
    ObjectRegistry.register(Pretender, {
      packageName: '@fixture/ownership4171',
      tableName: 'ownership_4171',
    });
    expect(() => ObjectRegistry.getAllSchemasAsDefinitions()).toThrow(
      /claimed by unrelated classes/,
    );
  });

  it('preserves metadata-only behavior when no live collection constructor exists', () => {
    expect(
      isCollectionRegistration(
        'Actions',
        registration(undefined, 'SmrtCollection'),
        lookup,
      ),
    ).toBe(true);
    expect(
      isCollectionRegistration('Actions', registration(undefined), lookup),
    ).toBe(false);
    const parent = registration(undefined, 'SmrtCollection');
    expect(
      isCollectionRegistration('Actions', registration(undefined), {
        findClass: () => parent,
        getInheritanceChain: () => ['DomainCollection'],
      }),
    ).toBe(true);
  });
});
