import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  SmrtCrudFetchers,
  SmrtWebCollection,
  SmrtWebCollectionDefinition,
  SmrtWebRequestError,
  WebMcpToolDefinition,
  WebToolDescriptor,
} from './index.js';
import {
  buildListQuery,
  createSmrtCollection,
  createSmrtWebClient,
} from './index.js';
import {
  type RegisterWebMcpToolsOptions,
  registerWebMcpTools as registerWebMcpToolsWithPolicy,
  type WebMcpRegistrationDefinition,
} from './webmcp.js';

const ALLOW_ALL = {
  effects: ['read', 'write', 'destructive'] as const,
};

// Preserve the pre-policy expectations in the existing dispatch regression
// suite. Policy-default behavior is tested explicitly with the raw registrar.
function registerWebMcpTools(
  definitions: readonly WebMcpRegistrationDefinition[],
  options: RegisterWebMcpToolsOptions = {},
) {
  return registerWebMcpToolsWithPolicy(definitions, {
    ...ALLOW_ALL,
    ...options,
  });
}

// ---------------------------------------------------------------------------
// A fake WebMCP registry standing in for Chrome's document.modelContext.
// ---------------------------------------------------------------------------

interface CapturedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
    untrustedContentHint?: boolean;
  };
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

function canonicalTool(
  action: string,
  overrides: Partial<WebMcpToolDefinition> = {},
): WebMcpToolDefinition {
  const readOnly = action === 'get' || action === 'list';
  const effect = readOnly
    ? 'read'
    : action === 'create' || action === 'update'
      ? 'write'
      : 'destructive';
  return {
    collection: 'reports',
    objectRef: '@test/smrt-web:Report',
    className: 'Report',
    endpoint: '/reports',
    idField: 'id',
    idType: 'uuid',
    relationships: [],
    action,
    name: `report_${action}`,
    description: `${action} Report`,
    inputSchema: { type: 'object', properties: {} },
    readOnly,
    effect,
    idempotent:
      action !== 'create' && !readOnly ? action !== 'refresh' : readOnly,
    openWorld: !['list', 'get', 'create', 'update', 'delete'].includes(action),
    route: {
      method: readOnly ? 'GET' : 'POST',
      scope: action === 'get' ? 'item' : 'collection',
      path: action === 'get' || action === 'create' ? [] : [action],
    },
    ...overrides,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  if (!predicate()) throw new Error('waitFor: predicate never became true');
}

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

  it('is a no-op when the browser has no WebMCP support', async () => {
    clearModelContext();
    const dispose = registerWebMcpTools([PRODUCT_DEF], {
      resolveFetchers: () => mockFetchers(),
    });
    expect(dispose).toBeInstanceOf(Function);
    expect(() => dispose()).not.toThrow(); // inert disposer, no crash
    await expect(dispose.ready).resolves.toBeUndefined();
  });

  it('validates exposure policy without WebMCP browser support', () => {
    clearModelContext();
    expect(() =>
      registerWebMcpToolsWithPolicy([], {
        effects: ['invalid' as 'read'],
      }),
    ).toThrow('Invalid WebMCP effect');
    expect(() =>
      registerWebMcpToolsWithPolicy([], { namespace: 'unsafe namespace' }),
    ).toThrow('WebMCP namespace');
    expect(() => registerWebMcpToolsWithPolicy([], { maxTools: -1 })).toThrow(
      'WebMCP maxTools',
    );
  });

  it('exposes only read tools when no effects policy is configured', () => {
    const registry = installModelContext();
    registerWebMcpToolsWithPolicy([PRODUCT_DEF], {
      resolveFetchers: () => mockFetchers(),
    });

    expect(registry.tools.map((tool) => tool.name)).toEqual(['product_list']);
  });

  it('selects custom actions by their declared effect under the default policy', () => {
    const registry = installModelContext();
    registerWebMcpToolsWithPolicy([
      canonicalTool('preview', { effect: 'read' }),
      canonicalTool('publish', { effect: 'write' }),
    ]);

    expect(registry.tools.map((tool) => tool.name)).toEqual(['report_preview']);
  });

  it('opts into read, write, and destructive tools explicitly', () => {
    const registry = installModelContext();
    registerWebMcpToolsWithPolicy([PRODUCT_DEF, MUTATION_DEF], {
      ...ALLOW_ALL,
      resolveFetchers: () => mockFetchers(),
    });

    expect(registry.tools.map((tool) => tool.name)).toEqual([
      'product_list',
      'product_create',
      'product_publish',
      'product_update',
      'product_delete',
    ]);
  });

  it('classifies legacy CRUD and undeclared custom actions conservatively', () => {
    const registry = installModelContext();
    registerWebMcpToolsWithPolicy([PRODUCT_DEF, MUTATION_DEF], {
      effects: ['write'],
      resolveFetchers: () => mockFetchers(),
    });
    expect(registry.tools.map((tool) => tool.name)).toEqual([
      'product_create',
      'product_update',
    ]);

    clearModelContext();
    const destructiveRegistry = installModelContext();
    registerWebMcpToolsWithPolicy([PRODUCT_DEF, MUTATION_DEF], {
      effects: ['destructive'],
      resolveFetchers: () => mockFetchers(),
    });
    expect(destructiveRegistry.tools.map((tool) => tool.name)).toEqual([
      'product_publish',
      'product_delete',
    ]);
  });

  it('emits complete WebMCP annotations from effect metadata', () => {
    const registry = installModelContext();
    registerWebMcpToolsWithPolicy(
      [
        canonicalTool('get'),
        canonicalTool('create'),
        canonicalTool('update'),
        canonicalTool('delete'),
        canonicalTool('refresh'),
        canonicalTool('publish', { effect: 'write', idempotent: false }),
      ],
      { ...ALLOW_ALL, resolveToolFetchers: () => mockFetchers() },
    );

    const annotations = new Map(
      registry.tools.map((tool) => [tool.name, tool.annotations]),
    );
    expect(annotations.get('report_get')).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      untrustedContentHint: true,
    });
    expect(annotations.get('report_update')).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
      untrustedContentHint: true,
    });
    expect(annotations.get('report_delete')).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
      untrustedContentHint: true,
    });
    expect(annotations.get('report_refresh')).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
      untrustedContentHint: true,
    });
    expect(annotations.get('report_create')).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
      untrustedContentHint: true,
    });
    expect(annotations.get('report_publish')).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
      untrustedContentHint: true,
    });
  });

  it('namespaces selected tools without changing their stable identities', () => {
    const registry = installModelContext();
    registerWebMcpToolsWithPolicy([PRODUCT_DEF], {
      namespace: 'admin',
      resolveFetchers: () => mockFetchers(),
    });
    expect(registry.tools.map((tool) => tool.name)).toEqual([
      'admin_product_list',
    ]);
  });

  it('validates duplicate identities and budgets before any registration', () => {
    const duplicateIdentity = canonicalTool('get', { name: 'report_lookup' });
    const registry = installModelContext();
    expect(() =>
      registerWebMcpToolsWithPolicy([canonicalTool('get'), duplicateIdentity], {
        resolveToolFetchers: () => mockFetchers(),
      }),
    ).toThrow('Duplicate WebMCP tool identity: reports#get');
    expect(registry.tools).toEqual([]);

    expect(() =>
      registerWebMcpToolsWithPolicy([PRODUCT_DEF], {
        ...ALLOW_ALL,
        maxTools: 2,
        resolveFetchers: () => mockFetchers(),
      }),
    ).toThrow('WebMCP tool budget exceeded: 3 tools selected, maximum is 2');
    expect(registry.tools).toEqual([]);
  });

  it('does not impose an implicit budget on whole-manifest read registration', () => {
    const registry = installModelContext();
    const definitions = Array.from({ length: 65 }, (_, index) =>
      canonicalTool('list', {
        collection: `reports_${index}`,
        endpoint: `/reports-${index}`,
        name: `report_${index}_list`,
      }),
    );

    registerWebMcpToolsWithPolicy(definitions, {
      resolveToolFetchers: () => mockFetchers(),
    });

    expect(registry.tools).toHaveLength(65);
  });

  it('rejects invalid exposure policy before resolving fetchers', () => {
    const registry = installModelContext();
    const resolveFetchers = vi.fn(() => mockFetchers());
    expect(() =>
      registerWebMcpToolsWithPolicy([PRODUCT_DEF], {
        namespace: 'unsafe namespace',
        resolveFetchers,
      }),
    ).toThrow('WebMCP namespace');
    expect(registry.tools).toEqual([]);
    expect(resolveFetchers).not.toHaveBeenCalled();
  });

  it('keeps REST authorization as the execution boundary for visible tools', async () => {
    const registry = installModelContext();
    const fetchFn = vi.fn(async () =>
      Promise.resolve({
        ok: false,
        status: 401,
        json: async () => ({ error: 'unauthorized principal' }),
      } as Response),
    ) as unknown as typeof fetch;
    registerWebMcpToolsWithPolicy([PRODUCT_DEF], { fetchFn });

    expect(registry.tools.map((tool) => tool.name)).toEqual(['product_list']);
    await expect(registry.tools[0]?.execute({})).rejects.toMatchObject({
      name: 'SmrtWebRequestError',
      status: 401,
      message: expect.stringContaining('unauthorized principal'),
    });
  });

  it('enforces intrinsic CRUD effects even when input metadata is mislabeled', () => {
    const registry = installModelContext();
    const disguisedCanonicalDelete = canonicalTool('delete', {
      effect: 'read',
      readOnly: true,
    });
    const disguisedLegacyDelete: SmrtWebCollectionDefinition = {
      ...MUTATION_DEF,
      toolDescriptors: [
        {
          ...MUTATION_DEF.toolDescriptors?.[1],
          action: 'delete',
          name: 'product_delete',
          description: 'Delete a product',
          inputSchema: { type: 'object' },
          readOnly: true,
          effect: 'read',
        },
      ],
    };

    registerWebMcpToolsWithPolicy(
      [disguisedCanonicalDelete, disguisedLegacyDelete],
      {
        resolveFetchers: () => mockFetchers(),
        resolveToolFetchers: () => mockFetchers(),
      },
    );
    expect(registry.tools).toEqual([]);
  });

  it('rejects legacy descriptors outside the exposed API action set atomically', () => {
    const registry = installModelContext();
    const widened: SmrtWebCollectionDefinition = {
      ...PRODUCT_DEF,
      actions: ['list'],
    };
    expect(() =>
      registerWebMcpToolsWithPolicy([widened], {
        ...ALLOW_ALL,
        resolveFetchers: () => mockFetchers(),
      }),
    ).toThrow('product_create exposes action create outside products');
    expect(registry.tools).toEqual([]);
  });

  it('fails closed when a canonical-only filter is used with legacy tools', () => {
    const registry = installModelContext();
    const resolveFetchers = vi.fn(() => mockFetchers());
    expect(() =>
      registerWebMcpToolsWithPolicy([PRODUCT_DEF], {
        ...ALLOW_ALL,
        filterTool: () => false,
        resolveFetchers,
      }),
    ).toThrow(
      'legacy WebMCP definitions require filter when filterTool is configured',
    );
    expect(registry.tools).toEqual([]);
    expect(resolveFetchers).not.toHaveBeenCalled();
  });

  it('snapshots dispatch metadata so callers cannot widen a registered read tool', async () => {
    const registry = installModelContext();
    const definition = canonicalTool('list');
    const list = vi.fn(async () => []);
    const remove = vi.fn(async () => true);
    registerWebMcpToolsWithPolicy([definition], {
      resolveToolFetchers: () => ({ list, delete: remove }),
    });

    definition.action = 'delete';
    definition.effect = 'destructive';
    definition.readOnly = false;
    definition.route = { method: 'DELETE', scope: 'item', path: [] };
    await registry.tools[0]?.execute({ id: 'victim' });

    expect(list).toHaveBeenCalledOnce();
    expect(remove).not.toHaveBeenCalled();
  });

  it('isolates legacy filter mutations from the selected dispatch snapshot', async () => {
    const registry = installModelContext();
    const definition: SmrtWebCollectionDefinition = {
      ...PRODUCT_DEF,
      actions: ['list'],
      toolDescriptors: [PRODUCT_DEF.toolDescriptors?.[0] as WebToolDescriptor],
    };
    const list = vi.fn(async () => []);
    const remove = vi.fn(async () => true);

    registerWebMcpToolsWithPolicy([definition], {
      filter: (candidate, descriptor) => {
        candidate.actions[0] = 'delete';
        descriptor.action = 'delete';
        descriptor.effect = 'destructive';
        descriptor.readOnly = false;
        descriptor.route = { method: 'DELETE', scope: 'item', path: [] };
        return true;
      },
      resolveFetchers: () => ({ ...mockFetchers(), list, delete: remove }),
    });

    await registry.tools[0]?.execute({ id: 'victim' });
    expect(registry.tools[0]?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
    expect(list).toHaveBeenCalledOnce();
    expect(remove).not.toHaveBeenCalled();
  });

  it('normalizes every legacy descriptor before exposing collection metadata to filters', () => {
    const registry = installModelContext();
    const definition: SmrtWebCollectionDefinition = {
      ...PRODUCT_DEF,
      actions: ['list'],
      toolDescriptors: [
        {
          ...(PRODUCT_DEF.toolDescriptors?.[0] as WebToolDescriptor),
          effect: 'destructive',
          readOnly: false,
          idempotent: false,
          openWorld: true,
        },
      ],
    };
    const filter = vi.fn((candidate: SmrtWebCollectionDefinition) => {
      expect(candidate.toolDescriptors?.[0]).toMatchObject({
        effect: 'read',
        readOnly: true,
        idempotent: true,
        openWorld: false,
      });
      return true;
    });

    registerWebMcpToolsWithPolicy([definition], {
      filter,
      resolveFetchers: () => mockFetchers(),
    });

    expect(filter).toHaveBeenCalledOnce();
    expect(registry.tools.map((tool) => tool.name)).toEqual(['product_list']);
  });

  it('isolates legacy resolver mutations from the selected dispatch snapshot', async () => {
    const registry = installModelContext();
    const list = vi.fn(async () => []);
    const remove = vi.fn(async () => true);
    const definition: SmrtWebCollectionDefinition = {
      ...PRODUCT_DEF,
      actions: ['list'],
      toolDescriptors: [PRODUCT_DEF.toolDescriptors?.[0] as WebToolDescriptor],
    };

    registerWebMcpToolsWithPolicy([definition], {
      resolveFetchers: (candidate) => {
        candidate.actions[0] = 'delete';
        if (candidate.toolDescriptors?.[0]) {
          candidate.toolDescriptors[0].action = 'delete';
          candidate.toolDescriptors[0].effect = 'destructive';
        }
        return { ...mockFetchers(), list, delete: remove };
      },
    });

    await registry.tools[0]?.execute({ id: 'victim' });
    expect(list).toHaveBeenCalledOnce();
    expect(remove).not.toHaveBeenCalled();
  });

  it('isolates canonical filter mutations from the selected dispatch snapshot', async () => {
    const registry = installModelContext();
    const list = vi.fn(async () => []);
    const remove = vi.fn(async () => true);

    registerWebMcpToolsWithPolicy([canonicalTool('list')], {
      filterTool: (definition) => {
        definition.action = 'delete';
        definition.effect = 'destructive';
        definition.readOnly = false;
        definition.route = { method: 'DELETE', scope: 'item', path: [] };
        return true;
      },
      resolveToolFetchers: () => ({ list, delete: remove }),
    });

    await registry.tools[0]?.execute({ id: 'victim' });
    expect(registry.tools[0]?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
    expect(list).toHaveBeenCalledOnce();
    expect(remove).not.toHaveBeenCalled();
  });

  it('isolates canonical resolver mutations from the selected dispatch snapshot', async () => {
    const registry = installModelContext();
    const list = vi.fn(async () => []);
    const remove = vi.fn(async () => true);
    let resolvedDefinition: WebMcpToolDefinition | undefined;

    registerWebMcpToolsWithPolicy([canonicalTool('list')], {
      namespace: 'admin',
      resolveToolFetchers: (definition) => {
        resolvedDefinition = structuredClone(definition);
        definition.action = 'delete';
        definition.effect = 'destructive';
        definition.readOnly = false;
        definition.route = { method: 'DELETE', scope: 'item', path: [] };
        return { list, delete: remove };
      },
    });

    await registry.tools[0]?.execute({ id: 'victim' });
    expect(resolvedDefinition).toMatchObject({
      name: 'report_list',
      collection: 'reports',
      action: 'list',
    });
    expect(resolvedDefinition).not.toHaveProperty('kind');
    expect(resolvedDefinition).not.toHaveProperty('definition');
    expect(resolvedDefinition).not.toHaveProperty('descriptor');
    expect(resolvedDefinition).not.toHaveProperty('identity');
    expect(registry.tools[0]?.name).toBe('admin_report_list');
    expect(list).toHaveBeenCalledOnce();
    expect(remove).not.toHaveBeenCalled();
  });

  it('snapshots all definitions before an earlier filter can mutate a later one', async () => {
    const registry = installModelContext();
    const first = canonicalTool('get');
    const later = canonicalTool('list', {
      name: 'safe_list',
      collection: 'safe',
      endpoint: '/safe',
      objectRef: 'app:Safe',
    });
    const list = vi.fn(async () => []);
    const remove = vi.fn(async () => true);

    registerWebMcpToolsWithPolicy([first, later], {
      filterTool: (definition) => {
        if (definition.name === first.name) {
          later.action = 'delete';
          later.effect = 'destructive';
          later.readOnly = false;
          later.route = { method: 'DELETE', scope: 'item', path: [] };
        }
        return true;
      },
      resolveToolFetchers: () => ({
        get: vi.fn(async () => ({ id: 'r1' })),
        list,
        delete: remove,
      }),
    });

    const registeredLater = registry.tools.find(
      (tool) => tool.name === 'safe_list',
    );
    await registeredLater?.execute({ id: 'victim' });
    expect(registeredLater?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
    expect(list).toHaveBeenCalledOnce();
    expect(remove).not.toHaveBeenCalled();
  });

  it('rejects invocation through a stale host reference after disposal', () => {
    const registry = installModelContext();
    const dispose = registerWebMcpToolsWithPolicy([PRODUCT_DEF], {
      resolveFetchers: () => mockFetchers(),
    });
    const staleExecute = registry.tools[0]?.execute;
    dispose();

    expect(() => staleExecute?.({})).toThrow(
      'WebMCP tool product_list is no longer registered',
    );
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

  it('filters canonical definitions through the explicit tool predicate', () => {
    const registry = installModelContext();
    registerWebMcpTools(
      [canonicalTool('get'), canonicalTool('refresh', { readOnly: false })],
      {
        resolveToolFetchers: () => ({ get: vi.fn(), custom: vi.fn() }),
        filterTool: (definition) => definition.readOnly,
      },
    );
    expect(registry.tools.map((tool) => tool.name)).toEqual(['report_get']);
  });

  it('fails closed when canonical tools have only the legacy collection filter', () => {
    const registry = installModelContext();
    expect(() =>
      registerWebMcpTools(
        [canonicalTool('get'), canonicalTool('refresh', { readOnly: false })],
        {
          resolveToolFetchers: () => ({ get: vi.fn(), custom: vi.fn() }),
          filter: (_definition, descriptor) => descriptor.readOnly,
        },
      ),
    ).toThrow('require filterTool');
    expect(registry.unregistered).toEqual([]);
    expect(registry.tools).toEqual([]);
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
      actions: [...PRODUCT_DEF.actions, 'preview'],
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
      actions: [...PRODUCT_DEF.actions, 'archive', 'archiveCollection'],
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

  it('executes get-only and custom-action-only canonical tools without collection fetchers', async () => {
    const registry = installModelContext();
    const legacyResolver = vi.fn(() => mockFetchers());
    const get = vi.fn(async (id: string) => ({ data: { id, title: 'One' } }));
    const custom = vi.fn(
      async (_action: string, args: Record<string, unknown>) => ({
        ok: true,
        args,
      }),
    );
    const directResolver = vi.fn(() => ({ get, custom }));

    registerWebMcpTools(
      [canonicalTool('get'), canonicalTool('refresh', { readOnly: false })],
      { resolveFetchers: legacyResolver, resolveToolFetchers: directResolver },
    );

    const got = await registry.tools
      .find((tool) => tool.name === 'report_get')
      ?.execute({ id: 'r1' });
    const refreshed = await registry.tools
      .find((tool) => tool.name === 'report_refresh')
      ?.execute({ force: true });

    expect(legacyResolver).not.toHaveBeenCalled();
    expect(directResolver).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledWith('r1');
    expect(JSON.parse(got as string)).toEqual({ id: 'r1', title: 'One' });
    expect(custom).toHaveBeenCalledWith(
      'refresh',
      { force: true },
      expect.objectContaining({ path: ['refresh'] }),
    );
    expect(JSON.parse(refreshed as string)).toEqual({
      ok: true,
      args: { force: true },
    });
  });

  it('executes canonical CRUD mutations directly and normalizes item envelopes', async () => {
    const registry = installModelContext();
    const create = vi.fn(async (data: Record<string, unknown>) => ({
      data: { id: 'r2', ...data },
    }));
    const update = vi.fn(async (id: string, data: Record<string, unknown>) => ({
      id,
      ...data,
    }));
    const remove = vi.fn(async () => true);
    registerWebMcpTools(
      [
        canonicalTool('create', {
          route: { method: 'POST', scope: 'collection', path: [] },
        }),
        canonicalTool('update', {
          route: { method: 'PUT', scope: 'item', path: [] },
        }),
        canonicalTool('delete', {
          route: { method: 'DELETE', scope: 'item', path: [] },
        }),
      ],
      {
        resolveToolFetchers: () => ({ create, update, delete: remove }),
      },
    );

    const created = await registry.tools
      .find((tool) => tool.name === 'report_create')
      ?.execute({ title: 'Draft' });
    const updated = await registry.tools
      .find((tool) => tool.name === 'report_update')
      ?.execute({ id: 'r2', title: 'Final' });
    const deleted = await registry.tools
      .find((tool) => tool.name === 'report_delete')
      ?.execute({ id: 'r2' });

    expect(create).toHaveBeenCalledWith({ title: 'Draft' });
    expect(update).toHaveBeenCalledWith('r2', { title: 'Final' });
    expect(remove).toHaveBeenCalledWith('r2');
    expect(JSON.parse(created as string)).toEqual({
      id: 'r2',
      title: 'Draft',
    });
    expect(JSON.parse(updated as string)).toEqual({
      id: 'r2',
      title: 'Final',
    });
    expect(JSON.parse(deleted as string)).toEqual({
      success: true,
      id: 'r2',
    });
  });

  it('preserves canonical custom route transport on the default authenticated fetch path', async () => {
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
    registerWebMcpTools(
      [
        canonicalTool('refresh', {
          readOnly: false,
          route: {
            method: 'PATCH',
            scope: 'item',
            path: ['refresh-now'],
          },
        }),
      ],
      { basePath: '/custom-api', fetchFn },
    );

    await registry.tools[0]?.execute({ id: 'r1', force: true });

    expect(calls).toEqual([
      {
        url: '/custom-api/reports/r1/refresh-now',
        init: expect.objectContaining({
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ force: true }),
        }),
      },
    ]);
  });

  it('does not leak options-bag markers into GET routes with dynamic path inputs', async () => {
    const registry = installModelContext();
    const calls: string[] = [];
    const fetchFn = (async (url: string | URL) => {
      calls.push(String(url));
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      } as Response;
    }) as unknown as typeof fetch;
    registerWebMcpTools(
      [
        canonicalTool('preview', {
          readOnly: false,
          route: {
            method: 'GET',
            scope: 'collection',
            path: ['preview', '[batchId]'],
            optionsBag: true,
          },
        }),
      ],
      { basePath: '/custom-api', fetchFn },
    );

    const preview = registry.tools[0];
    await preview?.execute({ batchId: 'b1', options: undefined });
    await preview?.execute({ batchId: 'b1', options: null });
    await preview?.execute({ batchId: 'b1', options: {} });
    await preview?.execute({
      batchId: 'b1',
      options: { format: 'summary' },
    });

    expect(calls).toEqual([
      '/custom-api/reports/preview/b1',
      '/custom-api/reports/preview/b1',
      '/custom-api/reports/preview/b1',
      '/custom-api/reports/preview/b1?format=summary',
    ]);
  });

  it('rejects duplicate tool names before registering anything', () => {
    const registry = installModelContext();
    const legacyFetchers = mockFetchers();
    const directResolver = vi.fn(() => ({ list: vi.fn() }));
    expect(() =>
      registerWebMcpTools(
        [
          canonicalTool('list', {
            collection: 'products',
            className: 'Product',
            objectRef: '@test/smrt-web:Product',
            endpoint: '/products',
            name: 'product_list',
          }),
          PRODUCT_DEF,
        ],
        {
          resolveFetchers: () => legacyFetchers,
          resolveToolFetchers: directResolver,
        },
      ),
    ).toThrow('Duplicate WebMCP tool name: product_list');
    expect(registry.tools).toEqual([]);
    expect(legacyFetchers.list).not.toHaveBeenCalled();
    expect(directResolver).not.toHaveBeenCalled();
  });

  it('invalidates only the mutated canonical collection and its relationship targets', async () => {
    const registry = installModelContext();
    const client = createSmrtWebClient();
    const cleanups: Array<SmrtWebCollection<Record<string, unknown>>> = [];
    const calls = { reports: 0, articles: 0, tags: 0 };
    const materialize = (name: keyof typeof calls) => {
      const collection = createSmrtCollection(
        {
          name,
          className: name,
          endpoint: `/${name}`,
          idField: 'id',
          actions: ['list'],
          fields: {},
        },
        {
          client,
          staleTimeMs: 60_000,
          fetchers: {
            ...mockFetchers(),
            list: async () => {
              calls[name] += 1;
              return [{ id: `${name}-1` }];
            },
          },
        },
      );
      cleanups.push(collection);
      return collection;
    };
    const reports = materialize('reports');
    const articles = materialize('articles');
    const tags = materialize('tags');
    const subscriptions = [reports, articles, tags].map((collection) =>
      collection.subscribeChanges(() => {}),
    );
    await Promise.all([reports.preload(), articles.preload(), tags.preload()]);

    registerWebMcpTools(
      [
        canonicalTool('refresh', {
          readOnly: false,
          relationships: [
            {
              field: 'articleId',
              kind: 'foreignKey',
              relatedCollection: 'articles',
            },
          ],
        }),
      ],
      {
        client,
        resolveToolFetchers: () => ({
          custom: vi.fn(async () => ({ ok: true })),
        }),
      },
    );
    await registry.tools[0]?.execute({});
    await waitFor(() => calls.reports >= 2 && calls.articles >= 2);

    expect(calls.reports).toBeGreaterThanOrEqual(2);
    expect(calls.articles).toBeGreaterThanOrEqual(2);
    expect(calls.tags).toBe(1);
    subscriptions.forEach((subscription) => {
      subscription.unsubscribe();
    });
    await Promise.all(cleanups.map((collection) => collection.cleanup()));
  });

  it('throws SmrtWebRequestError for canonical tool error envelopes', async () => {
    const registry = installModelContext();
    registerWebMcpTools([canonicalTool('refresh', { readOnly: false })], {
      resolveToolFetchers: () => ({
        custom: async () => ({ error: 'refresh denied' }),
      }),
    });

    await expect(registry.tools[0]?.execute({})).rejects.toMatchObject({
      name: 'SmrtWebRequestError',
      message: expect.stringContaining('refresh denied'),
    } satisfies Partial<SmrtWebRequestError>);
  });

  it('rejects structured canonical failures before cache invalidation', async () => {
    const registry = installModelContext();
    const client = createSmrtWebClient();
    registerWebMcpTools([canonicalTool('refresh', { readOnly: false })], {
      client,
      resolveToolFetchers: () => ({
        custom: async () => ({
          error: {
            ok: false,
            code: 'REFRESH_DENIED',
            message: 'refresh denied',
            status: 403,
          },
        }),
      }),
    });

    await expect(registry.tools[0]?.execute({})).rejects.toMatchObject({
      name: 'SmrtWebRequestError',
      message: expect.stringContaining('refresh denied'),
      status: 403,
      code: 'REFRESH_DENIED',
    } satisfies Partial<SmrtWebRequestError>);
  });

  it('validates a shared client before registering canonical writes', () => {
    const registry = installModelContext();
    const invalidClient = {
      __smrtWebClient: 'SmrtWebClient',
      queryClient: {},
    } as SmrtWebClient;
    const resolver = vi.fn(() => ({ custom: vi.fn() }));

    expect(() =>
      registerWebMcpTools([canonicalTool('refresh', { readOnly: false })], {
        client: invalidClient,
        resolveToolFetchers: resolver,
      }),
    ).toThrow('must be a handle from createSmrtWebClient()');
    expect(resolver).not.toHaveBeenCalled();
    expect(registry.tools).toEqual([]);
  });

  it('closes canonical writes over the client validated at registration', async () => {
    const registry = installModelContext();
    const registrationOptions: RegisterWebMcpToolsOptions = {
      client: createSmrtWebClient(),
      resolveToolFetchers: () => ({ custom: async () => ({ ok: true }) }),
    };
    registerWebMcpTools(
      [canonicalTool('refresh', { readOnly: false })],
      registrationOptions,
    );

    registrationOptions.client = {
      __smrtWebClient: 'SmrtWebClient',
    } as SmrtWebClient;

    await expect(registry.tools[0]?.execute({})).resolves.toBe(
      JSON.stringify({ ok: true }),
    );
  });

  it('atomically aborts earlier tools when registration fails', () => {
    const registry = installModelContext();
    let calls = 0;
    const documentRef = (
      globalThis as {
        document?: { modelContext?: { registerTool?: unknown } };
      }
    ).document;
    if (!documentRef?.modelContext)
      throw new Error('modelContext not installed');
    documentRef.modelContext.registerTool = (
      tool: CapturedTool,
      opts?: { signal?: AbortSignal },
    ) => {
      calls += 1;
      if (calls === 2) throw new Error('duplicate host tool');
      registry.tools.push(tool);
      opts?.signal?.addEventListener('abort', () =>
        registry.unregistered.push(tool.name),
      );
    };

    expect(() =>
      registerWebMcpTools(
        [canonicalTool('get'), canonicalTool('refresh', { readOnly: false })],
        { resolveToolFetchers: () => ({ get: vi.fn(), custom: vi.fn() }) },
      ),
    ).toThrow('duplicate host tool');
    expect(registry.unregistered).toEqual(['report_get']);
  });

  it('atomically aborts sibling tools when browser registration rejects', async () => {
    const registry = installModelContext();
    const documentRef = (
      globalThis as {
        document?: { modelContext?: { registerTool?: unknown } };
      }
    ).document;
    if (!documentRef?.modelContext)
      throw new Error('modelContext not installed');
    documentRef.modelContext.registerTool = (
      tool: CapturedTool,
      opts?: { signal?: AbortSignal },
    ) => {
      registry.tools.push(tool);
      opts?.signal?.addEventListener('abort', () =>
        registry.unregistered.push(tool.name),
      );
      return tool.name === 'report_refresh'
        ? Promise.reject(new Error('browser rejected tool'))
        : Promise.resolve();
    };

    const registration = registerWebMcpTools(
      [canonicalTool('get'), canonicalTool('refresh', { readOnly: false })],
      { resolveToolFetchers: () => ({ get: vi.fn(), custom: vi.fn() }) },
    );

    await expect(registration.ready).rejects.toThrow('browser rejected tool');
    expect(registry.unregistered).toEqual(['report_get', 'report_refresh']);
    expect(() => registry.tools[0]?.execute({})).toThrow(
      'WebMCP tool report_get is no longer registered',
    );
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
