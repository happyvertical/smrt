/**
 * #5143: `registerCollection()` under a qualified key is an explicit binding.
 * Generated activation binds a manifest-backed collection declaration's
 * executable class under the declaration's own key, whose entry is a stub;
 * that binding is the receiver its static actions run on.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../../collection';
import { SmrtObject } from '../../object';
import { ObjectRegistry } from '../../registry';
import { snapshotObjectRegistryState } from '../../test-utils';

const PKG = '@fixture/cb5143';
const ITEM = `${PKG}:Clip`;
const COLLECTION = `${PKG}:ClipCollection`;

let restore: () => void;
beforeEach(() => {
  restore = snapshotObjectRegistryState();
  ObjectRegistry.clear();
});
afterEach(() => restore());

describe('a qualified collection binding', () => {
  it('sets the receiver of a manifest-backed collection declaration', () => {
    ObjectRegistry.registerFromManifest(ITEM, {
      name: 'clip',
      className: 'Clip',
      qualifiedName: ITEM,
      packageName: PKG,
      collection: 'clips',
      filePath: 'src/clip.ts',
      fields: { title: { type: 'text', _meta: {} } },
      methods: {},
      decoratorConfig: { tableName: 'clips' },
    });
    ObjectRegistry.registerFromManifest(COLLECTION, {
      name: 'clipcollection',
      className: 'ClipCollection',
      qualifiedName: COLLECTION,
      packageName: PKG,
      collection: 'clips',
      collectionOf: ITEM,
      filePath: 'src/clip.ts',
      fields: {},
      methods: {},
      decoratorConfig: { tableName: 'clips' },
    });
    // The executable classes as a package exports them.
    class Clip extends SmrtObject {}
    class ClipCollection extends SmrtCollection<Clip> {
      static readonly _itemClass = Clip;
      static archiveAll() {
        return 'archived';
      }
    }
    ObjectRegistry.registerCollection(
      COLLECTION,
      ClipCollection as unknown as Parameters<
        typeof ObjectRegistry.registerCollection
      >[1],
    );
    const receiver = ObjectRegistry.getClass(COLLECTION)
      ?.collectionConstructor as { archiveAll?: () => string } | undefined;
    expect(receiver).toBe(ClipCollection);
    expect(receiver?.archiveAll?.()).toBe('archived');
  });
});
