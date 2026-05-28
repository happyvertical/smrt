/**
 * SvelteKit mount-helper tests. We stub the McpAppServer so this file is
 * decoupled from the smrt-core integration.
 */

import { describe, expect, it } from 'vitest';
import { McpAccessError } from '../errors.js';
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
  it('returns the wrapped tools shape and honours resolveAuthenticated', async () => {
    let received: boolean | null = null;
    const server = makeServer({
      listTools: async ({ authenticated }) => {
        received = authenticated;
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
      resolveAuthenticated: (event) => event.locals?.flag === true,
    });
    const response = await handler(makeEvent({ locals: { flag: true } }));
    expect(response.status).toBe(200);
    expect(received).toBe(true);
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
      user: { id: 'u-1' },
    });
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
});
