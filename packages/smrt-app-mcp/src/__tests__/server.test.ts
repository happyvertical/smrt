/**
 * `createMcpAppServer` behaviour tests. We stub the MCPGenerator's
 * tool list/call surface via dependency injection on the smrt-core
 * generator module, exercising the allow-list, public-tool, and
 * workflow-assertion paths in isolation.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MCP_TOOL_ACCESS_DENIED_CODE, McpAccessError } from '../errors.js';
import { createMcpAppServer } from '../server.js';

const generateToolsMock = vi.fn();
const handleToolCallMock = vi.fn();

vi.mock('@happyvertical/smrt-core/generators/mcp', () => {
  class MCPGenerator {
    async generateTools() {
      return generateToolsMock();
    }
    async handleToolCall(request: unknown) {
      return handleToolCallMock(request);
    }
  }
  return { MCPGenerator };
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
  });

  it('filters tools to the allow-listed class prefixes', async () => {
    generateToolsMock.mockResolvedValue([
      tool('opportunity_list'),
      tool('opportunity_create'),
      tool('user_list'),
    ]);

    const server = createMcpAppServer({
      smrtOptions: () => ({}),
      serverInfo: { name: 'app', version: '0.1.0' },
      allowedClassNames: ['Opportunity'],
    });

    const all = await server.listTools({ authenticated: true });
    expect(all.map((t) => t.name)).toEqual([
      'opportunity_list',
      'opportunity_create',
    ]);
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
      { name: 'opportunity_get' },
      { name: 'opportunity_create' },
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
      { name: 'opportunity_get' },
      { name: 'opportunity_create' },
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
    ).toEqual(['opportunity_list', 'opportunity_get']);
    expect(publicToolPatterns).toHaveBeenCalledTimes(2);
  });
});
