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
      // WebMCP removes a tool when the signal it was registered with aborts.
      registerTool(tool: CapturedTool, opts?: { signal?: AbortSignal }) {
        tools.push(tool);
        opts?.signal?.addEventListener('abort', () =>
          unregistered.push(tool.name),
        );
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
  objectRef: '@test/smrt-web:Product',
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

const MUTATION_DEF: SmrtWebCollectionDefinition = {
  ...PRODUCT_DEF,
  toolDescriptors: [
    {
      action: 'update',
      name: 'product_update',
      description: 'Update an existing Product',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
      readOnly: false,
    },
    {
      action: 'delete',
      name: 'product_delete',
      description: 'Delete a Product by ID',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
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
    custom: vi.fn(async (action: string, args: Record<string, unknown>) => ({
      action,
      result: args,
    })),
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

  it('routes a create tool call through the shared collection mutation path', async () => {
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

  it('routes custom actions through the collection fetcher', async () => {
    const registry = installModelContext();
    const fetchers = mockFetchers();
    registerWebMcpTools([PRODUCT_DEF], {
      resolveFetchers: () => fetchers,
    });

    const publishTool = registry.tools.find(
      (t) => t.name === 'product_publish',
    );
    const parsed = JSON.parse(
      (await publishTool?.execute({ id: 'p1' })) as string,
    );
    expect(fetchers.custom).toHaveBeenCalledWith('publish', { id: 'p1' });
    expect(parsed).toEqual({ action: 'publish', result: { id: 'p1' } });
  });

  it('hydrates the shared collection before update and delete mutations', async () => {
    const registry = installModelContext();
    const fetchers = mockFetchers();
    registerWebMcpTools([MUTATION_DEF], {
      resolveFetchers: () => fetchers,
    });

    const updateTool = registry.tools.find((t) => t.name === 'product_update');
    const deleteTool = registry.tools.find((t) => t.name === 'product_delete');
    await updateTool?.execute({ id: 'p99', name: 'Updated' });
    await deleteTool?.execute({ id: 'p99' });

    expect(fetchers.list.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(fetchers.get).toHaveBeenCalledWith('p99');
    expect(fetchers.update).toHaveBeenCalledWith('p99', { name: 'Updated' });
    expect(fetchers.delete).toHaveBeenCalledWith('p99');
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
      objectRef: '@test/smrt-web:Tag',
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

  it('uses generated custom route method and path metadata', async () => {
    const registry = installModelContext();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return {
        ok: true,
        status: 200,
        json: async () => ({ action: 'publish', result: { id: 'p1' } }),
      } as Response;
    }) as unknown as typeof fetch;
    const definition: SmrtWebCollectionDefinition = {
      ...PRODUCT_DEF,
      toolDescriptors: [
        {
          action: 'publish',
          name: 'product_publish',
          description: 'Publish a Product',
          inputSchema: { type: 'object' },
          readOnly: false,
          route: {
            method: 'PATCH',
            scope: 'item',
            path: ['publish-now'],
          },
        },
      ],
    };
    registerWebMcpTools([definition], { basePath: '/api/v1', fetchFn });
    const publishTool = registry.tools.find(
      (t) => t.name === 'product_publish',
    );
    await publishTool?.execute({ id: 'p1', reason: 'agent' });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/api/v1/products/p1/publish-now');
    expect(calls[0]?.init?.method).toBe('PATCH');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ reason: 'agent' }));
  });

  it('unwraps a generated single-options bag for POST and GET custom routes', async () => {
    const registry = installModelContext();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      } as Response;
    }) as unknown as typeof fetch;
    const definition: SmrtWebCollectionDefinition = {
      ...PRODUCT_DEF,
      toolDescriptors: [
        {
          action: 'publish',
          name: 'product_publish',
          description: 'Publish a Product',
          inputSchema: { type: 'object' },
          readOnly: false,
          route: {
            method: 'PATCH',
            scope: 'item',
            path: ['publish-now'],
            optionsBag: true,
          },
        },
        {
          action: 'preview',
          name: 'product_preview',
          description: 'Preview a Product',
          inputSchema: { type: 'object' },
          readOnly: true,
          route: {
            method: 'GET',
            scope: 'collection',
            path: ['preview'],
            optionsBag: true,
          },
        },
      ],
    };
    registerWebMcpTools([definition], { basePath: '/api/v1', fetchFn });
    const publishTool = registry.tools.find(
      (t) => t.name === 'product_publish',
    );
    const previewTool = registry.tools.find(
      (t) => t.name === 'product_preview',
    );
    await publishTool?.execute({ id: 'p1', options: { reason: 'agent' } });
    await publishTool?.execute({ id: 'p1' });
    await publishTool?.execute({ id: 'p1', options: null });
    await previewTool?.execute({ options: { format: 'summary' } });
    await previewTool?.execute({});
    await previewTool?.execute({ options: null });

    expect(calls[0]?.url).toBe('/api/v1/products/p1/publish-now');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ reason: 'agent' }));
    expect(calls[1]?.init?.body).toBeUndefined();
    expect(calls[2]?.init?.body).toBe('null');
    expect(calls[3]?.url).toBe('/api/v1/products/preview?format=summary');
    expect(calls[4]?.url).toBe(
      '/api/v1/products/preview?__smrt_options=undefined',
    );
    expect(calls[5]?.url).toBe('/api/v1/products/preview?__smrt_options=null');
  });

  it('maps actionId aliases for item bodies and collection path parameters', async () => {
    const registry = installModelContext();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      } as Response;
    }) as unknown as typeof fetch;
    const definition: SmrtWebCollectionDefinition = {
      ...PRODUCT_DEF,
      toolDescriptors: [
        {
          action: 'archive',
          name: 'product_archive',
          description: 'Archive a Product',
          inputSchema: { type: 'object' },
          readOnly: false,
          route: {
            method: 'PATCH',
            scope: 'item',
            path: ['archive'],
            parameterAliases: { actionId: 'id' },
          },
        },
        {
          action: 'archiveCollection',
          name: 'product_archiveCollection',
          description: 'Archive a Product by alternate ID',
          inputSchema: { type: 'object' },
          readOnly: false,
          route: {
            method: 'PATCH',
            scope: 'collection',
            path: ['by-id', '[id]'],
            parameterAliases: { actionId: 'id' },
          },
        },
      ],
    };
    registerWebMcpTools([definition], { basePath: '/api/v1', fetchFn });
    const itemTool = registry.tools.find((t) => t.name === 'product_archive');
    const collectionTool = registry.tools.find(
      (t) => t.name === 'product_archiveCollection',
    );
    await itemTool?.execute({
      id: 'receiver-1',
      actionId: 'target-7',
      reason: 'item',
    });
    await collectionTool?.execute({
      actionId: 'target-7',
      reason: 'collection',
    });

    expect(calls[0]?.url).toBe('/api/v1/products/receiver-1/archive');
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
      id: 'target-7',
      reason: 'item',
    });
    expect(calls[1]?.url).toBe('/api/v1/products/by-id/target-7');
    expect(JSON.parse(calls[1]?.init?.body as string)).toEqual({
      reason: 'collection',
    });
  });

  it('resolves a get tool by slug when no id is provided', async () => {
    const registry = installModelContext();
    const fetchers = mockFetchers();
    const defWithGet: SmrtWebCollectionDefinition = {
      ...PRODUCT_DEF,
      toolDescriptors: [
        {
          action: 'get',
          name: 'product_get',
          description: 'Get a specific Product by ID or slug',
          inputSchema: { type: 'object', properties: {} },
          readOnly: true,
        },
      ],
    };
    registerWebMcpTools([defWithGet], { resolveFetchers: () => fetchers });
    const getTool = registry.tools.find((t) => t.name === 'product_get');
    await getTool?.execute({ slug: 'my-widget' });
    expect(fetchers.get).toHaveBeenCalledWith('my-widget');
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
