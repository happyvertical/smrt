import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmrtCollection } from './collection.js';
import { createCookbookEngine } from './cookbook/engine/engine.js';
import type { EngineCatalog } from './cookbook/engine/types.js';
import { MCPGenerator } from './generators/mcp.js';
import { APIGenerator } from './generators/rest.js';
import { SmrtObject } from './object.js';
import { ObjectRegistry } from './registry.js';
import {
  createCookbookRuntimeExposure,
  filterRuntimeCookbookSnapshot,
  filterRuntimeExposure,
  isRuntimeModelEnabled,
  notifyRuntimeExposureChanged,
  setRuntimeExposureGate,
  subscribeRuntimeExposure,
} from './runtime-exposure.js';
import { snapshotObjectRegistryState } from './test-utils.js';
import { getTestDatabase } from './testing/database.js';

const CUSTOMER = '@fixture/customers:Customer';
const ESTIMATE = '@fixture/estimates:Estimate';
const catalog: EngineCatalog = {
  models: [
    { id: CUSTOMER, name: 'Customer', packageId: 'customers', exposed: true },
    { id: ESTIMATE, name: 'Estimate', packageId: 'estimates', exposed: true },
  ],
  recipes: [
    {
      id: 'customers',
      label: 'Customers',
      models: [CUSTOMER],
      requires: [],
      nav: [{ model: CUSTOMER, label: 'Customers' }],
    },
    {
      id: 'estimates',
      label: 'Estimates',
      models: [ESTIMATE],
      requires: [],
      nav: [{ model: ESTIMATE, label: 'Estimates' }],
    },
  ],
};
const engine = () => createCookbookEngine({ catalog });
let restore: () => void;
let db: DatabaseInterface | undefined;
let gate: ReturnType<typeof createCookbookRuntimeExposure> | undefined;

beforeEach(() => {
  restore = snapshotObjectRegistryState();
  ObjectRegistry.clear();
});
afterEach(async () => {
  setRuntimeExposureGate(undefined);
  gate?.dispose();
  gate = undefined;
  await db?.close?.();
  db = undefined;
  restore();
});

function register() {
  class Customer extends SmrtObject {
    title = '';
  }
  class Estimate extends SmrtObject {
    title = '';
  }
  class Customers extends SmrtCollection<Customer> {
    static readonly _itemClass = Customer;
  }
  class Estimates extends SmrtCollection<Estimate> {
    static readonly _itemClass = Estimate;
  }
  for (const [ctor, pkg, table] of [
    [Customer, '@fixture/customers', 'gate_customers'],
    [Estimate, '@fixture/estimates', 'gate_estimates'],
  ] as const) {
    ObjectRegistry.register(ctor, {
      packageName: pkg,
      tableName: table,
      api: { public: true },
      mcp: { include: ['list', 'get'] },
    });
  }
  ObjectRegistry.registerCollection(CUSTOMER, Customers);
  ObjectRegistry.registerCollection(ESTIMATE, Estimates);
}

describe('live cookbook runtime exposure', () => {
  it('fails closed for missing tenant, missing engine, unreadable set and predicate errors', () => {
    const a = engine();
    expect(
      a.run({ name: 'add_recipes', input: { ids: ['customers'] } }).ok,
    ).toBe(true);
    let unavailable = false;
    let preference = true;
    gate = createCookbookRuntimeExposure({
      catalog,
      engineFor: () => {
        if (unavailable) throw new Error('private store failure');
        return a;
      },
      predicate: () => {
        if (!preference) throw new Error('private preference failure');
        return true;
      },
    });
    setRuntimeExposureGate(gate);
    expect(isRuntimeModelEnabled(CUSTOMER, { surface: 'rest' })).toBe(false);
    expect(
      isRuntimeModelEnabled(CUSTOMER, { surface: 'rest', tenantId: 'a' }),
    ).toBe(true);
    expect(
      isRuntimeModelEnabled(undefined, { surface: 'rest', tenantId: 'a' }),
    ).toBe(false);
    expect(
      isRuntimeModelEnabled('@unknown/package:Customer', {
        surface: 'rest',
        tenantId: 'a',
      }),
    ).toBe(false);
    preference = false;
    expect(
      isRuntimeModelEnabled(CUSTOMER, { surface: 'rest', tenantId: 'a' }),
    ).toBe(false);
    preference = true;
    unavailable = true;
    expect(
      isRuntimeModelEnabled(CUSTOMER, { surface: 'rest', tenantId: 'a' }),
    ).toBe(false);
    setRuntimeExposureGate(
      createCookbookRuntimeExposure({ catalog, engineFor: () => null }),
    );
    expect(
      isRuntimeModelEnabled(CUSTOMER, { surface: 'rest', tenantId: 'a' }),
    ).toBe(false);
  });

  it('indexes engine changes once; checks host preference each time; preserves replacement identities', () => {
    const a = engine();
    a.run({ name: 'add_recipes', input: { ids: ['customers'] } });
    const subscribe = vi.spyOn(a, 'subscribe');
    const predicate = vi.fn(() => true);
    gate = createCookbookRuntimeExposure({
      catalog,
      engineFor: () => a,
      predicate,
    });
    setRuntimeExposureGate(gate);
    const app = {
      qualifiedName: '@fixture/app:Customer',
      replacedQualifiedNames: [CUSTOMER],
    };
    for (let i = 0; i < 10; i++)
      expect(
        isRuntimeModelEnabled(app, { surface: 'screen', tenantId: 'a' }),
      ).toBe(true);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(predicate).toHaveBeenCalledTimes(10);
    predicate.mockReturnValue(false);
    expect(
      isRuntimeModelEnabled(app, { surface: 'screen', tenantId: 'a' }),
    ).toBe(false);
    gate.dispose();
    expect(
      isRuntimeModelEnabled(CUSTOMER, { surface: 'screen', tenantId: 'a' }),
    ).toBe(false);
  });

  it('filters the declared superset without mutation and broadcasts preference invalidation', () => {
    const a = engine();
    a.run({ name: 'add_features', input: { ids: [CUSTOMER] } });
    gate = createCookbookRuntimeExposure({ catalog, engineFor: () => a });
    setRuntimeExposureGate(gate);
    const definitions = [{ objectRef: CUSTOMER }, { objectRef: ESTIMATE }];
    expect(
      filterRuntimeExposure(definitions, (def) => def.objectRef, {
        surface: 'screen',
        tenantId: 'a',
      }),
    ).toEqual([definitions[0]]);
    expect(definitions).toHaveLength(2);
    const projected = filterRuntimeCookbookSnapshot(a.snapshot(), catalog, {
      tenantId: 'a',
    });
    expect(projected.features).toEqual([CUSTOMER]);
    expect(
      projected.sections
        .flatMap((section) => section.items)
        .map((item) => item.id),
    ).toEqual(['item:customers:Customer']);
    const changed = vi.fn();
    const unsubscribe = subscribeRuntimeExposure(changed);
    notifyRuntimeExposureChanged();
    expect(changed).toHaveBeenCalledOnce();
    unsubscribe();
    notifyRuntimeExposureChanged();
    expect(changed).toHaveBeenCalledOnce();
  });

  it('SQLite: disabled 404/absent/refused -> enable 200/tools -> disable, with isolated tenants and no regeneration', async () => {
    register();
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const a = engine();
    const b = engine();
    b.run({ name: 'add_recipes', input: { ids: ['estimates'] } });
    let readable = true;
    gate = createCookbookRuntimeExposure({
      catalog,
      engineFor: (context) =>
        readable
          ? context.tenantId === 'a'
            ? a
            : context.tenantId === 'b'
              ? b
              : null
          : null,
    });
    setRuntimeExposureGate(gate);
    const api = (tenantId: string) =>
      new APIGenerator(
        { basePath: '/api' },
        { db, tenantId },
      ).generateHandler();
    const request = () => new Request('http://fixture/api/estimates');
    const mcpA = new MCPGenerator(
      { classNames: [ESTIMATE] },
      { db, tenantId: 'a', user: { id: 'owner-a' } },
    );
    const mcpB = new MCPGenerator(
      { classNames: [ESTIMATE] },
      { db, tenantId: 'b', user: { id: 'owner-b' } },
    );
    const superset = await mcpA.generateToolDefinitions();
    expect(superset.map((tool) => tool.name)).toContain('estimate_list');
    expect((await api('a')(request())).status).toBe(404);
    expect(await mcpA.generateTools()).toEqual([]);
    expect(
      (
        await mcpA.handleToolCall({
          method: 'tools/call',
          params: { name: 'estimate_list', arguments: {} },
        })
      ).isError,
    ).toBe(true);
    expect((await api('b')(request())).status).toBe(200);
    expect((await mcpB.generateTools()).map((tool) => tool.name)).toContain(
      'estimate_list',
    );
    const changed = vi.fn();
    const unsubscribe = mcpA.onToolsListChanged(changed);
    expect(
      a.run({ name: 'add_recipes', input: { ids: ['estimates'] } }).ok,
    ).toBe(true);
    expect(changed).toHaveBeenCalledOnce();
    expect((await api('a')(request())).status).toBe(200);
    expect((await mcpA.generateTools()).map((tool) => tool.name)).toContain(
      'estimate_list',
    );
    expect(
      (
        await mcpA.handleToolCall({
          method: 'tools/call',
          params: { name: 'estimate_list', arguments: {} },
        })
      ).isError,
    ).not.toBe(true);
    expect(
      a.run({ name: 'remove_recipes', input: { ids: ['estimates'] } }).ok,
    ).toBe(true);
    expect(changed).toHaveBeenCalledTimes(2);
    expect((await api('a')(request())).status).toBe(404);
    expect(await mcpA.generateTools()).toEqual([]);
    readable = false;
    expect((await api('b')(request())).status).toBe(404);
    expect(await mcpB.generateTools()).toEqual([]);
    expect(await mcpA.generateToolDefinitions()).toEqual(superset);
    unsubscribe();
  });

  it('non-opted-in app retains REST and MCP behavior', async () => {
    register();
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const api = new APIGenerator(
      { basePath: '/api' },
      { db },
    ).generateHandler();
    expect(
      (await api(new Request('http://fixture/api/estimates'))).status,
    ).toBe(200);
    expect(
      (
        await new MCPGenerator(
          { classNames: [ESTIMATE] },
          { db },
        ).generateTools()
      ).map((tool) => tool.name),
    ).toContain('estimate_list');
  });
});
