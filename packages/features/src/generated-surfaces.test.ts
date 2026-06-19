import {
  APIGenerator,
  MCPGenerator,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { CLIGenerator } from '../../cli/src/cli-generator.js';
import { FeatureDefinitionCollection } from './feature-definitions.js';
import { FeatureOverrideCollection } from './feature-overrides.js';
import { FeatureOverrideEffect } from './types.js';

@smrt({
  packageName: '@test/smrt-features',
  api: { include: ['list'] },
  cli: false,
  mcp: false,
})
class ListOnlyRestFixture extends SmrtObject {
  name: string = '';
}

class ListOnlyRestFixtureCollection extends SmrtCollection<ListOnlyRestFixture> {
  static readonly _itemClass = ListOnlyRestFixture;
}

const GetOnlyCollisionRestFixture = (() => {
  @smrt({
    packageName: '@test/smrt-features-collision-a',
    api: { include: ['get'] },
    cli: false,
    mcp: false,
  })
  class CollisionRestFixture extends SmrtObject {
    name: string = '';
  }

  return CollisionRestFixture;
})();

const ListOnlyCollisionRestFixture = (() => {
  @smrt({
    packageName: '@test/smrt-features-collision-b',
    api: { include: ['list'] },
    cli: false,
    mcp: false,
  })
  class CollisionRestFixture extends SmrtObject {
    name: string = '';
  }

  return CollisionRestFixture;
})();

class CollisionRestFixtureCollection extends SmrtCollection<
  InstanceType<typeof ListOnlyCollisionRestFixture>
> {
  static readonly _itemClass = ListOnlyCollisionRestFixture;
}

// Generated REST routes are fail-closed (#1540). These tests exercise CRUD
// verb exposure, not auth, so they simulate an authenticated gateway with a
// pass-through auth middleware. Auth itself is covered by smrt-core tests.
const passThroughAuth =
  () =>
  async (req: Request): Promise<Request | Response> =>
    req;

describe('smrt-features generated surfaces', () => {
  const closers = new Set<() => Promise<void>>();

  afterEach(async () => {
    for (const close of closers) {
      await close();
    }
    closers.clear();
  });

  it('exposes definitions as read-only and overrides as full CRUD across REST, CLI, and MCP', async () => {
    const db = await getTestDatabase({
      classes: ['FeatureDefinition', 'FeatureOverride'],
    });
    closers.add(async () => {
      if (typeof (db as any).close === 'function') {
        await (db as any).close();
      }
    });

    const definitions = await (FeatureDefinitionCollection as any).create({
      db,
    });
    const definition = await definitions.create({
      featureKey: '@test/pkg:Demo#newEditor',
      packageName: '@test/pkg',
      qualifiedClassName: '@test/pkg:Demo',
      className: 'Demo',
      localId: 'newEditor',
      defaultEnabled: false,
    });
    await definition.save();

    const overrides = await (FeatureOverrideCollection as any).create({ db });
    const override = await overrides.create({
      featureKey: '@test/pkg:Demo#newEditor',
      scopeType: 'tenant',
      scopeId: 'tenant-1',
      effect: FeatureOverrideEffect.ENABLE,
    });
    await override.save();

    const api = new APIGenerator({ authMiddleware: passThroughAuth }, { db });
    api.registerCollection('featuredefinition', definitions);
    api.registerCollection('featureoverride', overrides);
    const handler = api.generateHandler();

    const listDefinitions = await handler(
      new Request('http://localhost/api/v1/featuredefinition'),
    );
    const createDefinition = await handler(
      new Request('http://localhost/api/v1/featuredefinition', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          featureKey: '@test/pkg:Demo#beta',
          packageName: '@test/pkg',
          qualifiedClassName: '@test/pkg:Demo',
          className: 'Demo',
          localId: 'beta',
          defaultEnabled: false,
        }),
      }),
    );
    const getOverride = await handler(
      new Request(`http://localhost/api/v1/featureoverride/${override.id}`),
    );
    const createOverride = await handler(
      new Request('http://localhost/api/v1/featureoverride', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          featureKey: '@test/pkg:Demo#newEditor',
          scopeType: 'tenant',
          scopeId: 'tenant-2',
          effect: FeatureOverrideEffect.DISABLE,
        }),
      }),
    );

    expect(listDefinitions.status).toBe(200);
    expect(createDefinition.status).toBe(405);
    expect(getOverride.status).toBe(200);
    expect(createOverride.status).toBe(201);

    const cli = new CLIGenerator({ prompt: false }, { db });
    const definitionCommands = await (cli as any).generateObjectCommands(
      'FeatureDefinition',
      {},
    );
    const overrideCommands = await (cli as any).generateObjectCommands(
      'FeatureOverride',
      {},
    );

    expect(definitionCommands.map((command: any) => command.name)).toEqual([
      'featuredefinition:list',
      'featuredefinition:get',
    ]);
    expect(overrideCommands.map((command: any) => command.name)).toEqual([
      'featureoverride:list',
      'featureoverride:get',
      'featureoverride:create',
      'featureoverride:update',
      'featureoverride:delete',
    ]);

    const mcp = new MCPGenerator({}, { db });
    const toolNames = (await mcp.generateTools()).map((tool) => tool.name);

    expect(toolNames).toContain('featuredefinition_list');
    expect(toolNames).toContain('featuredefinition_get');
    expect(toolNames).not.toContain('featuredefinition_create');
    expect(toolNames).not.toContain('featuredefinition_getmetadata');
    expect(toolNames).not.toContain('featuredefinition_setmetadata');
    expect(toolNames).toContain('featureoverride_list');
    expect(toolNames).toContain('featureoverride_get');
    expect(toolNames).toContain('featureoverride_create');
    expect(toolNames).toContain('featureoverride_update');
    expect(toolNames).toContain('featureoverride_delete');
    expect(toolNames).not.toContain('featureoverride_isinherit');
    expect(toolNames).not.toContain('featureoverride_isenabled');
    expect(toolNames).not.toContain('featureoverride_isdisabled');
  });

  it('keeps the /count route available for list-only REST surfaces', async () => {
    const db = await getTestDatabase({
      classes: ['ListOnlyRestFixture'],
    });
    closers.add(async () => {
      if (typeof (db as any).close === 'function') {
        await (db as any).close();
      }
    });

    const collection = await (ListOnlyRestFixtureCollection as any).create({
      db,
    });
    const api = new APIGenerator({ authMiddleware: passThroughAuth }, { db });
    api.registerCollection('listonlyrestfixture', collection);
    const handler = api.generateHandler();

    const countResponse = await handler(
      new Request('http://localhost/api/v1/listonlyrestfixture/count'),
    );
    const getResponse = await handler(
      new Request('http://localhost/api/v1/listonlyrestfixture/some-id'),
    );

    expect(countResponse.status).toBe(200);
    expect(await countResponse.json()).toEqual({ count: 0 });
    expect(getResponse.status).toBe(405);
  });

  it('uses the collection constructor registration when same-named classes exist in multiple packages', async () => {
    void GetOnlyCollisionRestFixture;

    const db = await getTestDatabase({
      classes: ['@test/smrt-features-collision-b:CollisionRestFixture'],
    });
    closers.add(async () => {
      if (typeof (db as any).close === 'function') {
        await (db as any).close();
      }
    });

    const collection = await (CollisionRestFixtureCollection as any).create({
      db,
    });
    const api = new APIGenerator({ authMiddleware: passThroughAuth }, { db });
    api.registerCollection('collisionrestfixture', collection);
    const handler = api.generateHandler();

    const countResponse = await handler(
      new Request('http://localhost/api/v1/collisionrestfixture/count'),
    );
    const getResponse = await handler(
      new Request('http://localhost/api/v1/collisionrestfixture/some-id'),
    );

    expect(countResponse.status).toBe(200);
    expect(await countResponse.json()).toEqual({ count: 0 });
    expect(getResponse.status).toBe(405);
  });
});
