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
