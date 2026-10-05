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
});
