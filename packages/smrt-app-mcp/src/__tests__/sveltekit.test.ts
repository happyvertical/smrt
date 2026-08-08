/**
 * SvelteKit mount-helper tests. We stub the McpAppServer so this file is
 * decoupled from the smrt-core integration.
 */

import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  SERVER_INFO_META_KEY,
} from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { MCP_TOOL_ACCESS_DENIED_CODE, McpAccessError } from '../errors.js';
import type { McpAppServer } from '../server.js';
import {
  mountMcpCallRoute,
  mountMcpRoute,
  mountMcpToolsRoute,
} from '../sveltekit.js';

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

function makeModernEvent(init: {
  method: string;
  params?: Record<string, unknown>;
  locals?: Record<string, unknown>;
  mcpMethod?: string | null;
  mcpName?: string | null;
}) {
  const params = init.params ?? {};
  const mcpMethod = init.mcpMethod === undefined ? init.method : init.mcpMethod;
  const mcpName =
    init.mcpName === undefined && typeof params.name === 'string'
      ? params.name
      : init.mcpName;
  return makeEvent({
    body: {
      jsonrpc: '2.0',
      id: 1,
      method: init.method,
      params: {
        ...params,
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
          [CLIENT_INFO_META_KEY]: { name: 'sveltekit-test', version: '0.0.0' },
          [CLIENT_CAPABILITIES_META_KEY]: {},
        },
      },
    },
    headers: {
      'content-type': 'application/json',
      'mcp-protocol-version': '2026-07-28',
      ...(mcpMethod === null ? {} : { 'mcp-method': mcpMethod }),
      ...(mcpName === null ? {} : { 'mcp-name': mcpName }),
    },
    locals: init.locals,
    url: 'https://example.com/api/mcp',
  });
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

  it('preserves a positive legacy discovery marker when no principal is available', async () => {
    let discoveryInput: unknown;
    let callInput: unknown;
    const server = makeServer({
      listTools: async (input) => {
        discoveryInput = input;
        return [];
      },
      callTool: async (input) => {
        callInput = input;
        return { content: [] };
      },
    });
    const options = {
      resolveAuthenticated: () => true,
      resolveUser: () => null,
    };

    await mountMcpToolsRoute(server, options)(makeEvent({}));
    await mountMcpCallRoute(
      server,
      options,
    )(makeEvent({ body: { name: 'x' } }));

    // This was the previous tools-route input. Calls remain user-less, as
    // before; apps should migrate to resolvePrincipal for shared identity.
    expect(discoveryInput).toEqual({ authenticated: true });
    expect(callInput).toEqual({ arguments: {}, name: 'x', principal: null });
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

describe('mountMcpRoute', () => {
  it('connects a stock Streamable HTTP client without a session', async () => {
    let requestCount = 0;
    const handler = mountMcpRoute(
      makeServer({
        listTools: async () => [
          {
            name: 'application_list',
            description: 'List applications',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
        callTool: async () => ({
          content: [{ type: 'text', text: 'ok' }],
        }),
      }),
    );
    const transport = new StreamableHTTPClientTransport(
      new URL('https://example.com/api/mcp'),
      {
        fetch: async (input, init) => {
          const request =
            input instanceof Request ? input : new Request(input, init);
          requestCount += 1;
          return handler({
            locals: {},
            request,
            url: new URL(request.url),
          });
        },
      },
    );
    const client = new Client(
      { name: 'stock-client', version: '0.0.0' },
      {
        capabilities: {},
        versionNegotiation: { mode: { pin: '2026-07-28' } },
      },
    );

    try {
      await client.connect(transport);
      expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
      expect(client.getDiscoverResult()).toMatchObject({
        capabilities: { tools: {} },
      });
      expect((await client.listTools()).tools).toMatchObject([
        { name: 'application_list' },
      ]);
      expect(
        await client.callTool({
          name: 'application_list',
          arguments: {},
        }),
      ).toMatchObject({ content: [{ type: 'text', text: 'ok' }] });
      expect(requestCount).toBeGreaterThanOrEqual(3);
    } finally {
      await client.close();
      await transport.close();
    }
  });

  it('serves modern discovery, list, and call requests through the app policy core', async () => {
    let callInput: unknown;
    const handler = mountMcpRoute(
      makeServer({
        listTools: async () => [
          {
            name: 'application_list',
            description: 'List applications',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
        callTool: async (input) => {
          callInput = input;
          return { content: [{ type: 'text', text: 'ok' }] };
        },
      }),
    );

    const discover = await handler(
      makeModernEvent({ method: 'server/discover' }),
    );
    expect(discover.status).toBe(200);
    expect((await discover.json()).result).toMatchObject({
      resultType: 'complete',
      capabilities: { tools: {} },
      _meta: { [SERVER_INFO_META_KEY]: { name: 'app', version: '0.1.0' } },
    });

    const list = await handler(makeModernEvent({ method: 'tools/list' }));
    expect((await list.json()).result).toMatchObject({
      resultType: 'complete',
      tools: [expect.objectContaining({ name: 'application_list' })],
    });

    const call = await handler(
      makeModernEvent({
        method: 'tools/call',
        params: { name: 'application_list', arguments: { limit: 1 } },
      }),
    );
    expect((await call.json()).result).toMatchObject({
      resultType: 'complete',
      content: [{ type: 'text', text: 'ok' }],
    });
    expect(callInput).toEqual({
      name: 'application_list',
      arguments: { limit: 1 },
      principal: null,
    });
  });

  it('rejects missing and mismatched standard headers with HeaderMismatch', async () => {
    const handler = mountMcpRoute(makeServer());
    const requests = [
      makeModernEvent({ method: 'tools/list', mcpMethod: null }),
      makeModernEvent({
        method: 'tools/call',
        params: { name: 'application_list', arguments: {} },
        mcpName: null,
      }),
      makeModernEvent({
        method: 'tools/call',
        params: { name: 'application_list', arguments: {} },
        mcpName: 'different_tool',
      }),
      makeModernEvent({
        method: 'tools/list',
        mcpMethod: 'server/discover',
      }),
    ];

    for (const request of requests) {
      const response = await handler(request);
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe(-32020);
    }
  });

  it('refuses subscriptions without opening an SSE response', async () => {
    const handler = mountMcpRoute(makeServer());

    const response = await handler(
      makeModernEvent({
        method: 'subscriptions/listen',
        params: { notifications: { toolsListChanged: true } },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect((await response.json()).error).toEqual({
      code: -32603,
      message: 'Subscription limit reached',
    });
  });

  it('uses each request principal for anonymous and authenticated policy decisions', async () => {
    const handler = mountMcpRoute(
      makeServer({
        listTools: async ({ principal }) =>
          principal
            ? [
                {
                  name: 'application_list',
                  description: 'List applications',
                  inputSchema: { type: 'object', properties: {} },
                },
                {
                  name: 'application_update',
                  description: 'Update an application',
                  inputSchema: { type: 'object', properties: {} },
                },
              ]
            : [
                {
                  name: 'application_list',
                  description: 'List applications',
                  inputSchema: { type: 'object', properties: {} },
                },
              ],
        callTool: async ({ name, principal }) => {
          if (!principal && name === 'application_update') {
            throw new McpAccessError(404, 'Unknown MCP tool.');
          }
          return { content: [{ type: 'text', text: principal?.id ?? 'anon' }] };
        },
      }),
    );

    const anonymousList = await handler(
      makeModernEvent({ method: 'tools/list' }),
    );
    expect(
      (await anonymousList.json()).result.tools.map(
        (tool: { name: string }) => tool.name,
      ),
    ).toEqual(['application_list']);

    const authenticatedList = await handler(
      makeModernEvent({
        method: 'tools/list',
        locals: { user: { id: 'user-1', kind: 'human' } },
      }),
    );
    expect(
      (await authenticatedList.json()).result.tools.map(
        (tool: { name: string }) => tool.name,
      ),
    ).toEqual(['application_list', 'application_update']);

    const hiddenCall = await handler(
      makeModernEvent({
        method: 'tools/call',
        params: { name: 'application_update', arguments: {} },
      }),
    );
    const hiddenBody = await hiddenCall.json();
    expect(hiddenCall.status).toBe(200);
    expect(hiddenBody.error.code).toBe(-32602);
    expect(JSON.stringify(hiddenBody)).not.toContain('application_update');

    const authenticatedCall = await handler(
      makeModernEvent({
        method: 'tools/call',
        params: { name: 'application_update', arguments: {} },
        locals: { user: { id: 'user-1', kind: 'human' } },
      }),
    );
    expect((await authenticatedCall.json()).result.content).toEqual([
      { type: 'text', text: 'user-1' },
    ]);
  });

  it('keeps repeated requests stateless and never emits an MCP session id', async () => {
    const receivedPrincipals: unknown[] = [];
    const handler = mountMcpRoute(
      makeServer({
        callTool: async ({ principal }) => {
          receivedPrincipals.push(principal);
          return { content: [{ type: 'text', text: principal?.id ?? 'anon' }] };
        },
      }),
    );

    const responses = await Promise.all(
      ['first', 'second', 'first'].map((id) =>
        handler(
          makeModernEvent({
            method: 'tools/call',
            params: { name: 'application_list', arguments: {} },
            locals: { user: { id } },
          }),
        ),
      ),
    );

    expect(receivedPrincipals).toEqual([
      { id: 'first' },
      { id: 'second' },
      { id: 'first' },
    ]);
    expect(
      responses.map((response) =>
        Array.from(response.headers.keys()).filter((header) =>
          header.includes('session'),
        ),
      ),
    ).toEqual([[], [], []]);
  });
});
