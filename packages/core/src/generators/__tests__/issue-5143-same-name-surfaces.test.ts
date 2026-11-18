/**
 * #5143: a same-named subtype (`replaceParent: false`) is served through its
 * parent's run-time MCP tools and OpenAPI paths unless it declares its own
 * collection, whichever of the two registered first. The parent's metadata
 * (its `api`/`mcp` limits, its fields) is read by its registry key, never by
 * the simple name the two share.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { field } from '../../decorators';
import { SmrtObject } from '../../object';
import { ObjectRegistry } from '../../registry';
import { snapshotObjectRegistryState } from '../../test-utils';
import { MCPGenerator } from '../mcp';
import { generateOpenAPISpec } from '../swagger';

const BASE = '@fixture/s5143-video:Scene';
const SUB = '@fixture/s5143-histrio:Scene';

function pair(subCollection?: string) {
  class VideoScene extends SmrtObject {
    title = '';
  }
  class HistrioScene extends VideoScene {
    mood = '';
  }
  field({ type: 'text' })(VideoScene.prototype, 'title');
  field({ type: 'text' })(HistrioScene.prototype, 'mood');
  return {
    base: () =>
      ObjectRegistry.register(VideoScene, {
        name: 'Scene',
        packageName: '@fixture/s5143-video',
        tableName: 'scenes',
        tableStrategy: 'sti',
        api: { include: ['list', 'get'] },
        mcp: { include: ['list', 'get'] },
      }),
    sub: () =>
      ObjectRegistry.register(HistrioScene, {
        name: 'Scene',
        packageName: '@fixture/s5143-histrio',
        tableName: 'scenes',
        replaceParent: false,
        api: true,
        mcp: true,
        ...(subCollection ? { collection: subCollection } : {}),
      }),
  };
}

type Spec = {
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, { properties: object }> };
};

async function surfaces() {
  const tools = await new MCPGenerator(
    {},
    { user: { id: 'u' } },
  ).generateToolDefinitions();
  const spec = generateOpenAPISpec({ basePath: '/api' }) as unknown as Spec;
  return {
    tools: tools.map((tool) => tool.name).sort(),
    paths: Object.fromEntries(
      Object.entries(spec.paths).map(([path, item]) => [
        path,
        Object.keys(item).sort(),
      ]),
    ),
    sceneFields: Object.keys(spec.components.schemas.Scene?.properties ?? {}),
  };
}

let restore: () => void;
beforeEach(() => {
  restore = snapshotObjectRegistryState();
  ObjectRegistry.clear();
});
afterEach(() => restore());

describe('run-time MCP and OpenAPI surfaces of a same-named subtype', () => {
  it.each([
    'base-first',
    'sub-first',
  ] as const)('serve the subtype through the parent, under the parent limits (%s)', async (order) => {
    const fixture = pair();
    if (order === 'base-first') {
      fixture.base();
      fixture.sub();
    } else {
      fixture.sub();
      fixture.base();
    }
    expect(ObjectRegistry.isServedByParent(SUB)).toBe(true);
    expect(ObjectRegistry.isServedByParent(BASE)).toBe(false);
    const result = await surfaces();
    expect(result.tools).toEqual(['scene_get', 'scene_list']);
    expect(result.paths).toEqual({
      '/api/scenes': ['get'],
      '/api/scenes/{id}': ['get'],
    });
    // The parent's own fields, not the subtype's.
    expect(result.sceneFields).toContain('title');
    expect(result.sceneFields).not.toContain('mood');
  });

  it.each([
    'base-first',
    'sub-first',
  ] as const)('give a subtype that declares its own collection a surface under that collection (%s)', async (order) => {
    const fixture = pair('histrio_scenes');
    if (order === 'base-first') {
      fixture.base();
      fixture.sub();
    } else {
      fixture.sub();
      fixture.base();
    }
    expect(ObjectRegistry.getSurfaceName(SUB)).toBe('histrio_scenes');
    expect(ObjectRegistry.getSurfaceName(BASE)).toBe('Scene');
    const result = await surfaces();
    expect(result.tools).toEqual(
      expect.arrayContaining([
        'scene_get',
        'scene_list',
        'histrio_scenes_create',
        'histrio_scenes_list',
      ]),
    );
    expect(result.tools.filter((name) => name.startsWith('scene_'))).toEqual([
      'scene_get',
      'scene_list',
    ]);
    expect(result.paths['/api/scenes']).toEqual(['get']);
    expect(result.paths['/api/histrio_scenes']).toEqual(['get', 'post']);
  });
});

describe('a replacement of a served subtype', () => {
  it.each([
    'base-middle-leaf',
    'leaf-middle-base',
  ] as const)('is served through the base too, in MCP and OpenAPI (%s)', async (order) => {
    const VideoScene = class Scene extends SmrtObject {
      title = '';
    };
    const HistrioScene = class Scene extends VideoScene {};
    const AppScene = class Scene extends HistrioScene {};
    field({ type: 'text' })(VideoScene.prototype, 'title');
    const steps = {
      base: () =>
        ObjectRegistry.register(VideoScene, {
          name: 'Scene',
          packageName: '@fixture/s5143-video',
          tableName: 'scenes',
          tableStrategy: 'sti',
          api: { include: ['list', 'get'] },
          mcp: { include: ['list', 'get'] },
        }),
      middle: () =>
        ObjectRegistry.register(HistrioScene, {
          name: 'Scene',
          packageName: '@fixture/s5143-histrio',
          replaceParent: false,
        }),
      leaf: () =>
        ObjectRegistry.register(AppScene, {
          name: 'Scene',
          packageName: '@fixture/s5143-app',
          replaceParent: true,
          api: true,
          mcp: true,
        }),
    };
    const sequence =
      order === 'base-middle-leaf'
        ? (['base', 'middle', 'leaf'] as const)
        : (['leaf', 'middle', 'base'] as const);
    for (const step of sequence) steps[step]();
    expect(ObjectRegistry.isServedByParent('@fixture/s5143-app:Scene')).toBe(
      true,
    );
    const result = await surfaces();
    expect(result.tools).toEqual(['scene_get', 'scene_list']);
    expect(result.paths).toEqual({
      '/api/scenes': ['get'],
      '/api/scenes/{id}': ['get'],
    });
  });
});

describe('OpenAPI path of a parent with a declared collection', () => {
  it('is the segment REST serves', async () => {
    const VideoScene = class Scene extends SmrtObject {};
    ObjectRegistry.register(VideoScene, {
      name: 'Scene',
      packageName: '@fixture/s5143-video',
      tableName: 'scenes',
      collection: 'clips',
      api: { include: ['list'] },
    });
    const spec = generateOpenAPISpec({ basePath: '/api' }) as unknown as Spec;
    expect(Object.keys(spec.paths)).toEqual(['/api/clips', '/api/clips/{id}']);
    expect(ObjectRegistry.getClass(BASE)?.collection).toBe('clips');
  });
});
