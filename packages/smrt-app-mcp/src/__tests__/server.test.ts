/**
 * `createMcpAppServer` behaviour tests. We stub the MCPGenerator's
 * tool list/call surface via dependency injection on the smrt-core
 * generator module, exercising the allow-list, public-tool, and
 * workflow-assertion paths in isolation.
 */

import { describe, expect, it, vi } from 'vitest';
import { McpAccessError } from '../errors.js';
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
    generateToolsMock.mockResolvedValue([tool('opportunity_list')]);
    const patternRef = { value: [] as string[] };
    const server = createMcpAppServer({
      smrtOptions: () => ({}),
      serverInfo: { name: 'app', version: '0.1.0' },
      allowedClassNames: ['Opportunity'],
      publicToolPatterns: () => patternRef.value,
    });

    expect((await server.listTools({ authenticated: false })).length).toBe(0);

    patternRef.value = ['opportunity_*'];
    expect(
      (await server.listTools({ authenticated: false })).map((t) => t.name),
    ).toEqual(['opportunity_list']);
  });
});
