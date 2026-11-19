/**
 * #5143: a same-named subclass registers after the class it extends. Before
 * it, nothing tells the registration what to inherit, so that order fails
 * closed (`CONFIG_SAME_NAME_PARENT_UNREGISTERED`) in every shape an
 * application has: a decorator, a collection class, a generated field, a
 * class declared in another package, a parent known only from its manifest.
 * After the parent, the registration derives tenancy, table, collection and
 * aliases from it.
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
const PARENT_UNREGISTERED = expect.objectContaining({
  code: 'CONFIG_SAME_NAME_PARENT_UNREGISTERED',
});

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

const parentOptions = (tableName?: string) =>
  ({
    packageName: VIDEO,
    tableStrategy: 'sti',
    tenantScoped: { mode: 'required' },
    ...(tableName ? { tableName } : {}),
  }) as const;

describe('a same-named subclass registered before its parent fails closed', () => {
  it('as a decorated replacement with its collection class: the class is refused and never registered', () => {
    const { HistrioScene } = classes();
    expect(() =>
      smrt({ packageName: HISTRIO, replaceParent: true })(HistrioScene),
    ).toThrow(PARENT_UNREGISTERED);
    expect(ObjectRegistry.getClassByConstructor(HistrioScene)).toBeUndefined();
    expect([...ObjectRegistry.getAllClasses().keys()]).toEqual([]);
  });

  it('as a decorated subtype that declares no table', () => {
    const { HistrioScene } = classes();
    expect(() =>
      smrt({ packageName: HISTRIO, replaceParent: false })(HistrioScene),
    ).toThrow(PARENT_UNREGISTERED);
    expect([...ObjectRegistry.getAllClasses().keys()]).toEqual([]);
  });

  it('as a constructor whose parent so far has only a manifest declaration', () => {
    const { HistrioScene } = classes();
    ObjectRegistry.registerFromManifest(BASE, {
      name: 'scene',
      className: 'Scene',
      qualifiedName: BASE,
      packageName: VIDEO,
      collection: 'scenes',
      filePath: 'src/scene.ts',
      fields: { title: { type: 'text', _meta: {} } },
      methods: {},
      decoratorConfig: { tableName: 'video_scenes', tableStrategy: 'sti' },
    });
    // No manifest of its own names the parent, so nothing links the two.
    expect(() =>
      ObjectRegistry.register(HistrioScene, {
        name: 'Scene',
        packageName: HISTRIO,
        replaceParent: true,
      }),
    ).toThrow(PARENT_UNREGISTERED);
    expect([...ObjectRegistry.getAllClasses().keys()]).toEqual([BASE]);
  });

  it('as a replacement with a generated field', () => {
    const VideoScene = class Scene extends SmrtObject {};
    const HistrioScene = class Scene extends VideoScene {
      qty = 0;
      price = 0;
      total = 0;
    };
    field({ type: 'integer' })(HistrioScene.prototype, 'qty');
    field({ type: 'integer' })(HistrioScene.prototype, 'price');
    field({
      type: 'integer',
      generated: { op: 'mul', left: { col: 'qty' }, right: { col: 'price' } },
    })(HistrioScene.prototype, 'total');
    expect(() =>
      ObjectRegistry.register(HistrioScene, {
        name: 'Scene',
        packageName: HISTRIO,
        replaceParent: true,
      }),
    ).toThrow(PARENT_UNREGISTERED);
    expect([...ObjectRegistry.getGeneratedClasses().keys()]).not.toContain(SUB);
    ObjectRegistry.register(VideoScene, {
      name: 'Scene',
      packageName: VIDEO,
      tableName: 'scenes',
    });
    ObjectRegistry.register(HistrioScene, {
      name: 'Scene',
      packageName: HISTRIO,
      replaceParent: true,
    });
    expect([...ObjectRegistry.getGeneratedClasses().keys()]).toContain(SUB);
  });

  it('as a replacement declared in another package', async () => {
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
      const VideoScene = class Scene extends SmrtObject {};
      const module = (await import(
        /* @vite-ignore */ pathToFileURL(file).href
      )) as {
        define(args: { smrt: typeof smrt; Parent: typeof VideoScene }): unknown;
      };
      await expect(async () =>
        module.define({ smrt, Parent: VideoScene }),
      ).rejects.toThrow(PARENT_UNREGISTERED);
      ObjectRegistry.register(VideoScene, {
        name: 'Scene',
        packageName: VIDEO,
        tableName: 'scenes',
      });
      const HistrioScene = module.define({ smrt, Parent: VideoScene });
      // Registered after its parent, from its own package.
      expect(ObjectRegistry.getClass(BASE)?.qualifiedName).toBe(SUB);
      expect(ObjectRegistry.getClass(SUB)?.constructor).toBe(HistrioScene);
    } finally {
      ws.dispose();
    }
  });
});

describe('a replacement with its own collection class, after its parent', () => {
  it.each([
    ['default parent table', undefined],
    ['custom parent table', 'video_scenes'],
  ] as const)('takes the parent tenancy and table and keeps its collection class (%s)', (_label, parentTable) => {
    const { VideoScene, HistrioScene } = classes();
    class Scenes extends SmrtCollection<InstanceType<typeof HistrioScene>> {
      static readonly _itemClass = HistrioScene;
    }
    smrt(parentOptions(parentTable))(VideoScene);
    smrt({ packageName: HISTRIO, replaceParent: true })(HistrioScene);
    smrt({ packageName: HISTRIO })(Scenes);
    expect({
      keys: [...ObjectRegistry.getAllClasses().keys()].sort(),
      replaced: ObjectRegistry.getClass(BASE)?.qualifiedName === SUB,
      tenant: ObjectRegistry.getTenantScopedConfig(BASE)?.mode,
      collection: ObjectRegistry.getClass(BASE)?.collectionConstructor,
    }).toEqual({
      keys: [SUB],
      replaced: true,
      tenant: 'required',
      collection: Scenes,
    });
    if (parentTable)
      expect(ObjectRegistry.getTableName(BASE)).toBe(parentTable);
  });
});

describe('a same-named subtype after its custom-table STI parent', () => {
  it('stores rows in the parent table when it declares none, and is served through the parent', () => {
    const { VideoScene, HistrioScene } = classes();
    smrt({
      packageName: VIDEO,
      tableName: 'video_scenes',
      tableStrategy: 'sti',
    })(VideoScene);
    smrt({ packageName: HISTRIO, replaceParent: false })(HistrioScene);
    expect(ObjectRegistry.getTableName(SUB)).toBe('video_scenes');
    expect(ObjectRegistry.isServedByParent(SUB)).toBe(true);
    expect(ObjectRegistry.getClass(BASE)?.constructor).toBe(VideoScene);
  });

  it('is refused when it names another table', () => {
    const { VideoScene, HistrioScene } = classes();
    ObjectRegistry.register(VideoScene, {
      name: 'Scene',
      packageName: VIDEO,
      tableName: 'video_scenes',
      tableStrategy: 'sti',
    });
    expect(() =>
      ObjectRegistry.register(HistrioScene, {
        name: 'Scene',
        packageName: HISTRIO,
        tableName: 'histrio_scenes',
        replaceParent: false,
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'CONFIG_SAME_NAME_SUBTYPE_TABLE_MISMATCH',
      }),
    );
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

describe('exposure a collection applies to its replacement item', () => {
  it('stays applied when the parent registers again', async () => {
    const { MCPGenerator } = await import('../../generators/mcp');
    const { VideoScene, HistrioScene } = classes();
    class Scenes extends SmrtCollection<InstanceType<typeof HistrioScene>> {
      static readonly _itemClass = HistrioScene;
    }
    const parent = () =>
      smrt({ packageName: VIDEO, tableName: 'scenes', mcp: true })(VideoScene);
    parent();
    smrt({ packageName: HISTRIO, replaceParent: true })(HistrioScene);
    smrt({ packageName: HISTRIO, mcp: false })(Scenes);
    const tools = async () =>
      (
        await new MCPGenerator(
          {},
          { user: { id: 'u' } },
        ).generateToolDefinitions()
      )
        .map((tool) => tool.name)
        .filter((name) => name.startsWith('scene_'));
    expect(await tools()).toEqual([]);
    parent();
    expect(await tools()).toEqual([]);
  });
});

describe('a manifest subtype that names no table', () => {
  const parentEntry = () => ({
    name: 'scene',
    className: 'Scene',
    qualifiedName: BASE as `${string}:${string}`,
    packageName: VIDEO,
    collection: 'scenes',
    filePath: 'src/video/scene.ts',
    fields: { title: { type: 'text' as const, _meta: {} } },
    methods: {},
    decoratorConfig: {
      tableName: 'video_scenes',
      tableStrategy: 'sti' as const,
    },
  });
  const subtypeEntry = (tableName?: string) => ({
    name: 'scene',
    className: 'Scene',
    qualifiedName: SUB as `${string}:${string}`,
    packageName: HISTRIO,
    collection: 'scenes',
    filePath: 'src/histrio/scene.ts',
    extends: 'Scene',
    extendsQualified: BASE,
    fields: { mood: { type: 'text' as const, _meta: {} } },
    methods: {},
    decoratorConfig: {
      replaceParent: false,
      ...(tableName ? { tableName } : {}),
    },
  });
  it.each([
    'parent-first',
    'subtype-first',
  ] as const)('stores rows in its custom-table STI parent (%s)', (order) => {
    const parent = () =>
      ObjectRegistry.registerFromManifest(BASE, parentEntry());
    const subtype = () =>
      ObjectRegistry.registerFromManifest(SUB, subtypeEntry());
    if (order === 'parent-first') {
      parent();
      subtype();
    } else {
      subtype();
      parent();
    }
    expect(ObjectRegistry.getClass(SUB)?.schema?.tableName).toBe(
      'video_scenes',
    );
    expect(ObjectRegistry.getTableName(SUB)).toBe('video_scenes');
    expect(ObjectRegistry.isServedByParent(SUB)).toBe(true);
  });
  it.each([
    'parent-first',
    'subtype-first',
  ] as const)('is still refused when it names another table (%s)', (order) => {
    const parent = () =>
      ObjectRegistry.registerFromManifest(BASE, parentEntry());
    const subtype = () =>
      ObjectRegistry.registerFromManifest(SUB, subtypeEntry('histrio_scenes'));
    const steps =
      order === 'parent-first' ? [parent, subtype] : [subtype, parent];
    steps[0]();
    expect(() => steps[1]()).toThrow(
      expect.objectContaining({
        code: 'CONFIG_SAME_NAME_SUBTYPE_TABLE_MISMATCH',
      }),
    );
  });
});
