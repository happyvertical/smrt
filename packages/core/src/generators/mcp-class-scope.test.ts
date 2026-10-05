/**
 * #3490: an MCP generator scoped to a class allow-list builds tools only for
 * those classes, so a name collision between unrelated registered classes
 * cannot fail a catalog that never lists them. The duplicate-name check still
 * applies to everything inside the scope.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtObject } from '../object.js';
import { ObjectRegistry } from '../registry.js';
import { snapshotObjectRegistryState } from '../test-utils.js';
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
        classNames: ['ScopeItem', 'ScopeCollision'],
      }).generateTools(),
    ).rejects.toThrow('Duplicate MCP tool name: scopecollision_list');
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
