/**
 * #5143: `registerCollection()` under a qualified key is an explicit binding.
 * Generated activation binds a manifest-backed collection declaration's
 * executable class under the declaration's own key, whose entry is a stub;
 * that binding is the receiver its static actions run on.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../../collection';
import { field } from '../../decorators';
import { SmrtObject } from '../../object';
import { ObjectRegistry, smrt } from '../../registry';
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

describe('a collection decorator declaring replaceParent: false', () => {
  it('is refused, leaving the item and the bound receiver as they were', () => {
    class Clip extends SmrtObject {}
    smrt({ packageName: PKG, tableName: 'clips' })(Clip);
    class Clips extends SmrtCollection<Clip> {
      static readonly _itemClass = Clip;
      static receiver() {
        return 'provider';
      }
    }
    smrt({ packageName: PKG })(Clips);
    const before = {
      keys: [...ObjectRegistry.getAllClasses().keys()],
      item: ObjectRegistry.getClass(ITEM)?.config,
      bound: ObjectRegistry.getClass(ITEM)?.collectionConstructor,
    };
    expect(before.bound).toBe(Clips);

    class RefusedClips extends Clips {
      static override receiver() {
        return 'refused';
      }
    }
    expect(() =>
      smrt({ packageName: PKG, replaceParent: false })(RefusedClips),
    ).toThrow(
      expect.objectContaining({
        code: 'CONFIG_SAME_NAME_COEXISTENCE_UNSUPPORTED',
      }),
    );
    expect({
      keys: [...ObjectRegistry.getAllClasses().keys()],
      item: ObjectRegistry.getClass(ITEM)?.config,
      bound: ObjectRegistry.getClass(ITEM)?.collectionConstructor,
    }).toEqual(before);
    expect(
      (
        ObjectRegistry.getClass(ITEM)?.collectionConstructor as
          | { receiver?: () => string }
          | undefined
      )?.receiver?.(),
    ).toBe('provider');
  });

  it('publishes no field metadata before it is refused', () => {
    class Clip extends SmrtObject {}
    smrt({ packageName: PKG, tableName: 'clips' })(Clip);
    class Clips extends SmrtCollection<Clip> {
      static readonly _itemClass = Clip;
    }
    smrt({ packageName: PKG })(Clips);
    const fieldsOf = (name: string) => [
      ...ObjectRegistry.getFieldDecorators(name).keys(),
    ];
    const before = fieldsOf('Clips');

    class RefusedClips extends Clips {
      static readonly _itemClass = Clip;
    }
    // A standard-decorator field is queued on the class's metadata and
    // published when the class decorator runs.
    const metadata: Record<PropertyKey, unknown> = {};
    field({ type: 'text' })(undefined, {
      kind: 'field',
      name: 'note',
      static: false,
      private: false,
      access: { has: () => true, get: () => undefined, set: () => {} },
      addInitializer: () => {},
      metadata,
    } as ClassFieldDecoratorContext);
    expect(() =>
      smrt({ packageName: PKG, name: 'Clips', replaceParent: false })(
        RefusedClips,
        {
          kind: 'class',
          name: 'RefusedClips',
          addInitializer: () => {},
          metadata,
        } as ClassDecoratorContext<typeof RefusedClips>,
      ),
    ).toThrow(
      expect.objectContaining({
        code: 'CONFIG_SAME_NAME_COEXISTENCE_UNSUPPORTED',
      }),
    );
    expect(fieldsOf('Clips')).toEqual(before);
    expect(fieldsOf('RefusedClips')).toEqual([]);
  });
});
