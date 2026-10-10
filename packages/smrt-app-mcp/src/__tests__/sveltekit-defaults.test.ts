/**
 * One-call app MCP route (#3373): real `@smrt()` models on SQLite, served
 * through `mountMcpAppRoute` over the SDK v2 wire. Covers the
 * actor × tool × tenant matrix the template overlay relied on and checks that
 * the defaults never widen it.
 */

import { createServer } from 'node:http';
import {
  getTestDatabase,
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMcpResourceAuth } from '../auth.js';
import { MCP_TOOL_ACCESS_DENIED_CODE } from '../errors.js';
import {
  type McpRouteResourceAuth,
  mountMcpAppRoute,
  mountMcpProtectedResourceMetadataRoute,
  principalFromSessionLocals,
} from '../sveltekit.js';

// `api.public: 'read'` lets core's own generator gate serve anonymous reads
// once this package's policy has deliberately published a read tool.
@smrt({
  api: { public: 'read' },
  mcp: { include: ['list', 'get', 'create'] },
})
class LaneRouteItem extends SmrtObject {
  title: string = '';
}
class LaneRouteItemCollection extends SmrtCollection<LaneRouteItem> {
  static readonly _itemClass = LaneRouteItem;
}

/** Registered alongside the app model but never declared in `models`. */
@smrt({ mcp: { include: ['list', 'create'] } })
class LaneRouteSecret extends SmrtObject {
  note: string = '';
}
class LaneRouteSecretCollection extends SmrtCollection<LaneRouteSecret> {
  static readonly _itemClass = LaneRouteSecret;
}

let db: Awaited<ReturnType<typeof getTestDatabase>>;
beforeAll(async () => {
  ObjectRegistry.registerCollection('LaneRouteItem', LaneRouteItemCollection);
  ObjectRegistry.registerCollection(
    'LaneRouteSecret',
    LaneRouteSecretCollection,
  );
  db = await getTestDatabase({ classes: ['LaneRouteItem', 'LaneRouteSecret'] });
});
afterAll(async () => {
  await db?.close?.();
});

const ownerLocals = {
  user: { id: 'owner-1', email: 'owner@example.test' },
  tenantId: 'tenant-a',
  permissions: ['items.read', 'items.create'],
  sessionId: 'sid-1',
};
const scopelessLocals = { ...ownerLocals, permissions: [] as string[] };
const otherTenantLocals = {
  ...ownerLocals,
  user: { id: 'member-b' },
  tenantId: 'tenant-b',
  // A URL-selected tenant candidate must never become authority.
  selectedTenantId: 'tenant-a',
};

function rpc(init: {
  method: string;
  params?: Record<string, unknown>;
  locals?: Record<string, unknown>;
  headers?: Record<string, string>;
  rawBody?: string;
  url?: string;
}) {
  const params = init.params ?? {};
  const url = new URL(init.url ?? 'https://app.example/api/mcp');
  const body =
    init.rawBody ??
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: init.method,
      params: {
        ...params,
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
          [CLIENT_INFO_META_KEY]: { name: 'lane-3373', version: '0.0.0' },
          [CLIENT_CAPABILITIES_META_KEY]: {},
        },
      },
    });
  return {
    locals: init.locals ?? {},
    url,
    request: new Request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': init.method,
        ...(typeof params.name === 'string' ? { 'mcp-name': params.name } : {}),
        ...(typeof params.uri === 'string' ? { 'mcp-name': params.uri } : {}),
        ...init.headers,
      },
      body,
    }),
  };
}

function route(
  overrides: Partial<Parameters<typeof mountMcpAppRoute>[0]> = {},
) {
  return mountMcpAppRoute({
    models: [LaneRouteItem],
    requiredScopes: ['items.read'],
    smrtOptions: () => ({ db }),
    ...overrides,
  });
}

async function toolNames(
  handler: ReturnType<typeof route>,
  locals: Record<string, unknown>,
) {
  const response = await handler(rpc({ method: 'tools/list', locals }));
  expect(response.status).toBe(200);
  const body = await response.json();
  return (body.result.tools as Array<{ name: string }>).map(({ name }) => name);
}

async function call(
  handler: ReturnType<typeof route>,
  name: string,
  locals: Record<string, unknown>,
  args: Record<string, unknown> = {},
) {
  const response = await handler(
    rpc({ method: 'tools/call', params: { name, arguments: args }, locals }),
  );
  return { response, body: await response.json() };
}

async function rowCount(table: 'lane_route_items' | 'lane_route_secrets') {
  const result = await db.query(`SELECT COUNT(*) AS n FROM ${table}`);
  return Number(result.rows[0].n);
}

describe('principalFromSessionLocals', () => {
  it('projects only session-authorized user, tenant and permissions', () => {
    expect(
      principalFromSessionLocals({
        locals: { ...ownerLocals, permissions: ['z.b', 'items.read'] },
      }),
    ).toEqual({
      id: 'owner-1',
      tenantId: 'tenant-a',
      kind: 'human',
      scopes: ['items.read', 'z.b'],
    });
    expect(principalFromSessionLocals({ locals: otherTenantLocals })).toEqual(
      expect.objectContaining({ tenantId: 'tenant-b' }),
    );
  });

  it.each([
    ['no locals', undefined],
    ['anonymous session', { user: null, tenantId: null, permissions: [] }],
    ['no tenant', { ...ownerLocals, tenantId: null }],
    ['empty tenant', { ...ownerLocals, tenantId: '' }],
    ['numeric user id', { ...ownerLocals, user: { id: 7 } }],
    ['empty user id', { ...ownerLocals, user: { id: '' } }],
    ['permissions not an array', { ...ownerLocals, permissions: 'items.read' }],
    ['mixed permissions', { ...ownerLocals, permissions: ['items.read', 1] }],
    [
      'only a URL-selected tenant',
      { ...ownerLocals, tenantId: null, selectedTenantId: 'tenant-a' },
    ],
  ])('fails closed for %s', (_label, locals) => {
    expect(
      principalFromSessionLocals({
        locals: locals as Record<string, unknown> | undefined,
      }),
    ).toBeNull();
  });
});

describe('mountMcpAppRoute', () => {
  it('publishes only the declared models to an authorized owner', async () => {
    const handler = route();
    const names = await toolNames(handler, ownerLocals);
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((name) => name.startsWith('laneroute'))).toBe(true);
    expect(names.some((name) => name.includes('secret'))).toBe(false);
    expect(names).toEqual(
      expect.arrayContaining([
        'lanerouteitem_create',
        'lanerouteitem_get',
        'lanerouteitem_list',
      ]),
    );
    expect(handler.server.serverInfo).toEqual({
      name: 'smrt-app',
      version: '0.1.0',
    });
  });

  it('returns not-found for a registered tool outside the allow-list, without dispatch', async () => {
    // The tool exists in the generated catalog; only the allow-list hides it.
    const declared = route({ models: [LaneRouteSecret] });
    expect(await toolNames(declared, ownerLocals)).toContain(
      'laneroutesecret_create',
    );
    const before = await rowCount('lane_route_secrets');
    const { response, body } = await call(
      route(),
      'laneroutesecret_create',
      ownerLocals,
      { note: 'leak' },
    );
    expect(response.status).toBe(200);
    expect(body.error).toMatchObject({
      code: -32602,
      message: 'Unknown MCP tool.',
    });
    expect(await rowCount('lane_route_secrets')).toBe(before);
  });

  it('shows anonymous callers nothing by default and rejects their mutations', async () => {
    const handler = route();
    expect(await toolNames(handler, {})).toEqual([]);
    const before = await rowCount('lane_route_items');
    const { body } = await call(
      handler,
      'lanerouteitem_create',
      {},
      {
        title: 'anon',
      },
    );
    expect(body.error).toMatchObject({ code: -32600 });
    expect(body.error.message).toContain('Authentication is required');
    expect(await rowCount('lane_route_items')).toBe(before);
  });

  it('lets anonymous callers see only public read-only tools', async () => {
    const handler = route({
      // A pattern that also matches the mutating tool must not expose it.
      publicToolPatterns: () => ['lanerouteitem_*'],
    });
    const names = await toolNames(handler, {});
    expect(names).toEqual(['lanerouteitem_get', 'lanerouteitem_list']);
    const list = await call(handler, 'lanerouteitem_list', {});
    expect(list.body.result.isError).not.toBe(true);
    const create = await call(
      handler,
      'lanerouteitem_create',
      {},
      {
        title: 'anon',
      },
    );
    expect(create.body.error).toMatchObject({ code: -32600 });
  });

  it('lets an authorized owner mutate and read back through the same policy', async () => {
    const handler = route();
    const before = await rowCount('lane_route_items');
    const created = await call(handler, 'lanerouteitem_create', ownerLocals, {
      title: 'Owner item',
    });
    expect(created.body.error).toBeUndefined();
    expect(created.body.result.isError).not.toBe(true);
    expect(await rowCount('lane_route_items')).toBe(before + 1);
    const listed = await call(handler, 'lanerouteitem_list', ownerLocals);
    expect(JSON.stringify(listed.body.result)).toContain('Owner item');
  });

  it('hides tools from an authenticated principal without the required scope and denies direct calls with the safe envelope', async () => {
    const handler = route();
    expect(await toolNames(handler, scopelessLocals)).toEqual([]);
    const before = await rowCount('lane_route_items');
    const { body } = await call(
      handler,
      'lanerouteitem_create',
      scopelessLocals,
      {
        title: 'nope',
      },
    );
    expect(body.error).toEqual({
      code: -32600,
      message: 'MCP tool access is not permitted.',
      data: { code: MCP_TOOL_ACCESS_DENIED_CODE, retryable: false },
    });
    expect(await rowCount('lane_route_items')).toBe(before);
  });

  it('binds a principal from another tenant to its own session tenant, never a selected tenant or header', async () => {
    const seen: unknown[] = [];
    const resourceUri = 'ui://lane/v1/tenant-a.html';
    const handler = route({
      workflowTools: [
        {
          name: 'lane_whoami',
          description: 'Echo the trusted principal tenant',
          inputSchema: { type: 'object', properties: {} },
          outputSchema: {
            type: 'object',
            properties: { tenantId: { type: 'string' } },
          },
          effect: 'read',
          idempotent: true,
          openWorld: false,
          ui: { resourceUri },
          execute: ({ principal }) => {
            seen.push(principal?.tenantId);
            return {
              content: [{ type: 'text', text: String(principal?.tenantId) }],
              structuredContent: { tenantId: String(principal?.tenantId) },
            };
          },
        },
      ],
      resources: [
        {
          uri: resourceUri,
          version: 'v1',
          name: 'Tenant A view',
          html: '<title>Tenant A</title>',
        },
      ],
      // Narrowing policy: this view belongs to tenant A only.
      resourcePolicy: ({ principal }) => principal?.tenantId === 'tenant-a',
    });
    const response = await handler(
      rpc({
        method: 'tools/call',
        params: { name: 'lane_whoami', arguments: { tenantId: 'tenant-a' } },
        locals: otherTenantLocals,
        headers: { 'x-tenant-id': 'tenant-a' },
      }),
    );
    expect((await response.json()).result.structuredContent).toEqual({
      tenantId: 'tenant-b',
    });
    expect(seen).toEqual(['tenant-b']);

    const listB = await handler(
      rpc({ method: 'resources/list', locals: otherTenantLocals }),
    );
    expect((await listB.json()).result.resources).toEqual([]);
    const readB = await handler(
      rpc({
        method: 'resources/read',
        params: { uri: resourceUri },
        locals: otherTenantLocals,
      }),
    );
    expect((await readB.json()).error).toMatchObject({
      message: 'MCP resource is not available.',
    });
    const listA = await handler(
      rpc({ method: 'resources/list', locals: ownerLocals }),
    );
    expect((await listA.json()).result.resources).toHaveLength(1);
  });

  it('lets application policy narrow but never widen the default', async () => {
    const widening = route({ toolPolicy: () => true });
    expect(await toolNames(widening, scopelessLocals)).toEqual([]);
    expect(await toolNames(widening, {})).toEqual([]);

    const narrowing = route({
      toolPolicy: ({ tool }) => !tool.name.endsWith('_create'),
    });
    expect(await toolNames(narrowing, ownerLocals)).not.toContain(
      'lanerouteitem_create',
    );

    const throwing = route({
      toolPolicy: () => {
        throw new Error('secret policy detail');
      },
    });
    expect(await toolNames(throwing, ownerLocals)).toEqual([]);
    const { body } = await call(throwing, 'lanerouteitem_list', ownerLocals);
    expect(JSON.stringify(body)).not.toContain('secret policy detail');
    expect(body.error.data).toEqual({
      code: MCP_TOOL_ACCESS_DENIED_CODE,
      retryable: false,
    });
  });

  it('matches the overlay policy: non-human or tenant-less principals see nothing', async () => {
    const service = route({
      resolvePrincipal: () => ({
        id: 'svc',
        tenantId: 'tenant-a',
        kind: 'service',
        scopes: ['items.read'],
      }),
    });
    expect(await toolNames(service, {})).toEqual([]);
    const tenantless = route({
      resolvePrincipal: () => ({
        id: 'u',
        kind: 'human',
        scopes: ['items.read'],
      }),
    });
    expect(await toolNames(tenantless, {})).toEqual([]);
  });

  it('keeps the catalog private even when public caching is requested', async () => {
    const handler = route({
      publicToolPatterns: () => ['lanerouteitem_list'],
      toolListCache: { cacheScope: 'public', publicCatalog: true },
    });
    const response = await handler(rpc({ method: 'tools/list' }));
    expect((await response.json()).result).toMatchObject({
      cacheScope: 'private',
    });
  });

  it('rejects malformed JSON-RPC before dispatch', async () => {
    const handler = route();
    const before = await rowCount('lane_route_items');
    const cases = [
      rpc({ method: 'tools/call', rawBody: '{not json', locals: ownerLocals }),
      rpc({
        method: 'tools/call',
        rawBody: JSON.stringify({
          jsonrpc: '1.0',
          id: 1,
          method: 'tools/call',
        }),
        locals: ownerLocals,
      }),
      rpc({
        method: 'tools/call',
        params: { name: 'lanerouteitem_create', arguments: { title: 'x' } },
        headers: { 'mcp-method': 'tools/list' },
        locals: ownerLocals,
      }),
    ];
    for (const event of cases) {
      const response = await handler(event);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      const body = await response.json();
      expect(body.jsonrpc).toBe('2.0');
      expect(body.error).toBeDefined();
      expect(response.headers.get('mcp-session-id')).toBeNull();
    }
    expect(await rowCount('lane_route_items')).toBe(before);
  });

  it('serves a stock SDK v2 client statelessly with no session id', async () => {
    const handler = route();
    const responses: Response[] = [];
    const transport = new StreamableHTTPClientTransport(
      new URL('https://app.example/api/mcp'),
      {
        fetch: async (input, init) => {
          const request =
            input instanceof Request ? input : new Request(input, init);
          const response = await handler({
            locals: ownerLocals,
            request,
            url: new URL(request.url),
          });
          responses.push(response.clone());
          return response;
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
      const { tools } = await client.listTools();
      expect(tools.map(({ name }) => name)).toContain('lanerouteitem_list');
      const result = await client.callTool({
        name: 'lanerouteitem_list',
        arguments: {},
      });
      expect(result.isError).not.toBe(true);
    } finally {
      await client.close();
      await transport.close();
    }
    expect(responses.length).toBeGreaterThanOrEqual(3);
    expect(
      responses.every((response) => !response.headers.has('mcp-session-id')),
    ).toBe(true);
  });

  it('refuses subscription requests on the stateless endpoint', async () => {
    const response = await route()(
      rpc({ method: 'subscriptions/listen', locals: ownerLocals }),
    );
    expect(response.headers.get('content-type')).not.toContain(
      'text/event-stream',
    );
    expect((await response.json()).error).toBeDefined();
  });

  it('fails loudly for an undeclared or unregistered model', () => {
    class NotDecorated {}
    expect(() =>
      route({ models: [NotDecorated as unknown as typeof LaneRouteItem] }),
    ).toThrow(TypeError);
    expect(() => route({ requiredScopes: 'items.read' as never })).toThrow(
      TypeError,
    );
  });
});

describe('bearer authentication source', () => {
  function stubAuth(
    principal: { id: string; tenantId: string } | null,
  ): McpRouteResourceAuth & { calls: number } {
    const stub = {
      calls: 0,
      metadataUrl:
        'https://app.example/.well-known/oauth-protected-resource/api/mcp',
      metadataResponse: () => Response.json({ resource: 'stub' }),
      async authenticate() {
        stub.calls += 1;
        if (!principal)
          return {
            ok: false as const,
            response: new Response(null, {
              status: 401,
              headers: { 'WWW-Authenticate': 'Bearer resource_metadata="x"' },
            }),
          };
        return {
          ok: true as const,
          principal: { ...principal, kind: 'human', scopes: ['items.read'] },
        };
      },
    };
    return stub;
  }

  it('returns the challenge and ignores the browser session when bearer auth is active', async () => {
    const auth = stubAuth(null);
    const handler = route({ auth: () => auth });
    const before = await rowCount('lane_route_items');
    const response = await handler(
      rpc({
        method: 'tools/call',
        params: { name: 'lanerouteitem_create', arguments: { title: 'x' } },
        locals: ownerLocals,
      }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('Bearer');
    expect(await response.text()).toBe('');
    expect(await rowCount('lane_route_items')).toBe(before);
  });

  it('uses the adapter principal, not locals, when authentication succeeds', async () => {
    const auth = stubAuth({ id: 'remote', tenantId: 'tenant-r' });
    const handler = route({ auth });
    expect(await toolNames(handler, {})).toContain('lanerouteitem_list');
    expect(auth.calls).toBe(1);
  });

  it('falls back to the session principal when the source yields null', async () => {
    const handler = route({ auth: () => null });
    expect(await toolNames(handler, ownerLocals)).toContain(
      'lanerouteitem_list',
    );
    expect(await toolNames(handler, {})).toEqual([]);
  });

  it('allows only headerless anonymous public access when explicitly enabled', async () => {
    const validBearer = 'Bearer live-token';
    const auth: McpRouteResourceAuth = {
      metadataUrl:
        'https://app.example/.well-known/oauth-protected-resource/api/mcp',
      metadataResponse: () => Response.json({ resource: 'stub' }),
      async authenticate(request) {
        const scopes =
          request.headers.get('authorization') === validBearer
            ? ['items.read']
            : request.headers.get('authorization') === 'Bearer narrow-token'
              ? ['other.read']
              : undefined;
        if (scopes) {
          return {
            ok: true as const,
            principal: {
              id: 'remote',
              tenantId: 'tenant-a',
              kind: 'human',
              scopes,
            },
          };
        }
        return {
          ok: false as const,
          response: new Response(null, {
            status: 401,
            headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' },
          }),
        };
      },
    };
    const publicResource = 'ui://lane/v1/public.html';
    const privateResource = 'ui://lane/v1/private.html';
    const handler = route({
      auth,
      allowAnonymous: true,
      publicToolPatterns: () => ['lanerouteitem_list'],
      resources: [
        {
          uri: publicResource,
          version: 'v1',
          name: 'Public view',
          html: '<title>Public</title>',
          public: true,
        },
        {
          uri: privateResource,
          version: 'v1',
          name: 'Private view',
          html: '<title>Private</title>',
        },
      ],
    });

    // No header is the only anonymous path. It exposes the declared public
    // read-only surface but no private tool or resource.
    expect(await toolNames(handler, {})).toEqual(['lanerouteitem_list']);
    const publicCall = await call(handler, 'lanerouteitem_list', {});
    expect(publicCall.body.result.isError).not.toBe(true);
    const privateCall = await call(handler, 'lanerouteitem_create', {});
    expect(privateCall.body.error.message).toContain(
      'Authentication is required',
    );
    const anonymousResources = await handler(rpc({ method: 'resources/list' }));
    expect(
      (await anonymousResources.json()).result.resources.map(
        (resource: { uri: string }) => resource.uri,
      ),
    ).toEqual([publicResource]);
    const hiddenResource = await handler(
      rpc({ method: 'resources/read', params: { uri: privateResource } }),
    );
    expect((await hiddenResource.json()).error.message).toBe(
      'MCP resource is not available.',
    );
    // `allowAnonymous` is deliberately not a session fallback: ambient
    // session locals and a custom resolver must not widen it.
    expect(await toolNames(handler, ownerLocals)).toEqual([
      'lanerouteitem_list',
    ]);
    const sessionPrivateCall = await call(
      handler,
      'lanerouteitem_create',
      ownerLocals,
    );
    expect(sessionPrivateCall.body.error.message).toContain(
      'Authentication is required',
    );
    const sessionResources = await handler(
      rpc({ method: 'resources/list', locals: ownerLocals }),
    );
    expect(
      (await sessionResources.json()).result.resources.map(
        (resource: { uri: string }) => resource.uri,
      ),
    ).toEqual([publicResource]);
    const customResolver = route({
      auth,
      allowAnonymous: true,
      publicToolPatterns: () => ['lanerouteitem_list'],
      resolvePrincipal: () => ({
        id: 'custom-owner',
        tenantId: 'tenant-a',
        kind: 'human',
        scopes: ['items.read'],
      }),
    });
    expect(await toolNames(customResolver, {})).toEqual(['lanerouteitem_list']);

    // Any supplied credentials stay on the bearer path. They cannot turn a
    // protected route into an anonymous one, even with a valid cookie session.
    for (const authorization of [
      'Bearer revoked-token',
      'Bearer malformed token',
      'Basic malformed',
    ]) {
      const denied = await handler(
        rpc({
          method: 'tools/list',
          headers: { authorization },
          locals: ownerLocals,
        }),
      );
      expect(denied.status).toBe(401);
      expect(denied.headers.get('www-authenticate')).toBe(
        'Bearer error="invalid_token"',
      );
    }

    // A verified bearer receives the authenticated, scope-filtered surface.
    const verified = await handler(
      rpc({
        method: 'tools/list',
        headers: { authorization: validBearer },
      }),
    );
    expect(
      (await verified.json()).result.tools.map(
        (tool: { name: string }) => tool.name,
      ),
    ).toEqual(
      expect.arrayContaining(['lanerouteitem_create', 'lanerouteitem_list']),
    );
    const verifiedResources = await handler(
      rpc({
        method: 'resources/list',
        headers: { authorization: validBearer },
      }),
    );
    expect(
      (await verifiedResources.json()).result.resources.map(
        (resource: { uri: string }) => resource.uri,
      ),
    ).toEqual([privateResource, publicResource]);
    const narrow = await handler(
      rpc({
        method: 'tools/list',
        headers: { authorization: 'Bearer narrow-token' },
      }),
    );
    expect((await narrow.json()).result.tools).toEqual([]);
    const unknown = await call(handler, 'does_not_exist', {});
    expect(unknown.body.error).toMatchObject({
      code: -32602,
      message: 'Unknown MCP tool.',
    });
  });

  it('authenticates a real signed token end to end through the default route', async () => {
    const pair = await generateKeyPair('RS256');
    const jwk = {
      ...(await exportJWK(pair.publicKey)),
      kid: 'k',
      alg: 'RS256',
      use: 'sig',
    };
    const jwks = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((resolve) => jwks.listen(0, '127.0.0.1', resolve));
    const address = jwks.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const auth = createMcpResourceAuth({
        profile: 'local',
        resource: `${origin}/api/mcp`,
        issuer: origin,
        jwksUri: `${origin}/jwks`,
        algorithms: ['RS256'],
        scopes: ['items.read'],
        resolvePrincipal: async ({ subject }) => ({
          id: subject,
          tenantId: 'tenant-a',
          kind: 'human',
        }),
      });
      const handler = route({ auth });
      const token = await new SignJWT({
        iss: origin,
        aud: `${origin}/api/mcp`,
        sub: 'alice',
        exp: Math.floor(Date.now() / 1000) + 60,
        scope: 'items.read',
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'k', typ: 'at+jwt' })
        .sign(pair.privateKey);
      const authorized = await handler(
        rpc({
          method: 'tools/list',
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      expect(
        (await authorized.json()).result.tools.map(
          (tool: { name: string }) => tool.name,
        ),
      ).toContain('lanerouteitem_list');
      const anonymous = await handler(
        rpc({ method: 'tools/list', locals: ownerLocals }),
      );
      expect(anonymous.status).toBe(401);

      const metadata = mountMcpProtectedResourceMetadataRoute(auth);
      const metadataUrl = new URL(auth.metadataUrl);
      const served = await metadata({
        request: new Request(metadataUrl),
        url: metadataUrl,
      });
      expect(served.status).toBe(200);
      expect(served.headers.get('cache-control')).toBe('no-store');
      expect(await served.json()).toEqual({
        resource: `${origin}/api/mcp`,
        authorization_servers: [origin],
        scopes_supported: ['items.read'],
        bearer_methods_supported: ['header'],
      });
    } finally {
      await new Promise<void>((resolve) => jwks.close(() => resolve()));
    }
  });
});

describe('mountMcpProtectedResourceMetadataRoute', () => {
  const auth: McpRouteResourceAuth = {
    metadataUrl:
      'https://app.example/.well-known/oauth-protected-resource/api/mcp',
    metadataResponse: () =>
      Response.json(
        { resource: 'https://app.example/api/mcp' },
        { headers: { 'Cache-Control': 'no-store' } },
      ),
    authenticate: async () => ({
      ok: false,
      response: new Response(null, { status: 401 }),
    }),
  };
  const event = (path: string) => {
    const url = new URL(path, 'https://app.example');
    return { request: new Request(url), url };
  };

  it('serves metadata only at the advertised path', async () => {
    const handler = mountMcpProtectedResourceMetadataRoute(() => auth);
    const served = await handler(
      event('/.well-known/oauth-protected-resource/api/mcp'),
    );
    expect(served.status).toBe(200);
    expect(await served.json()).toEqual({
      resource: 'https://app.example/api/mcp',
    });
    const elsewhere = await handler(
      event('/.well-known/oauth-protected-resource'),
    );
    expect(elsewhere.status).toBe(404);
    expect(await elsewhere.text()).toBe('');
  });

  it('returns 404 for the local profile', async () => {
    for (const source of [null, undefined, () => null]) {
      const response = await mountMcpProtectedResourceMetadataRoute(source)(
        event('/.well-known/oauth-protected-resource/api/mcp'),
      );
      expect(response.status).toBe(404);
    }
  });

  it('propagates a misconfigured hosted adapter instead of serving metadata', async () => {
    const handler = mountMcpProtectedResourceMetadataRoute(() => {
      throw new Error('Hosted MCP requires SMRT_MCP_ISSUER.');
    });
    await expect(
      handler(event('/.well-known/oauth-protected-resource/api/mcp')),
    ).rejects.toThrow('SMRT_MCP_ISSUER');
  });
});
