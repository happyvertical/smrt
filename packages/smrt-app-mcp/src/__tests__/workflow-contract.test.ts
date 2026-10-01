import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import { MCP_TOOL_ACCESS_DENIED_CODE, McpAccessError } from '../errors.js';
import { createMcpAppServer } from '../server.js';
import { mountMcpCallRoute, mountMcpRoute } from '../sveltekit.js';
import {
  createMcpWorkflowTool,
  type McpWorkflowToolDefinition,
} from '../workflow-tools.js';

const definition: McpWorkflowToolDefinition = {
  name: 'review_apply',
  description: 'Apply review',
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
  effect: 'write',
  idempotent: false,
  openWorld: false,
  execute: () => ({
    content: [{ type: 'text', text: 'ok' }],
    structuredContent: { ok: true },
  }),
};
const principal = { id: 'owner', tenantId: 'tenant-a' };
function app(execute = definition.execute) {
  return createMcpAppServer({
    smrtOptions: () => ({}),
    serverInfo: { name: 'workflow-contract', version: '1' },
    allowedClassNames: [],
    toolPolicy: ({ principal: caller }) =>
      caller?.id === principal.id && caller.tenantId === principal.tenantId,
    workflowTools: [{ ...definition, execute }],
  });
}
const safeFailure = {
  isError: true,
  content: [{ type: 'text', text: 'Workflow execution failed.' }],
  structuredContent: { error: { message: 'Workflow execution failed.' } },
};

describe('authored workflow runtime contract', () => {
  it.each([
    undefined,
    null,
    123,
    true,
    { toString: () => 'valid_name' },
  ])('rejects non-string names: %s', (name) => {
    expect(() =>
      createMcpWorkflowTool({
        ...definition,
        name,
      } as McpWorkflowToolDefinition),
    ).toThrow(/name/);
  });
  it('accepts64 characters and rejects65 or128 rather than renaming authored keys', () => {
    expect(
      createMcpWorkflowTool({ ...definition, name: 'a'.repeat(64) }).tool.name,
    ).toBe('a'.repeat(64));
    for (const length of [65, 128])
      expect(() =>
        createMcpWorkflowTool({ ...definition, name: 'a'.repeat(length) }),
      ).toThrow(/name/);
  });
  it.each([
    'inputSchema',
    'outputSchema',
  ] as const)('requires an object root for %s', (key) => {
    for (const value of [undefined, null, false, 'schema', 1, []]) {
      expect(
        () =>
          createMcpWorkflowTool({
            ...definition,
            [key]: value,
          } as McpWorkflowToolDefinition),
        `${key}: ${String(value)}`,
      ).toThrow(/schema.*object/i);
    }
    expect(createMcpWorkflowTool(definition).tool[key]).toEqual({
      type: 'object',
    });
  });
  it.each([
    ['inputSchema', { type: 'string' }],
    ['inputSchema', { type: 'array' }],
    ['inputSchema', {}],
    ['inputSchema', { type: ['object', 'null'] }],
    ['outputSchema', { type: 'string' }],
    ['outputSchema', { type: 'array' }],
    ['outputSchema', {}],
    ['outputSchema', { type: ['object', 'null'] }],
  ] as const)('requires an MCP object root for %s', (key, schema) => {
    expect(() =>
      createMcpWorkflowTool({ ...definition, [key]: schema }),
    ).toThrow(/schema.*type.*object/i);
  });
  it.each([
    'sync',
    'async',
    'non-error',
  ] as const)('normalizes %s handler failure without exposing private details', async (mode) => {
    const execute = () => {
      if (mode === 'async')
        return Promise.reject(new Error('private account token'));
      throw mode === 'sync'
        ? new Error('private account token')
        : { token: 'private account token' };
    };
    await expect(
      app(execute).callTool({ name: definition.name, principal }),
    ).resolves.toEqual(safeFailure);
  });
  it('preserves success and intentional access errors, and denies before invoking a handler', async () => {
    const execute = vi.fn(definition.execute);
    const server = app(execute);
    await expect(
      server.callTool({ name: definition.name, principal }),
    ).resolves.toMatchObject({ structuredContent: { ok: true } });
    for (const caller of [
      null,
      { id: 'other', tenantId: 'tenant-a' },
      { id: 'owner', tenantId: 'tenant-b' },
    ]) {
      await expect(
        server.callTool({ name: definition.name, principal: caller }),
      ).rejects.toBeInstanceOf(McpAccessError);
    }
    expect(execute).toHaveBeenCalledOnce();
    const denial = new McpAccessError(403, 'access denied', {
      code: MCP_TOOL_ACCESS_DENIED_CODE,
      retryable: false,
    });
    await expect(
      app(() => {
        throw denial;
      }).callTool({ name: definition.name, principal }),
    ).rejects.toBe(denial);
    await expect(
      app(() => Promise.reject(denial)).callTool({
        name: definition.name,
        principal,
      }),
    ).rejects.toBe(denial);
  });
  it('delivers safe failures through stock SDK v2 and keeps access denial a protocol error', async () => {
    let deny = false;
    const server = app(async () => {
      if (deny)
        throw new McpAccessError(403, 'access denied', {
          code: MCP_TOOL_ACCESS_DENIED_CODE,
          retryable: false,
        });
      throw new Error('private account token');
    });
    const handler = mountMcpRoute(server, {
      resolvePrincipal: () => principal,
    });
    const transport = new StreamableHTTPClientTransport(
      new URL('https://example.test/mcp'),
      {
        fetch: async (input, init) => {
          const request =
            input instanceof Request ? input : new Request(input, init);
          return handler({ locals: {}, request, url: new URL(request.url) });
        },
      },
    );
    const client = new Client(
      { name: 'contract', version: '1' },
      { capabilities: {}, versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    try {
      await client.connect(transport);
      await expect(
        client.callTool({ name: definition.name, arguments: {} }),
      ).resolves.toMatchObject(safeFailure);
      deny = true;
      await expect(
        client.callTool({ name: definition.name, arguments: {} }),
      ).rejects.toMatchObject({
        data: { code: MCP_TOOL_ACCESS_DENIED_CODE, retryable: false },
      });
    } finally {
      await client.close();
      await transport.close();
    }
  });
  it('delivers the same safe failure through the REST compatibility mount', async () => {
    const handler = mountMcpCallRoute(
      app(() => {
        throw new Error('private account token');
      }),
      { resolvePrincipal: () => principal },
    );
    const request = new Request('https://example.test/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: definition.name, arguments: {} }),
    });
    const response = await handler({
      locals: {},
      request,
      url: new URL(request.url),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(safeFailure);
  });
});
