/**
 * Agent users as first-class MCP principals (#5086). One server, two kinds of
 * caller with different roles: `tools/list` shows each only the tools its live
 * role permissions (bound by the app) intersected with its token scopes allow,
 * on the modern endpoint and the deprecated REST-shaped mounts alike, and a
 * call to a hidden tool is indistinguishable from a call to an unknown one.
 */
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { createInMemoryMcpAuditSink } from '../audit.js';
import { MCP_TOOL_ACCESS_DENIED_CODE, McpAccessError } from '../errors.js';
import type { McpAppPrincipal, McpAppServer } from '../server.js';
import {
  type McpRouteResourceAuth,
  mountMcpAppRoute,
  mountMcpCallRoute,
  mountMcpRoute,
  mountMcpToolsRoute,
  principalFromSessionLocals,
} from '../sveltekit.js';

const TENANT = 'tenant-a';
const TOKEN_SCOPES = ['notes.read', 'notes.write'];

/** Live role permissions per user; mutating it is "revoking a permission". */
function roles() {
  return new Map<string, string[]>([
    ['agent-1', ['notes.read']],
    ['human-1', ['notes.read', 'notes.write']],
  ]);
}

/** A bearer adapter: the token names the user; the kind comes from the user. */
function auth(kinds: Record<string, string>): McpRouteResourceAuth {
  return {
    metadataUrl: 'https://app.example/.well-known/oauth-protected-resource',
    metadataResponse: () => Response.json({}),
    authenticate: async (request) => {
      const id = request.headers.get('authorization')?.replace('Bearer ', '');
      if (!id || !(id in kinds)) {
        return { ok: false, response: new Response(null, { status: 401 }) };
      }
      return {
        ok: true,
        principal: {
          id,
          tenantId: TENANT,
          kind: kinds[id],
          scopes: [...TOKEN_SCOPES],
        },
      };
    },
  };
}

/** The runtime binder's rule: live role permissions cap the token scopes. */
function binder(live: Map<string, string[]>) {
  return async <T>(
    principal: McpAppPrincipal & { id: string },
    run: (bound?: McpAppPrincipal & { id: string }) => Promise<T>,
  ): Promise<T> => {
    const permissions = live.get(principal.id);
    if (!permissions) throw new Error('no active membership');
    return run({
      ...principal,
      scopes: (principal.scopes ?? []).filter((s) => permissions.includes(s)),
    });
  };
}

const KINDS = { 'agent-1': 'agent', 'human-1': 'human' };

function setup(
  overrides: { principalKinds?: readonly string[] } = {
    principalKinds: ['human', 'agent'],
  },
) {
  const live = roles();
  const sink = createInMemoryMcpAuditSink();
  const options = {
    models: [],
    requiredScopes: [],
    ...overrides,
    toolScopes: {
      notes_read: ['notes.read'],
      notes_write: ['notes.write'],
    },
    auditSink: sink,
    smrtOptions: () => ({}),
    workflowTools: ['notes_read', 'notes_write'].map((name) => ({
      name,
      description: name,
      inputSchema: { type: 'object' as const, properties: {} },
      outputSchema: { type: 'object' as const, properties: {} },
      effect: name === 'notes_read' ? ('read' as const) : ('write' as const),
      idempotent: name === 'notes_read',
      openWorld: false,
      execute: () => ({ content: [{ type: 'text' as const, text: name }] }),
    })),
    auth: auth(KINDS),
    bindPrincipal: binder(live),
    checkOrigin: false,
  };
  const modern = mountMcpAppRoute(options);
  const mountOptions = {
    auth: options.auth,
    bindPrincipal: options.bindPrincipal,
  };
  return {
    live,
    sink,
    modern,
    legacyList: mountMcpToolsRoute(modern.server, mountOptions),
    legacyCall: mountMcpCallRoute(modern.server, mountOptions),
  };
}

function rpc(
  token: string,
  method: string,
  params: Record<string, unknown> = {},
) {
  const url = new URL('https://app.example/api/mcp');
  return {
    locals: {},
    url,
    request: new Request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': method,
        authorization: `Bearer ${token}`,
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
            [CLIENT_INFO_META_KEY]: { name: 'agent-test', version: '0' },
            [CLIENT_CAPABILITIES_META_KEY]: {},
          },
        },
      }),
    }),
  };
}

function legacy(token: string, body?: unknown) {
  const url = new URL('https://app.example/api/mcp/tools');
  return {
    locals: {},
    url,
    request: new Request(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  };
}

const listed = async (app: ReturnType<typeof setup>, token: string) =>
  (
    (await (await app.modern(rpc(token, 'tools/list'))).json()).result
      .tools as Array<{ name: string }>
  )
    .map((tool) => tool.name)
    .sort();

const legacyListed = async (app: ReturnType<typeof setup>, token: string) =>
  (
    (await (await app.legacyList(legacy(token))).json()).tools as Array<{
      name: string;
    }>
  )
    .map((tool) => tool.name)
    .sort();

async function modernCall(
  app: ReturnType<typeof setup>,
  token: string,
  name: string,
) {
  const response = await app.modern(
    rpc(token, 'tools/call', { name, arguments: {} }),
  );
  return { status: response.status, body: await response.json() };
}

async function legacyCall(
  app: ReturnType<typeof setup>,
  token: string,
  name: string,
) {
  const response = await app.legacyCall(legacy(token, { name, arguments: {} }));
  return { status: response.status, body: await response.json() };
}

describe('agent users as MCP principals (#5086)', () => {
  it('lists only the tools each role allows, for an agent and a human on one server', async () => {
    const app = setup();
    expect(await listed(app, 'agent-1')).toEqual(['notes_read']);
    expect(await listed(app, 'human-1')).toEqual(['notes_read', 'notes_write']);
    expect(await legacyListed(app, 'agent-1')).toEqual(['notes_read']);
    expect(await legacyListed(app, 'human-1')).toEqual([
      'notes_read',
      'notes_write',
    ]);
  });

  it('accepts the agent kind only when the server is configured for it', async () => {
    const humansOnly = setup({});
    expect(await listed(humansOnly, 'agent-1')).toEqual([]);
    expect(await legacyListed(humansOnly, 'agent-1')).toEqual([]);
    expect(await listed(humansOnly, 'human-1')).toEqual([
      'notes_read',
      'notes_write',
    ]);
    for (const call of [modernCall, legacyCall]) {
      const refused = await call(humansOnly, 'agent-1', 'notes_read');
      const unknown = await call(humansOnly, 'agent-1', 'no_such_tool');
      expect(refused.body).toEqual(unknown.body);
      expect(refused.status).toBe(unknown.status);
    }
  });

  it('refuses a forbidden tool exactly like an unknown tool', async () => {
    const app = setup();
    const forbidden = await modernCall(app, 'agent-1', 'notes_write');
    const unknown = await modernCall(app, 'agent-1', 'no_such_tool');
    expect(forbidden.body.error).toEqual({
      code: -32602,
      message: 'Unknown MCP tool.',
      data: {},
    });
    expect(forbidden.body).toEqual(unknown.body);
    expect(forbidden.status).toBe(unknown.status);

    const legacyForbidden = await legacyCall(app, 'agent-1', 'notes_write');
    const legacyUnknown = await legacyCall(app, 'agent-1', 'no_such_tool');
    expect(legacyForbidden).toEqual(legacyUnknown);
    expect(legacyForbidden.status).toBe(404);

    // The audit trail still tells them apart; the wire does not.
    const codes = app.sink.records.map((record) => [
      record.tool,
      record.errorCode,
    ]);
    expect(codes).toContainEqual(['notes_write', MCP_TOOL_ACCESS_DENIED_CODE]);
    expect(codes).toContainEqual(['no_such_tool', 'mcp_tool_not_found']);

    // An allowed call still runs, and the human may use the write tool.
    expect((await modernCall(app, 'agent-1', 'notes_read')).status).toBe(200);
    expect((await modernCall(app, 'human-1', 'notes_write')).status).toBe(200);
    expect((await legacyCall(app, 'human-1', 'notes_write')).status).toBe(200);
  });

  it('removes a tool from the next list and call once the role permission is revoked', async () => {
    const app = setup();
    expect(await listed(app, 'agent-1')).toEqual(['notes_read']);
    expect((await modernCall(app, 'agent-1', 'notes_read')).status).toBe(200);
    expect((await legacyCall(app, 'agent-1', 'notes_read')).status).toBe(200);

    app.live.set('agent-1', []);
    expect(await listed(app, 'agent-1')).toEqual([]);
    expect(await legacyListed(app, 'agent-1')).toEqual([]);
    const revoked = await modernCall(app, 'agent-1', 'notes_read');
    expect(revoked.body).toEqual(
      (await modernCall(app, 'agent-1', 'no_such_tool')).body,
    );
    expect((await legacyCall(app, 'agent-1', 'notes_read')).status).toBe(404);

    // Granting it back restores the tool on the next request.
    app.live.set('agent-1', ['notes.read']);
    expect(await listed(app, 'agent-1')).toEqual(['notes_read']);
  });

  it('never lets a role grant more than the token scopes', async () => {
    const app = setup();
    app.live.set('agent-1', ['notes.read', 'notes.write', 'notes.admin']);
    // Token scopes are fixed at TOKEN_SCOPES: notes.admin is never added.
    expect(await listed(app, 'agent-1')).toEqual(['notes_read', 'notes_write']);
  });

  it('refuses an unbindable agent on the legacy mounts like the modern one', async () => {
    const app = setup();
    app.live.delete('agent-1');
    const list = await app.legacyList(legacy('agent-1'));
    expect(list.status).toBe(403);
    expect(
      (await app.legacyCall(legacy('agent-1', { name: 'notes_read' }))).status,
    ).toBe(403);
    expect((await app.modern(rpc('agent-1', 'tools/list'))).status).toBe(403);
    // A bad token never reaches dispatch.
    expect((await app.legacyList(legacy('nobody'))).status).toBe(401);
  });
});

describe('session principals carry the user kind', () => {
  const base = {
    user: { id: 'agent-1' },
    tenantId: TENANT,
    permissions: ['notes.read'],
  };
  it('defaults to human, honors the runtime classification, fails closed', () => {
    expect(principalFromSessionLocals({ locals: base })?.kind).toBe('human');
    expect(
      principalFromSessionLocals({
        locals: { ...base, principalKind: 'agent' },
      })?.kind,
    ).toBe('agent');
    expect(
      principalFromSessionLocals({ locals: { ...base, principalKind: null } }),
    ).toBeNull();
    expect(
      principalFromSessionLocals({ locals: { ...base, principalKind: '' } }),
    ).toBeNull();
  });
});

describe('task-capable tools are refused like unknown tools (#5086)', () => {
  it('answers a forbidden task tool and an unknown name identically with the tasks capability', async () => {
    const { MCP_TASKS_EXTENSION } = await import('../protocol.js');
    const refuse = () => {
      throw new McpAccessError(
        404,
        'Unknown MCP tool.',
        {},
        MCP_TOOL_ACCESS_DENIED_CODE,
      );
    };
    const server: McpAppServer = {
      serverInfo: { name: 'app', version: '1' },
      tasksEnabled: true,
      listTools: async () => [],
      callTool: async () => refuse(),
      // The catalog knows the tool, whatever the principal may use.
      isTaskTool: async (name) => name === 'export_notes',
      callTask: async () => refuse(),
      getTask: async () => refuse(),
      updateTask: async () => undefined,
      cancelTask: async () => undefined,
    };
    const handler = mountMcpRoute(server, {
      auth: auth(KINDS),
      bindPrincipal: binder(roles()),
    });
    const send = async (name: string) => {
      const event = rpc('agent-1', 'tools/call', { name, arguments: {} });
      const body = await event.request.json();
      body.params._meta['io.modelcontextprotocol/clientCapabilities'] = {
        extensions: { [MCP_TASKS_EXTENSION]: {} },
      };
      const response = await handler({
        ...event,
        request: new Request(event.url, {
          method: 'POST',
          headers: event.request.headers,
          body: JSON.stringify(body),
        }),
      });
      return { status: response.status, body: await response.json() };
    };
    const forbidden = await send('export_notes');
    const unknown = await send('no_such_tool');
    expect(forbidden.body.error.message).toBe('Unknown MCP tool.');
    expect(forbidden).toEqual(unknown);
  });
});
