/**
 * SvelteKit mount-helper tests. We stub the McpAppServer so this file is
 * decoupled from the smrt-core integration.
 */

import { describe, expect, it } from 'vitest';
import { MCP_TOOL_ACCESS_DENIED_CODE, McpAccessError } from '../errors.js';
import type { McpAppServer } from '../server.js';
import { mountMcpCallRoute, mountMcpToolsRoute } from '../sveltekit.js';

function makeEvent(init: {
  body?: unknown;
  locals?: Record<string, unknown>;
  url?: string;
  headers?: Record<string, string>;
}) {
  const url = new URL(init.url ?? 'https://example.com/api/mcp/call');
  return {
    locals: init.locals ?? {},
    request: new Request(url.toString(), {
      method: 'POST',
      headers: init.headers ?? {},
      body: init.body === undefined ? null : JSON.stringify(init.body),
    }),
    url,
  };
}

function makeServer(overrides: Partial<McpAppServer> = {}): McpAppServer {
  return {
    serverInfo: { name: 'app', version: '0.1.0' },
    listTools: overrides.listTools ?? (async () => []),
    callTool:
      overrides.callTool ??
      (async () => ({ content: [{ type: 'text' as const, text: 'ok' }] })),
  };
}

describe('mountMcpToolsRoute', () => {
  it('returns the wrapped tools shape and resolves a principal', async () => {
    let received: unknown = null;
    const server = makeServer({
      listTools: async ({ principal }) => {
        received = principal;
        return [
          {
            name: 'a',
            description: 'a',
            inputSchema: { type: 'object', properties: {} },
          },
        ];
      },
    });
    const handler = mountMcpToolsRoute(server, {
      resolvePrincipal: (event) =>
        event.locals?.principal as { id: string; kind: string },
    });
    const principal = { id: 'service-1', kind: 'service' };
    const response = await handler(makeEvent({ locals: { principal } }));
    expect(response.status).toBe(200);
    expect(received).toBe(principal);
    expect(await response.json()).toEqual({
      tools: [
        {
          name: 'a',
          description: 'a',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    });
  });

  it('keeps the legacy authentication gate without splitting route principals', async () => {
    let discoveredPrincipal: unknown;
    let calledPrincipal: unknown;
    const principal = { id: 'u-1', kind: 'human' };
    const server = makeServer({
      listTools: async ({ principal: received }) => {
        discoveredPrincipal = received;
        return [];
      },
      callTool: async ({ principal: received }) => {
        calledPrincipal = received;
        return { content: [] };
      },
    });
    const options = {
      resolveAuthenticated: () => false,
      resolveUser: () => principal,
    };

    await mountMcpToolsRoute(server, options)(makeEvent({}));
    await mountMcpCallRoute(
      server,
      options,
    )(makeEvent({ body: { name: 'x' } }));

    expect(discoveredPrincipal).toBeNull();
    expect(calledPrincipal).toBeNull();
  });

  it('maps McpAccessError onto the right status code', async () => {
    const server = makeServer({
      listTools: async () => {
        throw new McpAccessError(403, 'nope');
      },
    });
    const response = await mountMcpToolsRoute(server)(makeEvent({}));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'nope' });
  });
});

describe('mountMcpCallRoute', () => {
  it('rejects requests without a tool name', async () => {
    const handler = mountMcpCallRoute(makeServer());
    const response = await handler(makeEvent({ body: {} }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'name is required.' });
  });

  it('forwards name, arguments, and resolved user into callTool', async () => {
    let received: unknown = null;
    const server = makeServer({
      callTool: async (input) => {
        received = input;
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    });
    const handler = mountMcpCallRoute(server);
    await handler(
      makeEvent({
        body: { name: 'x', arguments: { foo: 1 } },
        locals: { user: { id: 'u-1' } },
      }),
    );
    expect(received).toEqual({
      arguments: { foo: 1 },
      name: 'x',
      principal: { id: 'u-1' },
    });
  });

  it('uses the same resolved principal shape for discovery and direct calls', async () => {
    let discoveredPrincipal: unknown = null;
    let calledPrincipal: unknown = null;
    const principal = {
      id: 'service-1',
      kind: 'service',
      scopes: ['mcp:opportunities:write'],
    };
    const server = makeServer({
      listTools: async ({ principal: received }) => {
        discoveredPrincipal = received;
        return [];
      },
      callTool: async ({ principal: received }) => {
        calledPrincipal = received;
        return { content: [] };
      },
    });
    const options = {
      resolvePrincipal: () => principal,
    };

    await mountMcpToolsRoute(server, options)(makeEvent({}));
    await mountMcpCallRoute(
      server,
      options,
    )(makeEvent({ body: { name: 'x' } }));

    expect(discoveredPrincipal).toBe(principal);
    expect(calledPrincipal).toBe(principal);
  });

  it('translates McpAccessError thrown from callTool', async () => {
    const server = makeServer({
      callTool: async () => {
        throw new McpAccessError(401, 'auth required');
      },
    });
    const response = await mountMcpCallRoute(server)(
      makeEvent({ body: { name: 'x' } }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'auth required' });
  });

  it('returns the shared safe failure envelope for policy denials', async () => {
    const server = makeServer({
      callTool: async () => {
        throw new McpAccessError(403, 'MCP tool access is not permitted.', {
          code: MCP_TOOL_ACCESS_DENIED_CODE,
          retryable: false,
        });
      },
    });

    const response = await mountMcpCallRoute(server)(
      makeEvent({ body: { name: 'x' } }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        ok: false,
        code: MCP_TOOL_ACCESS_DENIED_CODE,
        message: 'MCP tool access is not permitted.',
        status: 403,
        retryable: false,
      },
    });
  });
});
