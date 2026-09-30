/**
 * `createMcpAppServer` behaviour tests. We stub the MCPGenerator's
 * tool list/call surface via dependency injection on the smrt-core
 * generator module, exercising the allow-list, public-tool, and
 * workflow-assertion paths in isolation.
 */

import { ObjectRegistry } from '@happyvertical/smrt-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MCP_TOOL_ACCESS_DENIED_CODE, McpAccessError } from '../errors.js';
import { createMcpAppServer } from '../server.js';

const generateToolsMock = vi.fn();
const handleToolCallMock = vi.fn();
const supportsTaskToolMock = vi.fn();
const createTaskMock = vi.fn();

vi.mock('@happyvertical/smrt-core/generators/mcp', () => {
  class MCPGenerator {
    async generateTools() {
      return generateToolsMock();
    }
    async handleToolCall(request: unknown) {
      return handleToolCallMock(request);
    }
    async supportsTaskTool(name: string) {
      return supportsTaskToolMock(name);
    }
    async createTask(request: unknown) {
      return createTaskMock(request);
    }
  }
  return {
    MCPGenerator,
    MCP_STABLE_CATALOG_TTL_MS: 86_400_000,
    assertMcpJsonSchemaSafety() {},
    mcpToolAnnotationsFor(
      effect: 'read' | 'write' | 'destructive',
      idempotent: boolean,
      openWorld: boolean,
    ) {
      return {
        readOnlyHint: effect === 'read',
        destructiveHint: effect === 'destructive',
        idempotentHint: idempotent,
        openWorldHint: openWorld,
      };
    },
  };
});

function tool(name: string) {
  return {
    name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
  };
}

describe('createMcpAppServer', () => {
  beforeEach(() => {
    generateToolsMock.mockReset();
    handleToolCallMock.mockReset();
    supportsTaskToolMock.mockReset();
    createTaskMock.mockReset();
  });

  it('filters tools to the allow-listed class prefixes', async () => {
    generateToolsMock.mockResolvedValue([
      tool('opportunity_create'),
      tool('user_list'),
      tool('opportunity_list'),
    ]);

    const server = createMcpAppServer({
      smrtOptions: () => ({}),
      serverInfo: { name: 'app', version: '0.1.0' },
      allowedClassNames: ['Opportunity'],
    });

    const all = await server.listTools({ authenticated: true });
    expect(all.map((t) => t.name)).toEqual([
      'opportunity_create',
      'opportunity_list',
    ]);
  });

  it('composes an authorized workflow catalog with generated tools and preserves portable UI metadata', async () => {
    generateToolsMock.mockResolvedValue([tool('application_get')]);
    const execute = vi.fn(async ({ arguments: args, principal }) => ({
      content: [{ type: 'text' as const, text: 'prepared' }],
      structuredContent: { prepared: args.id, tenantId: principal?.tenantId },
    }));
    const server = createMcpAppServer({
      smrtOptions: () => ({}),
      serverInfo: { name: 'app', version: '0.1.0' },
      allowedClassNames: ['Application'],
      workflowTools: [
        {
          name: 'application_prepare',
          description: 'Prepare an application for review',
          title: 'Prepare application',
          icons: [{ src: 'https://example.test/icon.svg', theme: 'light' }],
          ui: {
            resourceUri: 'ui://application/prepare.html',
            visibility: ['app'],
          },
          metadata: { 'example.extension': { enabled: true } },
          inputSchema: {
            type: 'object',
            properties: { id: { type: 'string' } },
          },
          outputSchema: {
            type: 'object',
            properties: { prepared: { type: 'string' } },
          },
          effect: 'write',
          idempotent: true,
          openWorld: false,
          execute,
        },
      ],
      toolPolicy: ({ principal }) =>
        principal?.id === 'owner-1' && principal.tenantId === 'tenant-a',
    });

    await expect(
      server.listTools({ principal: { id: 'owner-1', tenantId: 'tenant-a' } }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'application_prepare',
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
          _meta: {
            'example.extension': { enabled: true },
            ui: {
              resourceUri: 'ui://application/prepare.html',
              visibility: ['app'],
            },
          },
        }),
      ]),
    );
    await expect(
      server.callTool({
        name: 'application_prepare',
        arguments: { id: 'application-1' },
        principal: { id: 'owner-1', tenantId: 'tenant-a' },
      }),
    ).resolves.toMatchObject({
      structuredContent: { prepared: 'application-1' },
    });
    expect(execute).toHaveBeenCalledWith({
      arguments: { id: 'application-1' },
      principal: { id: 'owner-1', tenantId: 'tenant-a' },
    });
  });

  it('denies guessed workflow calls before their handler when actor or tenant policy rejects them', async () => {
    generateToolsMock.mockResolvedValue([]);
    const execute = vi.fn();
    const server = createMcpAppServer({
      smrtOptions: () => ({}),
      serverInfo: { name: 'app', version: '0.1.0' },
      allowedClassNames: [],
      workflowTools: [
        {
          name: 'application_submit',
          description: 'Submit an application',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          effect: 'write',
          idempotent: false,
          openWorld: false,
          execute,
        },
      ],
      toolPolicy: ({ principal }) =>
        principal?.id === 'owner-1' && principal.tenantId === 'tenant-a',
    });

    await expect(server.listTools({ principal: null })).resolves.toEqual([]);
    await expect(
      server.callTool({
        name: 'application_submit',
        principal: { id: 'owner-1', tenantId: 'tenant-b' },
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects malformed and duplicate authored workflow descriptors', () => {
    const options = {
      smrtOptions: () => ({}),
      serverInfo: { name: 'app', version: '0.1.0' },
      allowedClassNames: [],
    };
    const workflow = {
      name: 'application_prepare',
      description: 'Prepare',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      effect: 'read' as const,
      idempotent: true,
      openWorld: false,
      execute: async () => ({
        content: [{ type: 'text' as const, text: 'ok' }],
      }),
    };
    expect(() =>
      createMcpAppServer({ ...options, workflowTools: [workflow, workflow] }),
    ).toThrow('Duplicate MCP workflow tool name');
    expect(() =>
      createMcpAppServer({
        ...options,
        workflowTools: [{ ...workflow, ui: { resourceUri: 'file:///secret' } }],
      }),
    ).toThrow('must be a credential-free ui: URI');
    expect(() =>
      createMcpAppServer({
        ...options,
        workflowTools: [
          { ...workflow, metadata: { ui: { resourceUri: 'ui://bad' } } },
        ],
      }),
    ).toThrow('metadata.ui is reserved');
    expect(() =>
      createMcpAppServer({
        ...options,
        workflowTools: [{ ...workflow, metadata: { value: 1n } }],
      }),
    ).toThrow('metadata value must be an object');
    expect(() =>
      createMcpAppServer({
        ...options,
        workflowTools: [
          { ...workflow, ui: { visibility: ['app', 'unknown'] as never } },
        ],
      }),
    ).toThrow('contains an unsupported value');
    expect(() =>
      createMcpAppServer({
        ...options,
        workflowTools: [{ ...workflow, ui: { visibility: ['app', 'app'] } }],
      }),
    ).toThrow('must not contain duplicates');
    expect(() =>
      createMcpAppServer({
        ...options,
        workflowTools: [{ ...workflow, ui: { visibility: 'app' as never } }],
      }),
    ).toThrow('must be a non-empty array');
    expect(() =>
      createMcpAppServer({
        ...options,
        workflowTools: [{ ...workflow, ui: {} }],
      }),
    ).toThrow('requires resourceUri or visibility metadata');
    expect(() =>
      createMcpAppServer({
        ...options,
        workflowTools: [
          { ...workflow, ui: Object.create({ visibility: ['app'] }) },
        ],
      }),
    ).toThrow('Workflow tool ui must be an object');
  });

  it('supports inert visibility-only metadata without retaining caller aliases', async () => {
    generateToolsMock.mockResolvedValue([]);
    const visibility: Array<'app' | 'model'> = ['app'];
    const server = createMcpAppServer({
      smrtOptions: () => ({}),
      serverInfo: { name: 'app', version: '0.1.0' },
      allowedClassNames: [],
      workflowTools: [
        {
          name: 'application_lookup',
          description: 'Look up an application',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          effect: 'read',
          idempotent: true,
          openWorld: false,
          execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
        },
        {
          name: 'application_mention',
          description: 'Mention an application',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          effect: 'read',
          idempotent: true,
          openWorld: false,
          ui: { visibility },
          execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
        },
      ],
    });
    visibility.push('model');

    const tools = await server.listTools({ principal: { id: 'owner-1' } });
    expect(
      tools.find((tool) => tool.name === 'application_lookup'),
    ).not.toHaveProperty('_meta');
    expect(
      tools.find((tool) => tool.name === 'application_mention'),
    ).toMatchObject({
      _meta: { ui: { visibility: ['app'] } },
    });
  });

  it('drops mutating tools from the unauthenticated view even if pattern matches', async () => {
    generateToolsMock.mockResolvedValue([
      tool('opportunity_list'),
      tool('opportunity_get'),
      tool('opportunity_create'),
    ]);
    const server = createMcpAppServer({
      smrtOptions: () => ({}),
      serverInfo: { name: 'app', version: '0.1.0' },
      allowedClassNames: ['Opportunity'],
      publicToolPatterns: () => ['opportunity_*'],
    });

    const anon = await server.listTools({ authenticated: false });
    expect(anon.map((t) => t.name).sort()).toEqual([
      'opportunity_get',
      'opportunity_list',
    ]);
  });

  it.each([
    'write',
    'destructive',
  ] as const)('does not expose or execute a canonically %s workflow with a read-like name', async (effect) => {
    generateToolsMock.mockResolvedValue([]);
    const execute = vi.fn();
    const server = createMcpAppServer({
      smrtOptions: () => ({}),
      serverInfo: { name: 'app', version: '0.1.0' },
      allowedClassNames: [],
      publicToolPatterns: () => ['application_*'],
      workflowTools: [
        {
          name: 'application_get',
          description: 'Apply a mutation',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          effect,
          idempotent: false,
          openWorld: false,
          execute,
        },
      ],
    });

    await expect(server.listTools({ principal: null })).resolves.toEqual([]);
    await expect(
      server.callTool({ name: 'application_get', principal: null }),
    ).rejects.toMatchObject({ status: 401 });
    expect(execute).not.toHaveBeenCalled();
  });

  it('never treats an authored workflow alias as a generated task', async () => {
    generateToolsMock.mockResolvedValue([]);
    supportsTaskToolMock.mockResolvedValue(true);
    const server = createMcpAppServer({
      smrtOptions: () => ({}),
      serverInfo: { name: 'app', version: '0.1.0' },
      allowedClassNames: [],
      workflowTools: [
        {
          name: 'excludedprobe_slow',
          description: 'Run the app workflow',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          effect: 'write',
          idempotent: false,
          openWorld: false,
          execute: async () => ({ content: [] }),
        },
      ],
    });

    await expect(server.hasTaskSupport?.()).resolves.toBe(false);
    await expect(server.isTaskTool?.('excludedprobe_slow')).resolves.toBe(
      false,
    );
    await expect(
      server.callTask?.({
        name: 'excludedprobe_slow',
        principal: { id: 'operator-1' },
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(supportsTaskToolMock).not.toHaveBeenCalled();
    expect(createTaskMock).not.toHaveBeenCalled();
  });

  it('applies one principal policy to unauthenticated, human, and scoped-service discovery', async () => {
    generateToolsMock.mockResolvedValue([
      tool('opportunity_get'),
      tool('opportunity_create'),
    ]);
    const policyCalls = vi.fn(({ tool: candidate, principal }) => {
      if (!principal) return candidate.name === 'opportunity_get';
      if (principal.kind === 'human') {
        return principal.roles?.includes('operator') ?? false;
      }
      return (
        principal.kind === 'service' &&
        principal.scopes?.includes('mcp:opportunities:write') === true
      );
    });
    const server = createMcpAppServer({
      smrtOptions: () => ({}),
      serverInfo: { name: 'app', version: '0.1.0' },
      allowedClassNames: ['Opportunity'],
      publicToolPatterns: () => ['opportunity_get'],
      toolPolicy: policyCalls,
    });

    await expect(server.listTools({ principal: null })).resolves.toMatchObject([
      { name: 'opportunity_get' },
    ]);
    await expect(
      server.listTools({
        principal: { id: 'human-1', kind: 'human', roles: ['operator'] },
      }),
    ).resolves.toMatchObject([
      { name: 'opportunity_create' },
      { name: 'opportunity_get' },
    ]);
    await expect(
      server.listTools({
        principal: {
          id: 'service-1',
          kind: 'service',
          scopes: ['mcp:opportunities:read'],
        },
      }),
    ).resolves.toMatchObject([]);
    await expect(
      server.listTools({
        principal: {
          id: 'service-2',
          kind: 'service',
          scopes: ['mcp:opportunities:write'],
        },
      }),
    ).resolves.toMatchObject([
      { name: 'opportunity_create' },
      { name: 'opportunity_get' },
    ]);
    expect(policyCalls).toHaveBeenCalledWith(
      expect.objectContaining({
        principal: null,
        tool: expect.objectContaining({ name: 'opportunity_get' }),
      }),
    );
  });

  it('rejects calls to tools outside the allow-list with 404', async () => {
    generateToolsMock.mockResolvedValue([tool('opportunity_list')]);
    const server = createMcpAppServer({
      smrtOptions: () => ({}),
      serverInfo: { name: 'app', version: '0.1.0' },
      allowedClassNames: ['Opportunity'],
    });

    await expect(
      server.callTool({ name: 'forbidden_tool', user: { id: 'u-1' } }),
    ).rejects.toMatchObject({
      status: 404,
    });
  });

  it('requires authentication for non-public tools', async () => {
    generateToolsMock.mockResolvedValue([tool('opportunity_create')]);
    const server = createMcpAppServer({
      smrtOptions: () => ({}),
      serverInfo: { name: 'app', version: '0.1.0' },
      allowedClassNames: ['Opportunity'],
    });

    await expect(
      server.callTool({ name: 'opportunity_create', user: null }),
    ).rejects.toBeInstanceOf(McpAccessError);
  });

  it('denies a direct call hidden by the principal policy without dispatching it', async () => {
    generateToolsMock.mockResolvedValue([tool('opportunity_create')]);
    const server = createMcpAppServer({
      smrtOptions: () => ({}),
      serverInfo: { name: 'app', version: '0.1.0' },
      allowedClassNames: ['Opportunity'],
      toolPolicy: ({ principal }) =>
        principal?.kind === 'service' &&
        principal.scopes?.includes('mcp:opportunities:write') === true,
    });

    await expect(
      server.callTool({
        name: 'opportunity_create',
        principal: {
          id: 'service-1',
          kind: 'service',
          scopes: ['mcp:opportunities:read'],
        },
      }),
    ).rejects.toMatchObject({
      metadata: {
        code: MCP_TOOL_ACCESS_DENIED_CODE,
        retryable: false,
      },
      status: 403,
    });
    expect(handleToolCallMock).not.toHaveBeenCalled();
  });

  it('fails closed without exposing a thrown policy error', async () => {
    generateToolsMock.mockResolvedValue([tool('opportunity_get')]);
    const server = createMcpAppServer({
      smrtOptions: () => ({}),
      serverInfo: { name: 'app', version: '0.1.0' },
      allowedClassNames: ['Opportunity'],
      publicToolPatterns: () => ['opportunity_get'],
      toolPolicy: () => {
        throw new Error('service credential was unavailable');
      },
    });

    await expect(
      server.callTool({ name: 'opportunity_get', principal: null }),
    ).rejects.toMatchObject({
      message: 'MCP tool access is not permitted.',
      metadata: { code: MCP_TOOL_ACCESS_DENIED_CODE, retryable: false },
      status: 403,
    });
  });

  it('runs workflow assertions and lets them inject server-trusted args', async () => {
    generateToolsMock.mockResolvedValue([tool('application_update')]);
    handleToolCallMock.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
    });

    const server = createMcpAppServer({
      smrtOptions: () => ({}),
      serverInfo: { name: 'app', version: '0.1.0' },
      allowedClassNames: ['Application'],
      workflowAssertions: {
        application_update: (args, user) => {
          if (!user?.id) throw new McpAccessError(403, 'user required');
          args.approvedByUserId = user.id;
        },
      },
    });

    // Unauthenticated callers are rejected before the workflow assertion
    // runs — the package-level auth check is the first gate.
    await expect(
      server.callTool({
        name: 'application_update',
        arguments: { status: 'submitted' },
        user: null,
      }),
    ).rejects.toMatchObject({ status: 401 });

    const argsCarried: Record<string, unknown> = { status: 'submitted' };
    await server.callTool({
      name: 'application_update',
      arguments: argsCarried,
      user: { id: 'user-1' },
    });
    expect(argsCarried.approvedByUserId).toBe('user-1');
    expect(handleToolCallMock).toHaveBeenCalledWith({
      method: 'tools/call',
      params: {
        arguments: { status: 'submitted', approvedByUserId: 'user-1' },
        name: 'application_update',
      },
    });
  });

  it('reads public patterns lazily so env stubbing in tests works', async () => {
    generateToolsMock.mockResolvedValue([
      tool('opportunity_list'),
      tool('opportunity_get'),
    ]);
    const patternRef = { value: [] as string[] };
    const publicToolPatterns = vi.fn(() => patternRef.value);
    const server = createMcpAppServer({
      smrtOptions: () => ({}),
      serverInfo: { name: 'app', version: '0.1.0' },
      allowedClassNames: ['Opportunity'],
      publicToolPatterns,
    });

    expect((await server.listTools({ authenticated: false })).length).toBe(0);
    expect(publicToolPatterns).toHaveBeenCalledTimes(1);

    patternRef.value = ['opportunity_*'];
    expect(
      (await server.listTools({ authenticated: false })).map((t) => t.name),
    ).toEqual(['opportunity_get', 'opportunity_list']);
    expect(publicToolPatterns).toHaveBeenCalledTimes(2);
  });

  it('keeps tool catalogs private unless every tool explicitly opts into a safe public catalog', async () => {
    generateToolsMock.mockResolvedValue([
      tool('opportunity_list'),
      tool('opportunity_get'),
    ]);
    const defaultServer = createMcpAppServer({
      smrtOptions: () => ({}),
      serverInfo: { name: 'app', version: '0.1.0' },
      allowedClassNames: ['Opportunity'],
      publicToolPatterns: () => ['opportunity_*'],
    });
    await expect(defaultServer.getToolsListCacheHint?.()).resolves.toEqual({
      ttlMs: 86_400_000,
      cacheScope: 'private',
    });

    const publicServer = createMcpAppServer({
      smrtOptions: () => ({}),
      serverInfo: { name: 'app', version: '0.1.0' },
      allowedClassNames: ['Opportunity'],
      publicToolPatterns: () => ['opportunity_*'],
      toolListCache: { cacheScope: 'public', publicCatalog: true },
    });
    await expect(publicServer.getToolsListCacheHint?.()).resolves.toEqual({
      ttlMs: 86_400_000,
      cacheScope: 'public',
    });

    generateToolsMock.mockResolvedValue([
      tool('opportunity_list'),
      tool('opportunity_create'),
    ]);
    const mixedServer = createMcpAppServer({
      smrtOptions: () => ({}),
      serverInfo: { name: 'app', version: '0.1.0' },
      allowedClassNames: ['Opportunity'],
      publicToolPatterns: () => ['opportunity_*'],
      toolListCache: { cacheScope: 'public', publicCatalog: true },
    });
    await expect(mixedServer.getToolsListCacheHint?.()).resolves.toMatchObject({
      cacheScope: 'private',
    });
  });

  it('keeps explicitly public catalogs private when a registered tool is tenant-scoped', async () => {
    generateToolsMock.mockResolvedValue([tool('CacheMetadataTenant_list')]);
    const allClasses = vi
      .spyOn(ObjectRegistry, 'getAllClasses')
      .mockReturnValue(
        new Map([
          ['CacheMetadataTenant', { name: 'CacheMetadataTenant' }],
        ]) as ReturnType<typeof ObjectRegistry.getAllClasses>,
      );
    const isTenantScoped = vi
      .spyOn(ObjectRegistry, 'isTenantScoped')
      .mockReturnValue(true);
    const server = createMcpAppServer({
      smrtOptions: () => ({}),
      serverInfo: { name: 'app', version: '0.1.0' },
      allowedClassNames: ['CacheMetadataTenant'],
      publicToolPatterns: () => ['CacheMetadataTenant_*'],
      toolListCache: { cacheScope: 'public', publicCatalog: true },
    });

    try {
      await expect(server.getToolsListCacheHint?.()).resolves.toMatchObject({
        cacheScope: 'private',
      });
    } finally {
      allClasses.mockRestore();
      isTenantScoped.mockRestore();
    }
  });
});
