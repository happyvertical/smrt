import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SmrtCrudFetchers, SmrtWebCollectionDefinition } from './index.js';
import { buildListQuery } from './index.js';
import { registerWebMcpTools } from './webmcp.js';

// ---------------------------------------------------------------------------
// A fake WebMCP registry standing in for Chrome's document.modelContext.
// ---------------------------------------------------------------------------

interface CapturedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
  execute: (args: Record<string, unknown>) => Promise<string> | string;
}

function installModelContext(): {
  tools: CapturedTool[];
  unregistered: string[];
} {
  const tools: CapturedTool[] = [];
  const unregistered: string[] = [];
  (globalThis as { document?: unknown }).document = {
    modelContext: {
      registerTool(tool: CapturedTool) {
        tools.push(tool);
        return { unregister: () => unregistered.push(tool.name) };
      },
    },
  };
  return { tools, unregistered };
}

function clearModelContext(): void {
  (globalThis as { document?: unknown }).document = undefined;
}

// A Product definition as the core codegen would emit it, tool descriptors and
// all. Only the fields registerWebMcpTools reads are populated.
const PRODUCT_DEF: SmrtWebCollectionDefinition = {
  name: 'products',
  className: 'Product',
  endpoint: '/products',
  idField: 'id',
  actions: ['list', 'get', 'create', 'update', 'delete', 'publish'],
  toolDescriptors: [
    {
      action: 'list',
      name: 'product_list',
      description: 'List Product objects with optional filtering',
      inputSchema: { type: 'object', properties: {} },
      readOnly: true,
    },
    {
      action: 'create',
      name: 'product_create',
      description: 'Create a new Product',
      inputSchema: { type: 'object', properties: {} },
      readOnly: false,
    },
    {
      action: 'publish',
      name: 'product_publish',
      description: 'Execute publish action on Product',
      inputSchema: { type: 'object', properties: {} },
      readOnly: false,
    },
  ],
};

function mockFetchers(overrides: Partial<SmrtCrudFetchers> = {}) {
  return {
    list: vi.fn(async () => [{ id: 'p1', name: 'Widget' }]),
    get: vi.fn(async (id: string) => ({ id, name: 'Widget' })),
    create: vi.fn(async (data: Record<string, unknown>) => ({
      id: 'p2',
      ...data,
    })),
    update: vi.fn(async (id: string, data: Record<string, unknown>) => ({
      id,
      ...data,
    })),
    delete: vi.fn(async () => true),
    ...overrides,
  } satisfies SmrtCrudFetchers;
}

describe('registerWebMcpTools', () => {
  afterEach(() => {
    clearModelContext();
    vi.restoreAllMocks();
  });

  it('is a no-op when the browser has no WebMCP support', () => {
    clearModelContext();
    const dispose = registerWebMcpTools([PRODUCT_DEF], {
      resolveFetchers: () => mockFetchers(),
    });
    expect(dispose).toBeInstanceOf(Function);
    expect(() => dispose()).not.toThrow(); // inert disposer, no crash
  });

  it('registers one tool per descriptor with the right names', () => {
    const registry = installModelContext();
    registerWebMcpTools([PRODUCT_DEF], {
      resolveFetchers: () => mockFetchers(),
    });
    expect(registry.tools.map((t) => t.name)).toEqual([
      'product_list',
      'product_create',
      'product_publish',
    ]);
  });

  it('maps readOnly to WebMCP readOnlyHint annotations', () => {
    const registry = installModelContext();
    registerWebMcpTools([PRODUCT_DEF], {
      resolveFetchers: () => mockFetchers(),
    });
    const byName = new Map(registry.tools.map((t) => [t.name, t]));
    expect(byName.get('product_list')?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get('product_create')?.annotations?.readOnlyHint).toBe(false);
  });

  it('routes a list tool call through the fetchers and returns a JSON string', async () => {
    const registry = installModelContext();
    const fetchers = mockFetchers();
    registerWebMcpTools([PRODUCT_DEF], { resolveFetchers: () => fetchers });

    const listTool = registry.tools.find((t) => t.name === 'product_list');
    const result = await listTool?.execute({ limit: 10 });

    expect(fetchers.list).toHaveBeenCalledWith({ limit: 10 });
    expect(typeof result).toBe('string');
    expect(JSON.parse(result as string)).toEqual([
      { id: 'p1', name: 'Widget' },
    ]);
  });

  it('routes a create tool call through the fetchers with the tool args as the body', async () => {
    const registry = installModelContext();
    const fetchers = mockFetchers();
    registerWebMcpTools([PRODUCT_DEF], { resolveFetchers: () => fetchers });

    const createTool = registry.tools.find((t) => t.name === 'product_create');
    const result = await createTool?.execute({ name: 'Gadget', price: 9.99 });

    expect(fetchers.create).toHaveBeenCalledWith({
      name: 'Gadget',
      price: 9.99,
    });
    expect(JSON.parse(result as string)).toMatchObject({
      id: 'p2',
      name: 'Gadget',
    });
  });

  it('returns a clear not-wired payload for custom actions (tracer scope)', async () => {
    const registry = installModelContext();
    registerWebMcpTools([PRODUCT_DEF], {
      resolveFetchers: () => mockFetchers(),
    });

    const publishTool = registry.tools.find(
      (t) => t.name === 'product_publish',
    );
    const parsed = JSON.parse(
      (await publishTool?.execute({ id: 'p1' })) as string,
    );
    expect(parsed.error).toMatch(/not wired/i);
    expect(parsed.action).toBe('publish');
  });

  it('deregisters every registered tool when disposed', () => {
    const registry = installModelContext();
    const dispose = registerWebMcpTools([PRODUCT_DEF], {
      resolveFetchers: () => mockFetchers(),
    });
    dispose();
    // Disposer pops LIFO, so compare as a set — order is incidental.
    expect(new Set(registry.unregistered)).toEqual(
      new Set(['product_list', 'product_create', 'product_publish']),
    );
  });

  it('skips tools rejected by the filter predicate', () => {
    const registry = installModelContext();
    registerWebMcpTools([PRODUCT_DEF], {
      resolveFetchers: () => mockFetchers(),
      filter: (_def, descriptor) => descriptor.readOnly, // reads-only surface
    });
    expect(registry.tools.map((t) => t.name)).toEqual(['product_list']);
  });

  it('ignores definitions with no tool descriptors', () => {
    const registry = installModelContext();
    const bare: SmrtWebCollectionDefinition = {
      name: 'tags',
      className: 'Tag',
      endpoint: '/tags',
      idField: 'id',
      actions: ['list'],
    };
    registerWebMcpTools([bare], { resolveFetchers: () => mockFetchers() });
    expect(registry.tools).toHaveLength(0);
  });

  it('serializes list query params into the REST URL on the default fetcher path', async () => {
    const registry = installModelContext();
    const calls: string[] = [];
    const fetchFn = (async (url: string | URL) => {
      calls.push(String(url));
      return {
        ok: true,
        status: 200,
        json: async () => [{ id: 'p1' }],
      } as Response;
    }) as unknown as typeof fetch;

    // No resolveFetchers → exercises the real createDefinitionFetchers path.
    registerWebMcpTools([PRODUCT_DEF], { basePath: '/api/v1', fetchFn });
    const listTool = registry.tools.find((t) => t.name === 'product_list');
    await listTool?.execute({
      limit: 10,
      offset: 20,
      where: { status: 'active' },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/api/v1/products?');
    expect(calls[0]).toContain('limit=10');
    expect(calls[0]).toContain('offset=20');
    expect(calls[0]).toContain('status=active');
  });
});

describe('buildListQuery', () => {
  const parse = (qs: string) => new URLSearchParams(qs.replace(/^\?/, ''));

  it('is empty for no params (the collection runtime bare list())', () => {
    expect(buildListQuery()).toBe('');
    expect(buildListQuery({})).toBe('');
  });

  it('serializes limit/offset/orderBy as scalars', () => {
    const p = parse(
      buildListQuery({ limit: 10, offset: 5, orderBy: 'name ASC' }),
    );
    expect(p.get('limit')).toBe('10');
    expect(p.get('offset')).toBe('5');
    expect(p.get('orderBy')).toBe('name ASC');
  });

  it('serializes an equality where as field=value', () => {
    const p = parse(buildListQuery({ where: { status: 'active' } }));
    expect(p.get('status')).toBe('active');
  });

  it('maps a SMRT operator condition to the REST field[op]=value token', () => {
    const p = parse(
      buildListQuery({ where: { price: { op: '>', value: 10 } } }),
    );
    expect(p.get('price[gt]')).toBe('10');
  });

  it('joins an in-array with commas', () => {
    const p = parse(
      buildListQuery({ where: { id: { op: 'in', value: ['a', 'b'] } } }),
    );
    expect(p.get('id[in]')).toBe('a,b');
  });
});
