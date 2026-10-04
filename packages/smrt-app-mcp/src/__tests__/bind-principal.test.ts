/**
 * Bearer principal binding (#3373 combined review C2). After bearer
 * authentication, every part of MCP dispatch — the `smrtOptions` database
 * thunk, task handling and tool execution — must run inside the context the
 * application binds to that principal, so a request database (for example a
 * PostgreSQL RLS transaction) carries the bearer identity, not the cookie's.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { MCP_TOOL_ACCESS_DENIED_CODE } from '../errors.js';
import { MCP_TASKS_EXTENSION } from '../protocol.js';
import type { McpAppPrincipal, McpAppServer } from '../server.js';
import {
  type McpRouteResourceAuth,
  mountMcpAppRoute,
  mountMcpRoute,
} from '../sveltekit.js';

const bound = new AsyncLocalStorage<string>();
const bearer = {
  id: 'bearer-user',
  tenantId: 'tenant-b',
  kind: 'human',
  scopes: ['items.read'],
};
const cookieLocals = {
  user: { id: 'cookie-user' },
  tenantId: 'tenant-c',
  permissions: ['items.read'],
  sessionId: 'sid',
};

function auth(): McpRouteResourceAuth {
  return {
    metadataUrl:
      'https://app.example/.well-known/oauth-protected-resource/api/mcp',
    metadataResponse: () => Response.json({}),
    authenticate: async () => ({ ok: true, principal: { ...bearer } }),
  };
}

function rpc(
  method: string,
  params: Record<string, unknown> = {},
  meta: Record<string, unknown> = {},
) {
  const url = new URL('https://app.example/api/mcp');
  return {
    locals: cookieLocals,
    url,
    request: new Request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': method,
        authorization: 'Bearer token',
        ...(typeof params.name === 'string' ? { 'mcp-name': params.name } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
            [CLIENT_INFO_META_KEY]: { name: 'bind-test', version: '0' },
            [CLIENT_CAPABILITIES_META_KEY]: {},
            ...meta,
          },
        },
      }),
    }),
  };
}

function binder() {
  const calls: Array<McpAppPrincipal & { id: string }> = [];
  const bindPrincipal = async <T>(
    principal: McpAppPrincipal & { id: string },
    run: () => Promise<T>,
  ): Promise<T> => {
    calls.push(principal);
    return bound.run(`${principal.id}@${principal.tenantId}`, run);
  };
  return { calls, bindPrincipal };
}

function appRoute(options: Record<string, unknown> = {}) {
  const seen = { smrtOptions: [] as unknown[], execute: [] as unknown[] };
  const handler = mountMcpAppRoute({
    models: [],
    requiredScopes: ['items.read'],
    smrtOptions: () => {
      seen.smrtOptions.push(bound.getStore());
      return {};
    },
    workflowTools: [
      {
        name: 'items_overview',
        description: 'Read overview',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: { type: 'object', properties: {} },
        effect: 'read',
        idempotent: true,
        openWorld: false,
        execute: ({ principal }) => {
          seen.execute.push([bound.getStore(), principal?.id]);
          return { content: [{ type: 'text', text: 'ok' }] };
        },
      },
    ],
    auth: auth(),
    ...options,
  });
  return { handler, seen };
}

describe('bindPrincipal', () => {
  it('runs the database thunk and the tool inside the bearer principal binding', async () => {
    const { calls, bindPrincipal } = binder();
    const { handler, seen } = appRoute({ bindPrincipal });
    const response = await handler(
      rpc('tools/call', { name: 'items_overview', arguments: {} }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).result.content).toEqual([
      { type: 'text', text: 'ok' },
    ]);
    expect(calls).toEqual([expect.objectContaining({ id: 'bearer-user' })]);
    expect(seen.smrtOptions.length).toBeGreaterThan(0);
    expect(new Set(seen.smrtOptions)).toEqual(
      new Set(['bearer-user@tenant-b']),
    );
    // The cookie-session user never reaches dispatch.
    expect(seen.execute).toEqual([['bearer-user@tenant-b', 'bearer-user']]);
  });

  it('runs task handling inside the binding', async () => {
    const { bindPrincipal } = binder();
    const taskStores: unknown[] = [];
    const server: McpAppServer = {
      serverInfo: { name: 'app', version: '1' },
      tasksEnabled: true,
      listTools: async () => [],
      callTool: async () => ({ content: [] }),
      isTaskTool: async () => true,
      callTask: async ({ principal }) => {
        taskStores.push([bound.getStore(), principal?.id]);
        return { content: [] };
      },
      getTask: async () => {
        throw new Error('unused');
      },
      updateTask: async () => undefined,
      cancelTask: async () => undefined,
    };
    const handler = mountMcpRoute(server, { auth: auth(), bindPrincipal });
    const response = await handler(
      rpc(
        'tools/call',
        { name: 'items_export', arguments: {} },
        {
          'io.modelcontextprotocol/clientCapabilities': {
            extensions: { [MCP_TASKS_EXTENSION]: {} },
          },
        },
      ),
    );
    expect(response.status).toBe(200);
    expect(taskStores).toEqual([['bearer-user@tenant-b', 'bearer-user']]);
  });

  it('fails closed with the safe denial envelope when the principal cannot be bound', async () => {
    const execute = vi.fn();
    for (const bindPrincipal of [
      async () => {
        throw new Error('no membership for secret-tenant');
      },
      // A binder that never runs dispatch must not be treated as success.
      async () => new Response('bypass'),
    ]) {
      const { handler, seen } = appRoute({ bindPrincipal });
      const response = await handler(
        rpc('tools/call', { name: 'items_overview', arguments: {} }),
      );
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body).toEqual({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32600,
          message: 'MCP tool access is not permitted.',
          data: { code: MCP_TOOL_ACCESS_DENIED_CODE, retryable: false },
        },
      });
      expect(JSON.stringify(body)).not.toContain('secret-tenant');
      expect(seen.execute).toEqual([]);
      expect(seen.smrtOptions).toEqual([]);
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not bind the cookie-session path', async () => {
    const { calls, bindPrincipal } = binder();
    const { handler, seen } = appRoute({ bindPrincipal, auth: () => null });
    const response = await handler(
      rpc('tools/call', { name: 'items_overview', arguments: {} }),
    );
    expect(response.status).toBe(200);
    expect(calls).toEqual([]);
    expect(seen.execute).toEqual([[undefined, 'cookie-user']]);
  });

  it('keeps bearer dispatch unchanged when no binder is configured', async () => {
    const { handler, seen } = appRoute();
    expect(
      (
        await handler(
          rpc('tools/call', { name: 'items_overview', arguments: {} }),
        )
      ).status,
    ).toBe(200);
    expect(seen.execute).toEqual([[undefined, 'bearer-user']]);
  });
});

describe('bindPrincipal effective authority (D1)', () => {
  /** A binder that hands dispatch the principal with live-capped scopes. */
  function effectiveBinder(
    effective: (principal: McpAppPrincipal & { id: string }) => unknown,
  ) {
    return async <T>(
      principal: McpAppPrincipal & { id: string },
      run: (bound?: McpAppPrincipal & { id: string }) => Promise<T>,
    ): Promise<T> =>
      bound.run(`${principal.id}@${principal.tenantId}`, () =>
        run(effective(principal) as McpAppPrincipal & { id: string }),
      );
  }

  it('denies before dispatch when live permissions no longer grant the token scope', async () => {
    const { handler, seen } = appRoute({
      bindPrincipal: effectiveBinder((principal) => ({
        ...principal,
        scopes: [],
      })),
    });
    const list = await (await handler(rpc('tools/list'))).json();
    expect(list.result.tools).toEqual([]);
    const call = await (
      await handler(
        rpc('tools/call', { name: 'items_overview', arguments: {} }),
      )
    ).json();
    expect(call.error).toEqual({
      code: -32600,
      message: 'MCP tool access is not permitted.',
      data: { code: MCP_TOOL_ACCESS_DENIED_CODE, retryable: false },
    });
    expect(seen.execute).toEqual([]);
  });

  it('keeps the tools the remaining live permissions still grant', async () => {
    const { handler, seen } = appRoute({
      bindPrincipal: effectiveBinder((principal) => ({
        ...principal,
        scopes: ['items.read'],
      })),
    });
    const call = await handler(
      rpc('tools/call', { name: 'items_overview', arguments: {} }),
    );
    expect(call.status).toBe(200);
    expect(seen.execute).toEqual([['bearer-user@tenant-b', 'bearer-user']]);
  });

  it('never lets a binder widen scopes or change identity', async () => {
    // Widening: the token only carried items.read, so a broader live set
    // cannot add scopes the token did not grant.
    const widening = appRoute({
      requiredScopes: ['items.write'],
      bindPrincipal: effectiveBinder((principal) => ({
        ...principal,
        scopes: ['items.read', 'items.write'],
      })),
    });
    const widened = await (
      await widening.handler(
        rpc('tools/call', { name: 'items_overview', arguments: {} }),
      )
    ).json();
    expect(widened.error.data.code).toBe(MCP_TOOL_ACCESS_DENIED_CODE);
    expect(widening.seen.execute).toEqual([]);

    for (const effective of [
      (principal: McpAppPrincipal) => ({ ...principal, id: 'someone-else' }),
      (principal: McpAppPrincipal) => ({ ...principal, tenantId: 'other' }),
      (principal: McpAppPrincipal) => ({ ...principal, scopes: 'items.read' }),
    ]) {
      const { handler, seen } = appRoute({
        bindPrincipal: effectiveBinder(effective),
      });
      const response = await handler(
        rpc('tools/call', { name: 'items_overview', arguments: {} }),
      );
      expect(response.status).toBe(403);
      expect((await response.json()).error.data.code).toBe(
        MCP_TOOL_ACCESS_DENIED_CODE,
      );
      expect(seen.execute).toEqual([]);
    }
  });
});
