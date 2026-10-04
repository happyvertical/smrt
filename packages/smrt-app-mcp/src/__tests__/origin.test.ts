/**
 * Origin validation for the modern MCP endpoint (#3373 review H1). A
 * browser on another origin must not reach principal resolution or dispatch
 * with the signed-in user's ambient session.
 */

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { MCP_ORIGIN_DENIED_CODE } from '../errors.js';
import type { McpAppServer } from '../server.js';
import {
  type McpRouteResourceAuth,
  mountMcpAppRoute,
  mountMcpProtectedResourceMetadataRoute,
  mountMcpRoute,
} from '../sveltekit.js';

const APP = 'https://app.example';
const sessionLocals = {
  user: { id: 'owner-1' },
  tenantId: 'tenant-a',
  permissions: ['items.write'],
  sessionId: 'sid',
};

function rpc(
  origin: string | null,
  extraHeaders: Record<string, string> = {},
  url = `${APP}/api/mcp`,
) {
  const request = new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
      'mcp-name': 'items_touch',
      ...(origin === null ? {} : { origin }),
      ...extraHeaders,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'items_touch',
        arguments: {},
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
          [CLIENT_INFO_META_KEY]: { name: 'origin-test', version: '0' },
          [CLIENT_CAPABILITIES_META_KEY]: {},
        },
      },
    }),
  });
  return { locals: sessionLocals, request, url: new URL(url) };
}

function appRoute(options: Record<string, unknown> = {}) {
  const execute = vi.fn(() => ({
    content: [{ type: 'text' as const, text: 'touched' }],
  }));
  const resolvePrincipal = vi.fn(() => ({
    id: 'owner-1',
    tenantId: 'tenant-a',
    kind: 'human',
    scopes: ['items.write'],
  }));
  const handler = mountMcpAppRoute({
    models: [],
    requiredScopes: ['items.write'],
    smrtOptions: () => ({}),
    resolvePrincipal,
    workflowTools: [
      {
        name: 'items_touch',
        description: 'Mutating workflow',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: { type: 'object', properties: {} },
        effect: 'write',
        idempotent: false,
        openWorld: false,
        execute,
      },
    ],
    ...options,
  });
  return { handler, execute, resolvePrincipal };
}

async function expectDenied(response: Response) {
  expect(response.status).toBe(403);
  const body = await response.json();
  expect(body).toEqual({
    jsonrpc: '2.0',
    id: null,
    error: {
      code: -32600,
      message: 'MCP request origin is not permitted.',
      data: { code: MCP_ORIGIN_DENIED_CODE, retryable: false },
    },
  });
  // No hint about which origins are trusted.
  expect(JSON.stringify(body)).not.toContain('app.example');
}

describe('mountMcpAppRoute origin check (default on)', () => {
  it.each([
    ['another site', 'https://evil.example'],
    ['a sibling subdomain', 'https://evil.app.example'],
    ['a parent domain', 'https://example'],
    ['a scheme mismatch', 'http://app.example'],
    ['a port mismatch', 'https://app.example:8443'],
    ['an opaque null origin', 'null'],
    ['a malformed origin', 'not a url'],
    ['an origin with a path', 'https://app.example/evil'],
  ])('refuses %s before principal resolution or dispatch', async (_label, origin) => {
    const { handler, execute, resolvePrincipal } = appRoute();
    await expectDenied(await handler(rpc(origin)));
    expect(resolvePrincipal).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a cross-site fetch metadata signal when Origin is absent', async () => {
    const { handler, execute, resolvePrincipal } = appRoute();
    await expectDenied(
      await handler(rpc(null, { 'sec-fetch-site': 'cross-site' })),
    );
    expect(resolvePrincipal).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ['same origin', APP],
    ['same origin with explicit default port', 'https://APP.example:443'],
    ['no Origin (CLI bridge, server-side clients)', null],
  ])('serves %s', async (_label, origin) => {
    const { handler, execute, resolvePrincipal } = appRoute();
    const response = await handler(rpc(origin));
    expect(response.status).toBe(200);
    expect((await response.json()).result.content).toEqual([
      { type: 'text', text: 'touched' },
    ]);
    expect(resolvePrincipal).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('serves an explicitly trusted origin and nothing broader', async () => {
    const { handler, execute } = appRoute({
      trustedOrigins: ['https://Host.Example:443/'],
    });
    expect((await handler(rpc('https://host.example'))).status).toBe(200);
    expect(execute).toHaveBeenCalledTimes(1);
    await expectDenied(await handler(rpc('https://sub.host.example')));
    await expectDenied(await handler(rpc('http://host.example')));
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed trusted-origin configuration', () => {
    for (const trustedOrigins of [
      ['null'],
      ['*'],
      ['https://host.example/path'],
      ['https://user@host.example'],
      ['ftp://host.example'],
      'https://host.example',
    ]) {
      expect(() => appRoute({ trustedOrigins })).toThrow(TypeError);
    }
  });

  it('can be opted out explicitly', async () => {
    const { handler, execute } = appRoute({ checkOrigin: false });
    expect((await handler(rpc('https://evil.example'))).status).toBe(200);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('checks bearer-authenticated requests too, before authenticating', async () => {
    const authenticate = vi.fn(async () => ({
      ok: true as const,
      principal: {
        id: 'remote',
        tenantId: 'tenant-a',
        kind: 'human',
        scopes: ['items.write'],
      },
    }));
    const auth: McpRouteResourceAuth = {
      metadataUrl: `${APP}/.well-known/oauth-protected-resource/api/mcp`,
      metadataResponse: () => Response.json({}),
      authenticate,
    };
    const { handler, execute } = appRoute({ auth });
    await expectDenied(await handler(rpc('https://evil.example')));
    expect(authenticate).not.toHaveBeenCalled();
    // A server-side remote client sends no Origin and keeps working.
    expect((await handler(rpc(null))).status).toBe(200);
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('mountMcpRoute origin option (off unless set)', () => {
  function stubServer() {
    const listTools = vi.fn(async () => []);
    const callTool = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
    }));
    const server: McpAppServer = {
      serverInfo: { name: 'app', version: '0.1.0' },
      listTools,
      callTool,
    };
    return { server, callTool };
  }

  it('keeps existing call sites unchanged when the option is unset', async () => {
    const { server, callTool } = stubServer();
    const response = await mountMcpRoute(server)(rpc('https://evil.example'));
    expect(response.status).toBe(200);
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('refuses a foreign origin before resolving the principal when enabled', async () => {
    const { server, callTool } = stubServer();
    const resolvePrincipal = vi.fn(() => null);
    const handler = mountMcpRoute(server, {
      checkOrigin: true,
      resolvePrincipal,
    });
    await expectDenied(await handler(rpc('https://evil.example')));
    expect(resolvePrincipal).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
    expect((await handler(rpc(APP))).status).toBe(200);
    expect(callTool).toHaveBeenCalledTimes(1);
  });
});

describe('protected-resource metadata route', () => {
  it('is not origin-checked (public discovery document)', async () => {
    const auth: McpRouteResourceAuth = {
      metadataUrl: `${APP}/.well-known/oauth-protected-resource/api/mcp`,
      metadataResponse: () => Response.json({ resource: `${APP}/api/mcp` }),
      authenticate: async () => ({
        ok: false,
        response: new Response(null, { status: 401 }),
      }),
    };
    const url = new URL(auth.metadataUrl);
    const response = await mountMcpProtectedResourceMetadataRoute(auth)({
      request: new Request(url, {
        headers: { origin: 'https://evil.example' },
      }),
      url,
    });
    expect(response.status).toBe(200);
  });
});
