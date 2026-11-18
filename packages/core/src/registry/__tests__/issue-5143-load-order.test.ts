/**
 * #5143 round 2: a same-named subclass reaches the registration the
 * parent-first order gives, whichever of the two loads first, in the shapes
 * an application actually has (a collection class, a decorator with no
 * table, a constructor named after its parent, a generated field, a class
 * declared in another package, a three-level chain loaded in one pass).
 */
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../../collection';
import { field } from '../../decorators';
import { SmrtObject } from '../../object';
import { ObjectRegistry, smrt } from '../../registry';
import { snapshotObjectRegistryState } from '../../test-utils';
import { createConsumerWorkspace } from './helpers/consumer-workspace';

const VIDEO = '@fixture/lo5143-video';
const HISTRIO = '@fixture/lo5143-histrio';
const BASE = `${VIDEO}:Scene`;
const SUB = `${HISTRIO}:Scene`;

let restore: () => void;
beforeEach(() => {
  restore = snapshotObjectRegistryState();
  ObjectRegistry.clear();
});
afterEach(() => restore());

/** Both classes carry the shared simple name, as an application's do. */
function classes() {
  const VideoScene = class Scene extends SmrtObject {
    tenantId = '';
    title = '';
  };
  const HistrioScene = class Scene extends VideoScene {
    mood = '';
  };
  return { VideoScene, HistrioScene };
}

function effective() {
  const entry = ObjectRegistry.getClass(BASE);
  return {
    keys: [...ObjectRegistry.getAllClasses().keys()].sort(),
    ctorIsReplacement: entry?.qualifiedName === SUB,
    tenant: ObjectRegistry.getTenantScopedConfig(BASE)?.mode,
    table: ObjectRegistry.getTableName(BASE),
  };
}

describe('replacement with its own collection class, parent last', () => {
  it.each([
    ['default parent table', undefined],
    ['custom parent table', 'video_scenes'],
  ] as const)('matches the parent-first registration (%s)', (_label, parentTable) => {
    const results = (['parent-first', 'parent-last'] as const).map((order) => {
      ObjectRegistry.clear();
      const { VideoScene, HistrioScene } = classes();
      class Scenes extends SmrtCollection<InstanceType<typeof HistrioScene>> {
        static readonly _itemClass = HistrioScene;
      }
      const parent = () =>
        smrt({
          packageName: VIDEO,
          tableStrategy: 'sti',
          tenantScoped: { mode: 'required' },
          ...(parentTable ? { tableName: parentTable } : {}),
        })(VideoScene);
      const child = () => {
        smrt({ packageName: HISTRIO, replaceParent: true })(HistrioScene);
        // A partial update of the same constructor keeps its declaration.
        ObjectRegistry.register(HistrioScene, {
          name: 'Scene',
          packageName: HISTRIO,
        });
        smrt({ packageName: HISTRIO })(Scenes);
      };
      if (order === 'parent-first') {
        parent();
        child();
      } else {
        child();
        parent();
      }
      return {
        ...effective(),
        collection:
          ObjectRegistry.getClass(BASE)?.collectionConstructor === Scenes,
      };
    });
    expect(results[1]).toEqual(results[0]);
    expect(results[0]).toMatchObject({
      keys: [SUB],
      ctorIsReplacement: true,
      tenant: 'required',
      collection: true,
      ...(parentTable ? { table: parentTable } : {}),
    });
  });
});

describe('same-named subtype that declares no table', () => {
  it.each([
    'parent-first',
    'parent-last',
  ] as const)('stores rows in its custom-table STI parent and is served through it (%s)', (order) => {
    const { VideoScene, HistrioScene } = classes();
    const parent = () =>
      smrt({
        packageName: VIDEO,
        tableName: 'video_scenes',
        tableStrategy: 'sti',
      })(VideoScene);
    const child = () =>
      smrt({ packageName: HISTRIO, replaceParent: false })(HistrioScene);
    if (order === 'parent-first') {
      parent();
      child();
    } else {
      child();
      parent();
    }
    expect(ObjectRegistry.getTableName(SUB)).toBe('video_scenes');
    expect(ObjectRegistry.getTableName(BASE)).toBe('video_scenes');
    expect(ObjectRegistry.isServedByParent(SUB)).toBe(true);
    expect(ObjectRegistry.getClass(BASE)?.constructor).toBe(VideoScene);
  });

  it('refuses a subtype that names another table than its STI parent, in either order', () => {
    for (const order of ['parent-first', 'parent-last'] as const) {
      ObjectRegistry.clear();
      const { VideoScene, HistrioScene } = classes();
      const parent = () =>
        ObjectRegistry.register(VideoScene, {
          name: 'Scene',
          packageName: VIDEO,
          tableName: 'video_scenes',
          tableStrategy: 'sti',
        });
      const child = () =>
        ObjectRegistry.register(HistrioScene, {
          name: 'Scene',
          packageName: HISTRIO,
          tableName: 'histrio_scenes',
          replaceParent: false,
        });
      const steps =
        order === 'parent-first' ? [parent, child] : [child, parent];
      steps[0]();
      expect(() => steps[1]()).toThrow(
        expect.objectContaining({
          code: 'CONFIG_SAME_NAME_SUBTYPE_TABLE_MISMATCH',
        }),
      );
    }
  });
});

describe('replacement constructor, then its parent manifest, then the parent constructor', () => {
  it('inherits the tenancy the provider manifest declares', () => {
    const { VideoScene, HistrioScene } = classes();
    // No manifest for the child: its parent is recorded by simple name.
    ObjectRegistry.register(HistrioScene, {
      name: 'Scene',
      packageName: HISTRIO,
      replaceParent: true,
    });
    ObjectRegistry.registerFromManifest(BASE, {
      name: 'scene',
      className: 'Scene',
      qualifiedName: BASE,
      packageName: VIDEO,
      collection: 'scenes',
      filePath: 'src/scene.ts',
      fields: {
        tenantId: { type: 'text', _meta: {} },
        title: { type: 'text', _meta: {} },
      },
      methods: {},
      decoratorConfig: {
        tableName: 'video_scenes',
        tableStrategy: 'sti',
        tenantScoped: { mode: 'required' },
      },
    });
    ObjectRegistry.register(VideoScene, {
      name: 'Scene',
      packageName: VIDEO,
      tableName: 'video_scenes',
      tableStrategy: 'sti',
      tenantScoped: { mode: 'required' },
    });
    expect(effective()).toMatchObject({
      keys: [SUB],
      ctorIsReplacement: true,
      tenant: 'required',
      table: 'video_scenes',
    });
    expect(ObjectRegistry.getClass(BASE)?.constructor).toBe(HistrioScene);
  });
});

describe('replacement with a generated field', () => {
  it.each([
    'parent-first',
    'parent-last',
  ] as const)('stays tracked as a generated class (%s)', (order) => {
    const VideoScene = class Scene extends SmrtObject {
      title = '';
    };
    const HistrioScene = class Scene extends VideoScene {
      qty = 0;
      price = 0;
      total = 0;
    };
    field({ type: 'text' })(VideoScene.prototype, 'title');
    field({ type: 'integer' })(HistrioScene.prototype, 'qty');
    field({ type: 'integer' })(HistrioScene.prototype, 'price');
    field({
      type: 'integer',
      generated: { op: 'mul', left: { col: 'qty' }, right: { col: 'price' } },
    })(HistrioScene.prototype, 'total');
    const parent = () =>
      ObjectRegistry.register(VideoScene, {
        name: 'Scene',
        packageName: VIDEO,
        tableName: 'scenes',
      });
    const child = () =>
      ObjectRegistry.register(HistrioScene, {
        name: 'Scene',
        packageName: HISTRIO,
        replaceParent: true,
      });
    if (order === 'parent-first') {
      parent();
      child();
    } else {
      child();
      parent();
    }
    expect([...ObjectRegistry.getGeneratedClasses().keys()]).toContain(SUB);
  });
});

describe('replacement declared in another package, registered first', () => {
  it('keeps its own package when its parent registers', async () => {
    const ws = createConsumerWorkspace('smrt-5143-pkg');
    try {
      ws.writePackage('packages/histrio', HISTRIO);
      const file = ws.write(
        'packages/histrio/src/scene.js',
        [
          'export function define({ smrt, Parent }) {',
          '  const Scene = class Scene extends Parent {};',
          '  smrt({ replaceParent: true })(Scene);',
          '  return Scene;',
          '}',
          '',
        ].join('\n'),
      );
      const VideoScene = class Scene extends SmrtObject {
        title = '';
      };
      const module = (await import(
        /* @vite-ignore */ pathToFileURL(file).href
      )) as {
        define(args: { smrt: typeof smrt; Parent: typeof VideoScene }): unknown;
      };
      const HistrioScene = module.define({ smrt, Parent: VideoScene });
      expect(
        ObjectRegistry.getClassByConstructor(HistrioScene as typeof SmrtObject)
          ?.qualifiedName,
      ).toBe(SUB);
      ObjectRegistry.register(VideoScene, {
        name: 'Scene',
        packageName: VIDEO,
        tableName: 'scenes',
      });
      expect(ObjectRegistry.getClass(BASE)?.qualifiedName).toBe(SUB);
      expect(ObjectRegistry.getClass(SUB)?.constructor).toBe(HistrioScene);
    } finally {
      ws.dispose();
    }
  });
});

describe('a retained alias', () => {
  it('cannot be claimed by an unrelated model, in either order', () => {
    const OLD = '@fixture/lo5143-old:Scene';
    for (const order of ['claimant-first', 'claimant-last'] as const) {
      ObjectRegistry.clear();
      const { VideoScene, HistrioScene } = classes();
      class Clip extends SmrtObject {}
      const claimant = () =>
        ObjectRegistry.register(Clip, {
          packageName: '@fixture/lo5143-other',
          tableName: 'clips',
          previousQualifiedNames: [OLD],
        });
      const pair = () => {
        ObjectRegistry.register(VideoScene, {
          name: 'Scene',
          packageName: VIDEO,
          tableName: 'scenes',
          previousQualifiedNames: [OLD],
        });
        ObjectRegistry.register(HistrioScene, {
          name: 'Scene',
          packageName: HISTRIO,
          replaceParent: true,
        });
      };
      if (order === 'claimant-first') {
        claimant();
        expect(pair).toThrow(
          expect.objectContaining({
            code: 'CONFIG_QUALIFIED_NAME_ALIAS_COLLISION',
          }),
        );
        expect(ObjectRegistry.getClassByQualifiedName(OLD)?.qualifiedName).toBe(
          '@fixture/lo5143-other:Clip',
        );
      } else {
        pair();
        expect(claimant).toThrow(
          expect.objectContaining({
            code: 'CONFIG_QUALIFIED_NAME_ALIAS_COLLISION',
          }),
        );
        expect(ObjectRegistry.getClassByQualifiedName(OLD)?.qualifiedName).toBe(
          SUB,
        );
      }
    }
  });
});

describe('three same-named levels in one pass', () => {
  const APP = '@fixture/lo5143-app:Scene';
  function chain() {
    const VideoScene = class Scene extends SmrtObject {};
    const HistrioScene = class Scene extends VideoScene {};
    const AppScene = class Scene extends HistrioScene {};
    return {
      VideoScene,
      HistrioScene,
      AppScene,
      steps: {
        base: () =>
          ObjectRegistry.register(VideoScene, {
            name: 'Scene',
            packageName: VIDEO,
            tableName: 'scenes',
            tableStrategy: 'sti',
          }),
        middle: () =>
          ObjectRegistry.register(HistrioScene, {
            name: 'Scene',
            packageName: HISTRIO,
            replaceParent: false,
          }),
        leaf: () =>
          ObjectRegistry.register(AppScene, {
            name: 'Scene',
            packageName: '@fixture/lo5143-app',
            replaceParent: true,
          }),
      },
    };
  }
  it.each([
    ['base', 'middle', 'leaf'],
    ['base', 'leaf', 'middle'],
    ['middle', 'base', 'leaf'],
    ['middle', 'leaf', 'base'],
    ['leaf', 'base', 'middle'],
    ['leaf', 'middle', 'base'],
  ] as const)('converges with one registration per class (%s → %s → %s)', (...order) => {
    const fixture = chain();
    for (const step of order) fixture.steps[step]();
    expect({
      keys: [...ObjectRegistry.getAllClasses().keys()].sort(),
      base: ObjectRegistry.getClass(BASE)?.constructor,
      leafReplaced: ObjectRegistry.getClass(APP)?.replacedQualifiedNames,
    }).toEqual({
      keys: [APP, BASE].sort(),
      base: fixture.VideoScene,
      leafReplaced: [SUB],
    });
    expect(() => ObjectRegistry.getAllSchemasAsDefinitions()).not.toThrow();
  });

  it('still reports a genuinely missing intermediate', () => {
    const fixture = chain();
    fixture.steps.base();
    fixture.steps.leaf();
    expect(ObjectRegistry.getClass(APP)).toBeUndefined();
    expect(() => ObjectRegistry.getAllSchemasAsDefinitions()).toThrow(
      expect.objectContaining({ code: 'CONFIG_STI_UNREGISTERED_PARENT' }),
    );
  });
});
