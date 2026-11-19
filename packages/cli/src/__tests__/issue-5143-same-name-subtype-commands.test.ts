/**
 * #5143: CLI commands for a simple name shared by a class and its same-named
 * subtype (`replaceParent: false`) belong to the parent, whichever registered
 * first; a subtype that declares its own collection gets commands under that
 * collection. Metadata is read by registry key, so the subtype's `cli: false`
 * never suppresses the parent's commands.
 */
import {
  field,
  getTestDatabase,
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type CLICommand, CLIGenerator } from '../cli-generator.js';

function pair(subCollection?: string) {
  class VideoScene extends SmrtObject {}
  class HistrioScene extends VideoScene {}
  return {
    base: () =>
      ObjectRegistry.register(VideoScene, {
        name: 'Scene',
        packageName: '@fixture/c5143-video',
        tableName: 'scenes',
        tableStrategy: 'sti',
        cli: { include: ['list', 'get'] },
      }),
    sub: () =>
      ObjectRegistry.register(HistrioScene, {
        name: 'Scene',
        packageName: '@fixture/c5143-histrio',
        tableName: 'scenes',
        replaceParent: false,
        ...(subCollection
          ? { collection: subCollection, cli: true }
          : { cli: false }),
      }),
  };
}

async function commands(name: string): Promise<string[]> {
  const cli = new CLIGenerator({ prompt: false, colors: false });
  const internal = cli as unknown as {
    getObjectCommandsLazy(objectName: string): Promise<CLICommand[]>;
  };
  return (await internal.getObjectCommandsLazy(name)).map((c) => c.name);
}

afterEach(() => ObjectRegistry.clear());

// Parents register first: a same-named subclass before its parent is refused
// (CONFIG_SAME_NAME_PARENT_UNREGISTERED, see issue-5143-load-order.test.ts).
describe('CLI commands of a same-named subtype', () => {
  it.each([
    'base-first',
  ] as const)('belong to the parent, under the parent limits (%s)', async (order) => {
    ObjectRegistry.clear();
    const fixture = pair();
    if (order === 'base-first') {
      fixture.base();
      fixture.sub();
    } else {
      fixture.sub();
      fixture.base();
    }
    expect(await commands('scene')).toEqual(['scene:list', 'scene:get']);
  });

  it.each([
    'base-first',
  ] as const)('are published under a collection the subtype declares (%s)', async (order) => {
    ObjectRegistry.clear();
    const fixture = pair('histrio_scenes');
    if (order === 'base-first') {
      fixture.base();
      fixture.sub();
    } else {
      fixture.sub();
      fixture.base();
    }
    expect(await commands('scene')).toEqual(['scene:list', 'scene:get']);
    expect(await commands('histrio_scenes')).toEqual(
      expect.arrayContaining(['histrio_scenes:list', 'histrio_scenes:create']),
    );
  });
});

describe('CLI handlers of a same-named subtype with its own collection', () => {
  it.each([
    'base-first',
  ] as const)('create and update write through the subtype, reading its fields by registry key (%s)', async (order) => {
    ObjectRegistry.clear();
    // Both classes carry the shared simple name, as an app's do.
    const VideoScene = class Scene extends SmrtObject {
      title = '';
    };
    const HistrioScene = class Scene extends VideoScene {
      mood = '';
    };
    field({ type: 'text' })(VideoScene.prototype, 'title');
    field({ type: 'text' })(HistrioScene.prototype, 'mood');
    class VideoScenes extends SmrtCollection<InstanceType<typeof VideoScene>> {
      static readonly _itemClass = VideoScene;
    }
    class HistrioScenes extends SmrtCollection<
      InstanceType<typeof HistrioScene>
    > {
      static readonly _itemClass = HistrioScene;
    }
    const base = () => {
      ObjectRegistry.register(VideoScene, {
        name: 'Scene',
        packageName: '@fixture/c5143-video',
        tableName: 'scenes',
        tableStrategy: 'sti',
        cli: true,
      });
      smrt({ packageName: '@fixture/c5143-video' })(VideoScenes);
    };
    const sub = () => {
      ObjectRegistry.register(HistrioScene, {
        name: 'Scene',
        packageName: '@fixture/c5143-histrio',
        tableName: 'scenes',
        replaceParent: false,
        collection: 'histrio_scenes',
        cli: true,
      });
      smrt({ packageName: '@fixture/c5143-histrio' })(HistrioScenes);
    };
    if (order === 'base-first') {
      base();
      sub();
    } else {
      sub();
      base();
    }
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      includeSystemTables: false,
      classes: ['@fixture/c5143-video:Scene', '@fixture/c5143-histrio:Scene'],
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const handler = new CLIGenerator(
        { prompt: false, colors: false },
        { db },
      ).generateHandler();
      await handler(['histrio_scenes:create', '--mood', 'tense', '--quiet']);
      const created = (
        await db.query('SELECT id, title, mood, _meta_type FROM scenes')
      ).rows as Array<Record<string, string>>;
      expect(created).toEqual([
        expect.objectContaining({
          mood: 'tense',
          _meta_type: '@fixture/c5143-histrio:Scene',
        }),
      ]);
      await handler([
        'histrio_scenes:update',
        created[0].id,
        '--mood',
        'calm',
        '--quiet',
      ]);
      expect(
        (await db.query('SELECT mood FROM scenes')).rows as Array<{
          mood: string;
        }>,
      ).toEqual([{ mood: 'calm' }]);
    } finally {
      log.mockRestore();
      await db.close?.();
    }
  });
});

describe('CLI commands of a replacement of a served subtype', () => {
  it.each([
    'base-middle-leaf',
  ] as const)('belong to the base (%s)', async (order) => {
    ObjectRegistry.clear();
    const VideoScene = class Scene extends SmrtObject {};
    const HistrioScene = class Scene extends VideoScene {};
    const AppScene = class Scene extends HistrioScene {};
    const steps = {
      base: () =>
        ObjectRegistry.register(VideoScene, {
          name: 'Scene',
          packageName: '@fixture/c5143-video',
          tableName: 'scenes',
          tableStrategy: 'sti',
          cli: { include: ['list', 'get'] },
        }),
      middle: () =>
        ObjectRegistry.register(HistrioScene, {
          name: 'Scene',
          packageName: '@fixture/c5143-histrio',
          replaceParent: false,
        }),
      leaf: () =>
        ObjectRegistry.register(AppScene, {
          name: 'Scene',
          packageName: '@fixture/c5143-app',
          replaceParent: true,
          cli: true,
        }),
    };
    const sequence =
      order === 'base-middle-leaf'
        ? (['base', 'middle', 'leaf'] as const)
        : (['leaf', 'middle', 'base'] as const);
    for (const step of sequence) steps[step]();
    expect(await commands('scene')).toEqual(['scene:list', 'scene:get']);
  });
});

describe('CLI commands of a replacement of a subtype with its own collection', () => {
  it('keep the subtype named commands next to the base commands', async () => {
    ObjectRegistry.clear();
    const VideoScene = class Scene extends SmrtObject {};
    const HistrioScene = class Scene extends VideoScene {};
    const AppScene = class Scene extends HistrioScene {};
    ObjectRegistry.register(VideoScene, {
      name: 'Scene',
      packageName: '@fixture/c5143-video',
      tableName: 'scenes',
      tableStrategy: 'sti',
      cli: { include: ['list', 'get'] },
    });
    ObjectRegistry.register(HistrioScene, {
      name: 'Scene',
      packageName: '@fixture/c5143-histrio',
      replaceParent: false,
      collection: 'histrio_scenes',
      cli: { include: ['list'] },
    });
    ObjectRegistry.register(AppScene, {
      name: 'Scene',
      packageName: '@fixture/c5143-app',
      replaceParent: true,
    });
    expect(await commands('scene')).toEqual(['scene:list', 'scene:get']);
    expect(await commands('histrio_scenes')).toEqual(['histrio_scenes:list']);
  });
});

describe('a CLI command name two models answer to', () => {
  it('is refused before dispatch instead of running against the other model', async () => {
    ObjectRegistry.clear();
    const VideoScene = class Scene extends SmrtObject {};
    const HistrioScene = class Scene extends VideoScene {};
    // An unrelated model whose simple name is the subtype's collection.
    const Clips = class Clips extends SmrtObject {};
    ObjectRegistry.register(Clips, {
      packageName: '@fixture/c5143-other',
      tableName: 'other_clips',
      cli: true,
    });
    ObjectRegistry.register(VideoScene, {
      name: 'Scene',
      packageName: '@fixture/c5143-video',
      tableName: 'scenes',
      tableStrategy: 'sti',
    });
    ObjectRegistry.register(HistrioScene, {
      name: 'Scene',
      packageName: '@fixture/c5143-histrio',
      replaceParent: false,
      collection: 'Clips',
      cli: true,
    });
    await expect(commands('clips')).rejects.toThrow(
      /Command name 'clips' is claimed by .*@fixture\/c5143-other:Clips.*@fixture\/c5143-histrio:Scene|Command name 'clips' is claimed by .*@fixture\/c5143-histrio:Scene.*@fixture\/c5143-other:Clips/,
    );
  });
});

describe('a CLI command name with one enabled publisher', () => {
  it('is served by that model when an unrelated model of the same name has the CLI disabled', async () => {
    ObjectRegistry.clear();
    const VideoScene = class Scene extends SmrtObject {};
    const HistrioScene = class Scene extends VideoScene {};
    const Clips = class Clips extends SmrtObject {};
    ObjectRegistry.register(Clips, {
      packageName: '@fixture/c5143-other',
      tableName: 'other_clips',
      cli: false,
    });
    ObjectRegistry.register(VideoScene, {
      name: 'Scene',
      packageName: '@fixture/c5143-video',
      tableName: 'scenes',
      tableStrategy: 'sti',
    });
    ObjectRegistry.register(HistrioScene, {
      name: 'Scene',
      packageName: '@fixture/c5143-histrio',
      replaceParent: false,
      collection: 'Clips',
      cli: { include: ['list'] },
    });
    expect(await commands('clips')).toEqual(['clips:list']);
  });
});

describe('a CLI collection cached under a command name', () => {
  it('is rebuilt for the model that owns the name after the owner changes', async () => {
    ObjectRegistry.clear();
    const VideoScene = class Scene extends SmrtObject {
      title = '';
    };
    const HistrioScene = class Scene extends VideoScene {
      mood = '';
    };
    const AppScene = class Scene extends HistrioScene {};
    class HistrioScenes extends SmrtCollection<
      InstanceType<typeof HistrioScene>
    > {
      static readonly _itemClass = HistrioScene;
    }
    class AppScenes extends SmrtCollection<InstanceType<typeof AppScene>> {
      static readonly _itemClass = AppScene;
    }
    ObjectRegistry.register(VideoScene, {
      name: 'Scene',
      packageName: '@fixture/c5143-video',
      tableName: 'scenes',
      tableStrategy: 'sti',
    });
    ObjectRegistry.register(HistrioScene, {
      name: 'Scene',
      packageName: '@fixture/c5143-histrio',
      replaceParent: false,
      collection: 'histrio_scenes',
      cli: true,
    });
    smrt({ packageName: '@fixture/c5143-histrio' })(HistrioScenes);
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      includeSystemTables: false,
      classes: ['@fixture/c5143-video:Scene', '@fixture/c5143-histrio:Scene'],
    });
    try {
      const internal = new CLIGenerator(
        { prompt: false, colors: false },
        { db },
      ) as unknown as {
        getObjectCommandsLazy(name: string): Promise<CLICommand[]>;
        getCollection(name: string): Promise<SmrtCollection<SmrtObject>>;
      };
      await internal.getObjectCommandsLazy('histrio_scenes');
      expect(await internal.getCollection('histrio_scenes')).toBeInstanceOf(
        HistrioScenes,
      );
      ObjectRegistry.register(AppScene, {
        name: 'Scene',
        packageName: '@fixture/c5143-app',
        replaceParent: true,
        collection: 'histrio_scenes',
        cli: true,
      });
      smrt({ packageName: '@fixture/c5143-app' })(AppScenes);
      await internal.getObjectCommandsLazy('histrio_scenes');
      expect(await internal.getCollection('histrio_scenes')).toBeInstanceOf(
        AppScenes,
      );
    } finally {
      await db.close?.();
    }
  });
});

describe('a generated command that outlives a registry change', () => {
  function pairOfOwners() {
    ObjectRegistry.clear();
    class Alpha extends SmrtObject {
      title = '';
    }
    class Beta extends SmrtObject {
      title = '';
      secret = '';
    }
    field({ type: 'text' })(Alpha.prototype, 'title');
    field({ type: 'text' })(Beta.prototype, 'title');
    field({ type: 'text' })(Beta.prototype, 'secret');
    ObjectRegistry.register(Alpha, {
      name: 'Alpha',
      packageName: '@fixture/c5143-owner-a',
      cli: true,
      api: { writable: ['title'] },
    });
    ObjectRegistry.register(Beta, {
      name: 'Beta',
      packageName: '@fixture/c5143-owner-b',
      cli: true,
    });
    return {
      keyA: '@fixture/c5143-owner-a:Alpha',
      keyB: '@fixture/c5143-owner-b:Beta',
    };
  }

  it('checks an update against the owner whose row it read, even if the name changes owner while it waits', async () => {
    const { keyA, keyB } = pairOfOwners();
    const generator = new CLIGenerator({ prompt: false, colors: false }, {});
    const internal = generator as unknown as {
      commandRegistryKeys: Map<string, string>;
      getCollection(name: string, key?: string): Promise<unknown>;
      handleUpdate(
        name: string,
        id: string,
        options: Record<string, unknown>,
      ): Promise<void>;
    };
    internal.commandRegistryKeys.set('widget', keyA);
    const written: Array<Record<string, unknown>> = [];
    internal.getCollection = async () => ({
      get: async () => {
        await Promise.resolve();
        // Another model comes to own the command name mid-flight.
        internal.commandRegistryKeys.set('widget', keyB);
        return { id: '1' };
      },
      withAuditMutation: async (
        existing: object,
        _kind: string,
        run: (bound: Record<string, unknown>) => Promise<void>,
      ) => {
        const bound = { ...existing, save: async () => {} } as Record<
          string,
          unknown
        >;
        await run(bound);
        written.push(bound);
      },
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await internal.handleUpdate('widget', '1', {
        title: 'kept',
        secret: 'dropped',
        quiet: true,
      });
    } finally {
      log.mockRestore();
    }
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ title: 'kept' });
    expect(written[0]).not.toHaveProperty('secret');
  });

  it('refuses a cached collection once its model no longer binds a collection class', async () => {
    ObjectRegistry.clear();
    class Gadget extends SmrtObject {}
    class Gadgets extends SmrtCollection<InstanceType<typeof Gadget>> {
      static readonly _itemClass = Gadget;
    }
    const bind = (withCollection: boolean) => {
      ObjectRegistry.register(Gadget, {
        name: 'Gadget',
        packageName: '@fixture/c5143-gadget',
        cli: true,
      });
      if (withCollection)
        smrt({ packageName: '@fixture/c5143-gadget' })(Gadgets);
    };
    bind(true);
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      includeSystemTables: false,
      classes: ['@fixture/c5143-gadget:Gadget'],
    });
    try {
      const internal = new CLIGenerator(
        { prompt: false, colors: false },
        { db },
      ) as unknown as {
        getObjectCommandsLazy(name: string): Promise<CLICommand[]>;
        getCollection(name: string): Promise<SmrtCollection<SmrtObject>>;
      };
      await internal.getObjectCommandsLazy('gadget');
      expect(await internal.getCollection('gadget')).toBeInstanceOf(Gadgets);
      ObjectRegistry.clear();
      bind(false);
      await expect(internal.getCollection('gadget')).rejects.toThrow(
        /no collection constructor/,
      );
    } finally {
      await db.close?.();
    }
  });
});
