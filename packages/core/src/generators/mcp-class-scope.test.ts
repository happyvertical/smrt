/**
 * #3490: an MCP generator scoped to a class allow-list builds tools only for
 * those classes, so a name collision between unrelated registered classes
 * cannot fail a catalog that never lists them. The duplicate-name check still
 * applies to everything inside the scope.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { SmrtCollection } from '../collection.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry } from '../registry.js';
import { setRuntimeExposureGate } from '../runtime-exposure.js';
import { snapshotObjectRegistryState } from '../test-utils.js';
import { getTestDatabase } from '../testing/database.js';
import { MCPGenerator } from './mcp.js';

function named<T extends typeof SmrtObject>(ctor: T, name: string): T {
  Object.defineProperty(ctor, 'name', { value: name });
  return ctor;
}

describe('MCPGenerator class scope (#3490)', () => {
  let restoreRegistry: () => void;

  beforeEach(() => {
    restoreRegistry = snapshotObjectRegistryState();
    // Two packages that both publish `ScopeCollision` tools: the generated
    // `scopecollision_list` names collide.
    for (const packageName of ['@fixture/scope-one', '@fixture/scope-two']) {
      ObjectRegistry.register(
        named(class extends SmrtObject {}, 'ScopeCollision'),
        { packageName, mcp: { include: ['list'] } },
      );
    }
    ObjectRegistry.register(named(class extends SmrtObject {}, 'ScopeItem'), {
      packageName: '@fixture/scope-app',
      mcp: { include: ['list', 'get'] },
    });
  });

  afterEach(() => restoreRegistry());

  it('fails closed on a collision when unscoped (unchanged)', async () => {
    await expect(new MCPGenerator().generateTools()).rejects.toThrow(
      'Duplicate MCP tool name: scopecollision_list',
    );
  });

  it.each([
    [['ScopeItem']],
    [['scopeitem']],
    [['@fixture/scope-app:ScopeItem']],
  ])('builds only the scoped classes for %j', async (classNames) => {
    const tools = await new MCPGenerator({ classNames }).generateTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'scopeitem_get',
      'scopeitem_list',
    ]);
  });

  it('resolves tool calls within the scope only', async () => {
    const generator = new MCPGenerator({ classNames: ['ScopeItem'] });
    const response = await generator.handleToolCall({
      method: 'tools/call',
      params: { name: 'scopecollision_list', arguments: {} },
    });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('Unknown tool');
  });

  it('keeps the duplicate-name check for a collision inside the scope', async () => {
    await expect(
      new MCPGenerator({
        classNames: [
          'ScopeItem',
          '@fixture/scope-one:ScopeCollision',
          '@fixture/scope-two:ScopeCollision',
        ],
      }).generateTools(),
    ).rejects.toThrow('Duplicate MCP tool name: scopecollision_list');
  });

  it('optionally qualifies colliding models without changing unique aliases or identities', async () => {
    const classNames = [
      'ScopeItem',
      '@fixture/scope-one:ScopeCollision',
      '@fixture/scope-two:ScopeCollision',
    ];
    const generator = new MCPGenerator({
      classNames,
      qualifyCollidingNames: true,
      snakeCaseNames: true,
    });
    const tools = await generator.generateTools();
    expect(tools).toHaveLength(4);
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(4);
    expect(
      tools.every((tool) => /^[a-z][a-z0-9_]{0,63}$/.test(tool.name)),
    ).toBe(true);
    expect(tools.map((tool) => tool.name)).toContain('scopeitem_list');
    expect(tools.map((tool) => tool.name)).not.toContain('scopecollision_list');
    const identities = tools.map((tool) => generator.getToolIdentity(tool));
    expect(
      identities
        .filter((identity) => identity.originalName === 'scopecollision_list')
        .map((identity) => identity.qualifiedName)
        .sort(),
    ).toEqual(classNames.slice(1));
    const reversed = await new MCPGenerator({
      classNames: [...classNames].reverse(),
      qualifyCollidingNames: true,
      snakeCaseNames: true,
    }).generateTools();
    expect(reversed.map((tool) => tool.name)).toEqual(
      tools.map((tool) => tool.name),
    );
  });

  it('keeps MCP collision identity independent from hosted collection route aliases', async () => {
    const { aliasHostedCollections } = await import(
      '../consumer-plugin/hosted-sti-collections.js'
    );
    const packages = ['@fixture/scope-one', '@fixture/scope-two'];
    const manifest = aliasHostedCollections({
      objects: Object.fromEntries(
        packages.map((packageName) => [
          `${packageName}:ScopeCollision`,
          {
            className: 'ScopeCollision',
            name: 'scopecollision',
            qualifiedName: `${packageName}:ScopeCollision`,
            packageName,
            collection: 'collisions',
            fields: {},
            methods: {},
            decoratorConfig: {},
          },
        ]),
      ),
    });
    expect(
      new Set(Object.values(manifest.objects).map((item) => item.collection))
        .size,
    ).toBe(2);
    ObjectRegistry.clear();
    for (const [identity, item] of Object.entries(manifest.objects)) {
      ObjectRegistry.register(
        named(class extends SmrtObject {}, 'ScopeCollision'),
        {
          packageName: item.packageName,
          collection: item.collection,
          mcp: { include: ['list'] },
        },
      );
      expect(ObjectRegistry.getConfig(identity).collection).toBe(
        item.collection,
      );
    }
    await expect(new MCPGenerator().generateTools()).rejects.toThrow(
      'Duplicate MCP tool name: scopecollision_list',
    );
    const generator = new MCPGenerator({
      qualifyCollidingNames: true,
      snakeCaseNames: true,
    });
    const tools = await generator.generateTools();
    expect(tools).toHaveLength(2);
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(2);
    expect(
      tools.every((tool) => /^[a-z][a-z0-9_]{0,63}$/.test(tool.name)),
    ).toBe(true);
    expect(
      tools.map((tool) => generator.getToolIdentity(tool).qualifiedName).sort(),
    ).toEqual(Object.keys(manifest.objects).sort());
  });

  it('fails closed on a simple name that matches more than one class', async () => {
    await expect(
      new MCPGenerator({ classNames: ['ScopeCollision'] }).generateTools(),
    ).rejects.toThrow(
      "MCP class scope 'ScopeCollision' is ambiguous: it matches @fixture/scope-one:ScopeCollision, @fixture/scope-two:ScopeCollision",
    );
    const response = await new MCPGenerator({
      classNames: ['scopecollision'],
    }).handleToolCall({
      method: 'tools/call',
      params: { name: 'scopecollision_list', arguments: {} },
    });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('is ambiguous');
  });

  it('reserves deferred same-name declarations before the second model is imported', async () => {
    ObjectRegistry.clear();
    ObjectRegistry.register(
      named(class extends SmrtObject {}, 'DeferredItem'),
      {
        packageName: '@fixture/deferred-one',
        mcp: { include: ['list'] },
      },
    );
    const generator = new MCPGenerator({
      classNames: [
        '@fixture/deferred-one:DeferredItem',
        '@fixture/deferred-two:DeferredItem',
      ],
      qualifyCollidingNames: true,
    });
    const first = await generator.generateTools();
    expect(first).toHaveLength(1);
    expect(first[0].name).not.toBe('deferreditem_list');
    ObjectRegistry.register(
      named(class extends SmrtObject {}, 'DeferredItem'),
      {
        packageName: '@fixture/deferred-two',
        mcp: { include: ['list'] },
      },
    );
    const second = await generator.generateTools();
    expect(second).toHaveLength(2);
    expect(second.map((tool) => tool.name)).toContain(first[0].name);
    expect(new Set(second.map((tool) => tool.name)).size).toBe(2);
  });

  it('keeps aliases stable across live exposure changes and rejects stale disabled calls', async () => {
    const generator = new MCPGenerator(
      {
        classNames: [
          '@fixture/scope-one:ScopeCollision',
          '@fixture/scope-two:ScopeCollision',
        ],
        qualifyCollidingNames: true,
      },
      { user: { id: 'owner' }, tenantId: 'tenant' },
    );
    let enabled = '@fixture/scope-one:ScopeCollision';
    try {
      setRuntimeExposureGate({
        isEnabled: (model) => model.qualifiedName === enabled,
      });
      const first = await generator.generateTools();
      expect(first).toHaveLength(1);
      enabled = '@fixture/scope-two:ScopeCollision';
      const second = await generator.generateTools();
      expect(second).toHaveLength(1);
      expect(second[0].name).not.toBe(first[0].name);
      expect(generator.getToolIdentity(second[0]).qualifiedName).toBe(enabled);
      const stale = await generator.handleToolCall({
        method: 'tools/call',
        params: { name: first[0].name, arguments: {} },
      });
      expect(stale.isError).toBe(true);
      enabled = '@fixture/scope-one:ScopeCollision';
      expect(
        (await generator.generateTools()).map((tool) => tool.name),
      ).toEqual(first.map((tool) => tool.name));
    } finally {
      setRuntimeExposureGate(undefined);
    }
  });

  it('builds nothing for a scope that names no registered class', async () => {
    expect(
      await new MCPGenerator({ classNames: ['Unregistered'] }).generateTools(),
    ).toEqual([]);
    expect(await new MCPGenerator({ classNames: [] }).generateTools()).toEqual(
      [],
    );
  });
});

describe('MCPGenerator scoped by qualified name (#3490)', () => {
  // `@fixture/pick-a` registers first, so a simple-name lookup lands on it.
  const PickA = named(class extends SmrtObject {}, 'PickedThing');
  const PickB = named(class extends SmrtObject {}, 'PickedThing');
  class PickACollection extends SmrtCollection<SmrtObject> {
    static readonly _itemClass = PickA;
  }
  class PickBCollection extends SmrtCollection<SmrtObject> {
    static readonly _itemClass = PickB;
  }
  let restoreRegistry: () => void;
  let db: Awaited<ReturnType<typeof getTestDatabase>>;
  const user = { id: 'test-user' };

  beforeAll(async () => {
    restoreRegistry = snapshotObjectRegistryState();
    ObjectRegistry.register(PickA, {
      packageName: '@fixture/pick-a',
      tableName: 'picked_things_a',
      mcp: { include: ['list'] },
    });
    ObjectRegistry.register(PickB, {
      packageName: '@fixture/pick-b',
      tableName: 'picked_things_b',
      mcp: { include: ['list', 'get'] },
    });
    ObjectRegistry.registerCollection(
      '@fixture/pick-a:PickedThing',
      PickACollection,
    );
    ObjectRegistry.registerCollection(
      '@fixture/pick-b:PickedThing',
      PickBCollection,
    );
    db = await getTestDatabase({
      classes: ['@fixture/pick-a:PickedThing', '@fixture/pick-b:PickedThing'],
    });
    for (const [table, slug] of [
      ['picked_things_a', 'from-a'],
      ['picked_things_b', 'from-b'],
    ]) {
      await db.insert(table, {
        id:
          table === 'picked_things_a'
            ? '00000000-0000-4000-8000-00000000000a'
            : '00000000-0000-4000-8000-00000000000b',
        slug,
        context: '',
      });
    }
  });

  afterAll(async () => {
    await db?.close?.();
    restoreRegistry();
  });

  it("generates from the selected class's own configuration", async () => {
    const tools = await new MCPGenerator({
      classNames: ['@fixture/pick-b:PickedThing'],
    }).generateTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'pickedthing_get',
      'pickedthing_list',
    ]);
  });

  it('dispatches a call to the selected class and its collection only', async () => {
    const call = (scope: string) =>
      new MCPGenerator({ classNames: [scope] }, { db, user }).handleToolCall({
        method: 'tools/call',
        params: { name: 'pickedthing_list', arguments: {} },
      });
    const fromB = JSON.stringify(
      (await call('@fixture/pick-b:PickedThing')).structuredContent,
    );
    expect(fromB).toContain('from-b');
    expect(fromB).not.toContain('from-a');
    const fromA = JSON.stringify(
      (await call('@fixture/pick-a:PickedThing')).structuredContent,
    );
    expect(fromA).toContain('from-a');
    expect(fromA).not.toContain('from-b');
  });

  it('dispatches qualified collision aliases to their exact collections and refuses the old ambiguous alias', async () => {
    const generator = new MCPGenerator(
      {
        classNames: [
          '@fixture/pick-a:PickedThing',
          '@fixture/pick-b:PickedThing',
        ],
        qualifyCollidingNames: true,
        snakeCaseNames: true,
      },
      { db, user },
    );
    const tools = await generator.generateTools();
    for (const suffix of ['a', 'b']) {
      const tool = tools.find((candidate) => {
        const identity = generator.getToolIdentity(candidate);
        return (
          identity.qualifiedName === `@fixture/pick-${suffix}:PickedThing` &&
          identity.action === 'list'
        );
      });
      if (!tool) throw new Error(`Missing tool for pick-${suffix}`);
      const result = await generator.handleToolCall({
        method: 'tools/call',
        params: { name: tool.name, arguments: {} },
      });
      expect(result.isError).not.toBe(true);
      const json = JSON.stringify(result.structuredContent);
      expect(json).toContain(`from-${suffix}`);
      expect(json).not.toContain(`from-${suffix === 'a' ? 'b' : 'a'}`);
    }
    const result = await generator.handleToolCall({
      method: 'tools/call',
      params: { name: 'pickedthing_list', arguments: {} },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown tool');
  });
});
