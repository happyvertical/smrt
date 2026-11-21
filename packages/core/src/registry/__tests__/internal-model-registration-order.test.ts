/**
 * Decorator-path internal-model stamps. A junction collection is recognised
 * by the static `_isJunctionBase` brand (not `instanceof`, not its name), and
 * its item is found by constructor, so the stamp lands on the item's own
 * registration whatever the registration order and whatever other package
 * declares a class of the same simple name. The stamps are recorded only;
 * no effective config reads them yet.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../../collection';
import { SmrtJunction } from '../../junction';
import { SmrtObject } from '../../object';
import { ObjectRegistry, smrt } from '../../registry';
import { snapshotObjectRegistryState } from '../../test-utils';

const PKG_A = '@fixture/imo-a';
const PKG_B = '@fixture/imo-b';

let restore: () => void;
beforeEach(() => {
  restore = snapshotObjectRegistryState();
  ObjectRegistry.clear();
});
afterEach(() => restore());

function pair(packageName = PKG_A) {
  const Tag = class Tag extends SmrtObject {
    label = '';
  };
  const TagLinks = class TagLinks extends SmrtJunction<
    InstanceType<typeof Tag>
  > {
    static readonly _itemClass = Tag;
    protected leftField = 'ownerId';
    protected rightField = 'tagId';
  };
  return { Tag, TagLinks, packageName };
}

const kindOf = (ctor: typeof SmrtObject) =>
  ObjectRegistry.getClassByConstructor(ctor)?.internalKind;

describe('registration orders and intervening getConfig keep item internal', () => {
  it('item decorated first, then its junction collection', () => {
    const { Tag, TagLinks, packageName } = pair();
    smrt({ packageName })(Tag);
    expect(kindOf(Tag)).toBeUndefined();
    ObjectRegistry.getConfig(`${packageName}:Tag`);
    smrt({ packageName })(TagLinks);
    expect(kindOf(Tag)).toBe('junction');
    ObjectRegistry.getConfig(`${packageName}:Tag`);
    expect(kindOf(Tag)).toBe('junction');
  });

  it('junction collection decorated first registers its item stamped, and the item decorator keeps the stamp', () => {
    const { Tag, TagLinks, packageName } = pair();
    smrt({ packageName })(TagLinks);
    expect(kindOf(Tag)).toBe('junction');
    ObjectRegistry.getConfig(`${packageName}:Tag`);
    smrt({ packageName })(Tag);
    expect(kindOf(Tag)).toBe('junction');
  });

  it('an undecorated junction collection registered before its item stamps the item when it registers', () => {
    const { Tag, TagLinks, packageName } = pair();
    ObjectRegistry.registerCollection(
      'Tag',
      TagLinks as unknown as Parameters<
        typeof ObjectRegistry.registerCollection
      >[1],
    );
    smrt({ packageName })(Tag);
    expect(kindOf(Tag)).toBe('junction');
  });

  it('a plain collection over the same item leaves a junction item stamped, and never stamps its own item', () => {
    const { Tag, TagLinks, packageName } = pair();
    const Note = class Note extends SmrtObject {
      body = '';
    };
    const Notes = class Notes extends SmrtCollection<
      InstanceType<typeof Note>
    > {
      static readonly _itemClass = Note;
    };
    const TagNotes = class TagNotes extends SmrtCollection<
      InstanceType<typeof Tag>
    > {
      static readonly _itemClass = Tag;
    };
    smrt({ packageName })(TagLinks);
    smrt({ packageName })(Notes);
    smrt({ packageName })(TagNotes);
    expect(kindOf(Tag)).toBe('junction');
    expect(kindOf(Note)).toBeUndefined();
  });

  it('a collection branded by another core copy is recognised by the brand', () => {
    class OtherCopyJunctionBase<
      T extends SmrtObject,
    > extends SmrtCollection<T> {
      static readonly _isJunctionBase = true as const;
    }
    const Pin = class Pin extends SmrtObject {
      label = '';
    };
    const PinLinks = class PinLinks extends OtherCopyJunctionBase<
      InstanceType<typeof Pin>
    > {
      static readonly _itemClass = Pin;
    };
    smrt({ packageName: PKG_A })(Pin);
    smrt({ packageName: PKG_A })(PinLinks);
    expect(kindOf(Pin)).toBe('junction');
  });
});

const asCollection = (ctor: unknown) =>
  ctor as Parameters<typeof ObjectRegistry.registerCollection>[1];

describe('the pending junction item set is registry state', () => {
  it('a registry reset forgets junction items: the same constructor registered afterwards is not stamped', () => {
    const { Tag, TagLinks, packageName } = pair();
    smrt({ packageName })(TagLinks);
    expect(kindOf(Tag)).toBe('junction');
    ObjectRegistry.clear();
    smrt({ packageName })(Tag);
    expect(kindOf(Tag)).toBeUndefined();
  });

  it('a snapshot restore drops junction items named after the snapshot and keeps earlier ones', () => {
    const before = pair();
    ObjectRegistry.registerCollection('Tag', asCollection(before.TagLinks));
    const restoreInner = snapshotObjectRegistryState();
    const after = pair();
    ObjectRegistry.registerCollection('Tag', asCollection(after.TagLinks));
    restoreInner();
    smrt({ packageName: PKG_A })(after.Tag);
    expect(kindOf(after.Tag)).toBeUndefined();
    smrt({ packageName: PKG_B })(before.Tag);
    expect(kindOf(before.Tag)).toBe('junction');
  });

  it('a snapshot restore puts back the stamps of an item that was already registered at snapshot time', () => {
    const { Tag, TagLinks, packageName } = pair();
    smrt({ packageName })(Tag);
    const live = ObjectRegistry.getClassByConstructor(Tag);
    expect(live?.internalKind).toBeUndefined();
    const restoreInner = snapshotObjectRegistryState();
    smrt({ packageName })(TagLinks);
    expect(kindOf(Tag)).toBe('junction');
    restoreInner();
    expect(ObjectRegistry.getClassByConstructor(Tag)).toBe(live);
    expect(kindOf(Tag)).toBeUndefined();
    expect(
      ObjectRegistry.getClass(`${packageName}:Tag`)?.internalKind,
    ).toBeUndefined();
  });

  it('after a reset, a junction naming an old constructor never stamps the new class registered under its key', () => {
    const old = pair();
    smrt({ packageName: PKG_A })(old.Tag);
    ObjectRegistry.clear();
    const fresh = pair();
    smrt({ packageName: PKG_A })(fresh.Tag);
    expect(ObjectRegistry.getClass(`${PKG_A}:Tag`)?.constructor).toBe(
      fresh.Tag,
    );
    ObjectRegistry.registerCollection('Tag', asCollection(old.TagLinks));
    expect(kindOf(fresh.Tag)).toBeUndefined();
    expect(
      ObjectRegistry.getClass(`${PKG_A}:Tag`)?.internalKind,
    ).toBeUndefined();
    // Negative control: a junction naming the live constructor stamps it.
    ObjectRegistry.registerCollection('Tag', asCollection(fresh.TagLinks));
    expect(kindOf(fresh.Tag)).toBe('junction');
  });
});

describe('a same-named replacement never takes the junction stamp of the class it displaced', () => {
  it('replacement registered before the collection: the stamp stays with the displaced declaration', () => {
    const Tag = class Tag extends SmrtObject {
      label = '';
    };
    smrt({ packageName: PKG_A })(Tag);
    const Base = Tag;
    const AppTag = class Tag extends Base {
      extra = '';
    };
    smrt({ packageName: PKG_B, replaceParent: true })(AppTag);
    const replacement = ObjectRegistry.getClassByConstructor(AppTag);
    expect(replacement?.qualifiedName).toBe(`${PKG_B}:Tag`);
    // The precondition: the displaced constructor resolves to its replacement.
    expect(ObjectRegistry.getEffectiveClassByConstructor(Tag)).toBe(
      replacement,
    );
    const TagLinks = class TagLinks extends SmrtJunction<
      InstanceType<typeof Tag>
    > {
      static readonly _itemClass = Tag;
      protected leftField = 'ownerId';
      protected rightField = 'tagId';
    };
    ObjectRegistry.registerCollection('Tag', asCollection(TagLinks));
    expect(replacement?.internalKind).toBeUndefined();
    expect(
      ObjectRegistry.getClass(`${PKG_B}:Tag`)?.internalKind,
    ).toBeUndefined();
  });
});

describe('two packages with the same simple name: the junction stamp lands on the constructor’s registration', () => {
  it('stamps the item the collection names by constructor, not the first Tag found by name', () => {
    const a = pair(PKG_A);
    const b = pair(PKG_B);
    smrt({ packageName: PKG_A })(a.Tag);
    smrt({ packageName: PKG_B })(b.Tag);
    smrt({ packageName: PKG_B })(b.TagLinks);
    expect(kindOf(b.Tag)).toBe('junction');
    expect(kindOf(a.Tag)).toBeUndefined();
    expect(
      ObjectRegistry.getClass(`${PKG_A}:Tag`)?.internalKind,
    ).toBeUndefined();
    expect(ObjectRegistry.getClass(`${PKG_B}:Tag`)?.internalKind).toBe(
      'junction',
    );
  });
});
