/**
 * `mountMcpAppRoute({ runtime })` and
 * `mountMcpProtectedResourceMetadataRoute({ runtime })` (#3491) derive
 * `smrtOptions`, `auth` and `bindPrincipal` from the application runtime,
 * resolving the profile per request. Every credential path must answer
 * byte-for-byte what the hand-wired trio answers:
 *
 *   smrtOptions: () => ({ db: runtime.databaseConfig() }),
 *   auth: createHostedMcpResourceAuth({ profile, runtime }),
 *   bindPrincipal: runtime.runAsPrincipal,
 *
 * and a runtime that cannot supply its bindings fails closed.
 */

import {
  getTestDatabase,
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  createHostedMcpResourceAuth,
  HOSTED_MCP_AUTH_ENV,
  type McpDeploymentProfile,
  type McpLocalTokenPrincipal,
  type McpVerifiedIdentity,
} from '../auth.js';
import { MCP_ORIGIN_DENIED_CODE } from '../errors.js';
import type { McpAppPrincipal } from '../server.js';
import {
  type McpAppRouteRuntime,
  type McpBoundPrincipal,
  type McpSvelteKitHandler,
  mountMcpAppRoute,
  mountMcpProtectedResourceMetadataRoute,
} from '../sveltekit.js';

@smrt({ mcp: { include: ['list', 'get', 'create'] } })
class RuntimeRouteNote extends SmrtObject {
  title: string = '';
}
class RuntimeRouteNoteCollection extends SmrtCollection<RuntimeRouteNote> {
  static readonly _itemClass = RuntimeRouteNote;
}

const READ = 'notes.read';
const TOKEN = `smrt_mcp_${'a'.repeat(43)}`;
const NARROW_TOKEN = `smrt_mcp_${'b'.repeat(43)}`;
const REVOKED_TOKEN = `smrt_mcp_${'c'.repeat(43)}`;
const LOCAL_URL = 'http://127.0.0.1:5173/mcp';
const HOSTED = {
  resource: 'https://app.example/mcp',
  issuer: 'https://identity.example/',
  jwksUri: 'https://identity.example/keys',
};
const cookieLocals = {
  user: { id: 'cookie-user' },
  tenantId: 'cookie-tenant',
  permissions: [READ],
  sessionId: 'sid',
};

let db: Awaited<ReturnType<typeof getTestDatabase>>;
const keys = await generateKeyPair('RS256');
const jwk = {
  ...(await exportJWK(keys.publicKey)),
  kid: 'runtime-route',
  alg: 'RS256',
  use: 'sig',
};

beforeAll(async () => {
  ObjectRegistry.registerCollection(
    'RuntimeRouteNote',
    RuntimeRouteNoteCollection,
  );
  db = await getTestDatabase({ classes: ['RuntimeRouteNote'] });
  await db.insert('runtime_route_notes', {
    id: '00000000-0000-4000-8000-000000003491',
    slug: 'first',
    context: '',
    title: 'runtime note',
  });
});
afterAll(async () => {
  await db?.close?.();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

interface FakeRuntime extends McpAppRouteRuntime {
  readonly state: {
    profile: string;
    resolveCalls: number;
    databaseCalls: number;
    bound: string[];
    resolveError?: Error;
  };
}

/** A structural stand-in for the SMRT SvelteKit runtime's MCP bindings. */
function fakeRuntime(profile: string = 'local'): FakeRuntime {
  const tokens = new Map<string, McpLocalTokenPrincipal>([
    [
      TOKEN,
      {
        id: 'owner-user',
        tenantId: 'owner-tenant',
        kind: 'human',
        scopes: [READ],
      },
    ],
    [
      NARROW_TOKEN,
      {
        id: 'owner-user',
        tenantId: 'owner-tenant',
        kind: 'human',
        scopes: ['other.read'],
      },
    ],
  ]);
  const state: FakeRuntime['state'] = {
    profile,
    resolveCalls: 0,
    databaseCalls: 0,
    bound: [],
  };
  return {
    state,
    async resolvedRuntime() {
      state.resolveCalls += 1;
      if (state.resolveError) throw state.resolveError;
      return { profile: state.profile as McpDeploymentProfile };
    },
    async verifyLocalMcpToken(token: string) {
      const principal = tokens.get(token);
      return principal
        ? { ...principal, scopes: [...(principal.scopes ?? [])] }
        : null;
    },
    async resolveMcpPrincipal(identity: McpVerifiedIdentity) {
      return identity.subject === 'user-1'
        ? {
            id: 'user-1',
            tenantId: 'tenant-1',
            kind: 'human',
            tenantBinding: 'direct' as const,
          }
        : null;
    },
    databaseConfig() {
      state.databaseCalls += 1;
      return db as never;
    },
    async runAsPrincipal<T>(
      principal: McpAppPrincipal & { id: string },
      run: (bound?: McpBoundPrincipal) => Promise<T>,
    ): Promise<T> {
      state.bound.push(principal.id);
      return run(
        Object.freeze({
          ...principal,
          scopes: Object.freeze([...(principal.scopes ?? [])]),
        }),
      );
    },
  };
}

function routeOptions(seen: Array<McpAppPrincipal | null>) {
  return {
    models: [RuntimeRouteNote],
    requiredScopes: [READ],
    effects: ['read' as const],
    workflowTools: [
      {
        name: 'whoami',
        description: 'Report the dispatch principal.',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: { type: 'object' },
        effect: 'read' as const,
        idempotent: true,
        openWorld: false,
        async execute(context: { principal?: McpAppPrincipal | null }) {
          seen.push(context.principal ?? null);
          const result = {
            id: context.principal?.id ?? null,
            tenantId: context.principal?.tenantId ?? null,
            scopes: context.principal?.scopes ?? [],
          };
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            structuredContent: result,
          };
        },
      },
    ],
  };
}

/** The same route mounted the hand-wired way and the `runtime` way. */
function mountBoth(runtime: FakeRuntime) {
  const explicitSeen: Array<McpAppPrincipal | null> = [];
  const runtimeSeen: Array<McpAppPrincipal | null> = [];
  const explicit = mountMcpAppRoute({
    ...routeOptions(explicitSeen),
    smrtOptions: () => ({ db: runtime.databaseConfig() }),
    auth: createHostedMcpResourceAuth({
      profile: runtime.state.profile as McpDeploymentProfile,
      runtime,
    }),
    bindPrincipal: runtime.runAsPrincipal,
  });
  const derived = mountMcpAppRoute({
    ...routeOptions(runtimeSeen),
    runtime,
  });
  return { explicit, derived, explicitSeen, runtimeSeen };
}

function rpc(
  init: {
    method: 'tools/list' | 'tools/call';
    name?: string;
    url?: string;
    authorization?: string;
    origin?: string;
    locals?: Record<string, unknown>;
  } = { method: 'tools/list' },
) {
  const url = new URL(init.url ?? LOCAL_URL);
  return {
    locals: init.locals ?? {},
    url,
    request: new Request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': init.method,
        ...(init.name ? { 'mcp-name': init.name } : {}),
        ...(init.authorization ? { authorization: init.authorization } : {}),
        ...(init.origin ? { origin: init.origin } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: init.method,
        params: {
          ...(init.name ? { name: init.name, arguments: {} } : {}),
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
            [CLIENT_INFO_META_KEY]: { name: 'runtime-route', version: '0' },
            [CLIENT_CAPABILITIES_META_KEY]: {},
          },
        },
      }),
    }),
  };
}

interface Wire {
  status: number;
  headers: Array<[string, string]>;
  body: string;
}

async function wire(response: Response): Promise<Wire> {
  return {
    status: response.status,
    headers: [...response.headers].sort(([a], [b]) => a.localeCompare(b)),
    body: Buffer.from(await response.arrayBuffer()).toString('utf8'),
  };
}

/** Send one fresh copy of the request to each handler; demand identical wire output. */
async function same(
  explicit: McpSvelteKitHandler,
  derived: McpSvelteKitHandler,
  init: Parameters<typeof rpc>[0],
): Promise<Wire> {
  const a = await wire(await explicit(rpc(init) as never));
  const b = await wire(await derived(rpc(init) as never));
  expect(b).toEqual(a);
  return a;
}

function stubHostedEnvironment(scopes = READ) {
  vi.stubEnv(HOSTED_MCP_AUTH_ENV.resource, HOSTED.resource);
  vi.stubEnv(HOSTED_MCP_AUTH_ENV.issuer, HOSTED.issuer);
  vi.stubEnv(HOSTED_MCP_AUTH_ENV.jwksUri, HOSTED.jwksUri);
  vi.stubEnv(HOSTED_MCP_AUTH_ENV.scopes, scopes);
  const realFetch = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input instanceof Request ? input.url : input) === HOSTED.jwksUri
        ? Response.json({ keys: [jwk] })
        : realFetch(input, init),
    ),
  );
}

function accessToken(subject: string, scope = READ): Promise<string> {
  return new SignJWT({ scope })
    .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: jwk.kid })
    .setIssuer(HOSTED.issuer)
    .setAudience(HOSTED.resource)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(keys.privateKey);
}

describe('mountMcpAppRoute({ runtime }) matches the hand-wired route (local profile)', () => {
  it('answers anonymous tools/list identically and resolves the profile lazily', async () => {
    const runtime = fakeRuntime('local');
    const { explicit, derived } = mountBoth(runtime);
    // Mounting reads nothing from the runtime: no top-level await needed.
    expect(runtime.state.resolveCalls).toBe(0);
    const result = await same(explicit, derived, { method: 'tools/list' });
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body).result.tools).toEqual([]);
    // Exactly one profile resolution for the one runtime-form request.
    expect(runtime.state.resolveCalls).toBe(1);
    expect(runtime.state.bound).toEqual([]);
  });

  it('serves the session principal identically, unbound, on the runtime database', async () => {
    const runtime = fakeRuntime('local');
    const { explicit, derived, explicitSeen, runtimeSeen } = mountBoth(runtime);
    const listed = await same(explicit, derived, {
      method: 'tools/list',
      locals: cookieLocals,
    });
    expect(
      JSON.parse(listed.body)
        .result.tools.map((tool: { name: string }) => tool.name)
        .sort(),
    ).toEqual(['runtimeroutenote_get', 'runtimeroutenote_list', 'whoami']);
    const before = runtime.state.databaseCalls;
    const notes = await same(explicit, derived, {
      method: 'tools/call',
      name: 'runtimeroutenote_list',
      locals: cookieLocals,
    });
    expect(notes.status).toBe(200);
    expect(notes.body).toContain('runtime note');
    // Both forms read the runtime's database through `smrtOptions`.
    expect(runtime.state.databaseCalls).toBeGreaterThanOrEqual(before + 2);
    const whoami = await same(explicit, derived, {
      method: 'tools/call',
      name: 'whoami',
      locals: cookieLocals,
    });
    expect(JSON.parse(whoami.body).result.structuredContent).toEqual({
      id: 'cookie-user',
      tenantId: 'cookie-tenant',
      scopes: [READ],
    });
    expect(explicitSeen).toEqual(runtimeSeen);
    // The session path never runs the bearer binder.
    expect(runtime.state.bound).toEqual([]);
  });

  it('denies a session principal without the scope identically', async () => {
    const runtime = fakeRuntime('local');
    const { explicit, derived, runtimeSeen } = mountBoth(runtime);
    const denied = await same(explicit, derived, {
      method: 'tools/call',
      name: 'whoami',
      locals: { ...cookieLocals, permissions: [] },
    });
    expect(denied.body).toContain('"error"');
    expect(runtimeSeen).toEqual([]);
  });

  it('binds a scoped local token identically through runAsPrincipal', async () => {
    const runtime = fakeRuntime('local');
    const { explicit, derived } = mountBoth(runtime);
    const whoami = await same(explicit, derived, {
      method: 'tools/call',
      name: 'whoami',
      authorization: `Bearer ${TOKEN}`,
      locals: cookieLocals,
    });
    expect(whoami.status).toBe(200);
    // The token principal, never the cookie on the same request.
    expect(JSON.parse(whoami.body).result.structuredContent).toEqual({
      id: 'owner-user',
      tenantId: 'owner-tenant',
      scopes: [READ],
    });
    const notes = await same(explicit, derived, {
      method: 'tools/call',
      name: 'runtimeroutenote_list',
      authorization: `Bearer ${TOKEN}`,
    });
    expect(notes.body).toContain('runtime note');
    // Two requests per form, each bound once.
    expect(runtime.state.bound).toEqual([
      'owner-user',
      'owner-user',
      'owner-user',
      'owner-user',
    ]);
  });

  it('denies a local token without the required scope identically', async () => {
    const runtime = fakeRuntime('local');
    const { explicit, derived, runtimeSeen } = mountBoth(runtime);
    const denied = await same(explicit, derived, {
      method: 'tools/call',
      name: 'whoami',
      authorization: `Bearer ${NARROW_TOKEN}`,
    });
    expect(denied.body).toContain('"error"');
    expect(runtimeSeen).toEqual([]);
  });

  it('answers a revoked token 401 identically and never falls back to the cookie', async () => {
    const runtime = fakeRuntime('local');
    const { explicit, derived, explicitSeen, runtimeSeen } = mountBoth(runtime);
    const denied = await same(explicit, derived, {
      method: 'tools/call',
      name: 'whoami',
      authorization: `Bearer ${REVOKED_TOKEN}`,
      locals: cookieLocals,
    });
    expect(denied.status).toBe(401);
    expect(denied.headers).toContainEqual([
      'www-authenticate',
      'Bearer error="invalid_token"',
    ]);
    expect(denied.body).toBe('');
    expect([...explicitSeen, ...runtimeSeen]).toEqual([]);
    expect(runtime.state.bound).toEqual([]);
  });
});

describe('mountMcpAppRoute({ runtime }) matches the hand-wired route (hosted profile)', () => {
  it('maps and binds a hosted access token identically', async () => {
    stubHostedEnvironment();
    const runtime = fakeRuntime('self-hosted');
    const { explicit, derived } = mountBoth(runtime);
    const token = await accessToken('user-1');
    const whoami = await same(explicit, derived, {
      method: 'tools/call',
      name: 'whoami',
      url: HOSTED.resource,
      authorization: `Bearer ${token}`,
      locals: cookieLocals,
    });
    expect(whoami.status).toBe(200);
    expect(JSON.parse(whoami.body).result.structuredContent).toEqual({
      id: 'user-1',
      tenantId: 'tenant-1',
      scopes: [READ],
    });
    expect(runtime.state.bound).toEqual(['user-1', 'user-1']);
  });

  it('challenges a missing, under-scoped or unmapped bearer identically', async () => {
    stubHostedEnvironment();
    const runtime = fakeRuntime('cloud');
    const { explicit, derived, runtimeSeen } = mountBoth(runtime);
    const missing = await same(explicit, derived, {
      method: 'tools/call',
      name: 'whoami',
      url: HOSTED.resource,
      locals: cookieLocals,
    });
    expect(missing.status).toBe(401);
    expect(missing.headers).toContainEqual([
      'www-authenticate',
      `Bearer resource_metadata="https://app.example/.well-known/oauth-protected-resource/mcp", scope="${READ}"`,
    ]);
    const narrow = await same(explicit, derived, {
      method: 'tools/call',
      name: 'whoami',
      url: HOSTED.resource,
      authorization: `Bearer ${await accessToken('user-1', 'other.read')}`,
    });
    expect(narrow.status).toBe(403);
    const unmapped = await same(explicit, derived, {
      method: 'tools/call',
      name: 'whoami',
      url: HOSTED.resource,
      authorization: `Bearer ${await accessToken('stranger')}`,
    });
    expect(unmapped.status).toBe(401);
    expect(runtimeSeen).toEqual([]);
    expect(runtime.state.bound).toEqual([]);
  });
});

describe('mountMcpProtectedResourceMetadataRoute({ runtime })', () => {
  function metadataPair(runtime: FakeRuntime) {
    return {
      explicit: mountMcpProtectedResourceMetadataRoute(
        createHostedMcpResourceAuth({
          profile: runtime.state.profile as McpDeploymentProfile,
          runtime,
        }),
      ),
      derived: mountMcpProtectedResourceMetadataRoute({ runtime }),
    };
  }
  const get = (url: string) => ({
    locals: {},
    url: new URL(url),
    request: new Request(url),
  });

  it('answers 404 in the local profile, like the hand-wired route', async () => {
    const runtime = fakeRuntime('local');
    const { explicit, derived } = metadataPair(runtime);
    const url =
      'http://127.0.0.1:5173/.well-known/oauth-protected-resource/mcp';
    const a = await wire(await explicit(get(url)));
    const b = await wire(await derived(get(url)));
    expect(b).toEqual(a);
    expect(a.status).toBe(404);
  });

  it('serves the identical hosted document at the advertised path only', async () => {
    stubHostedEnvironment();
    const runtime = fakeRuntime('self-hosted');
    const { explicit, derived } = metadataPair(runtime);
    const url = 'https://app.example/.well-known/oauth-protected-resource/mcp';
    const a = await wire(await explicit(get(url)));
    const b = await wire(await derived(get(url)));
    expect(b).toEqual(a);
    expect(a.status).toBe(200);
    expect(JSON.parse(a.body)).toEqual({
      resource: HOSTED.resource,
      authorization_servers: [HOSTED.issuer],
      scopes_supported: [READ],
      bearer_methods_supported: ['header'],
    });
    const elsewhere =
      'https://app.example/.well-known/oauth-protected-resource';
    expect((await derived(get(elsewhere))).status).toBe(404);
    expect((await explicit(get(elsewhere))).status).toBe(404);
  });

  it('fails closed: missing hosted configuration rejects, a malformed runtime throws', async () => {
    const runtime = fakeRuntime('cloud');
    const { explicit, derived } = metadataPair(runtime);
    const url = 'https://app.example/.well-known/oauth-protected-resource/mcp';
    await expect(explicit(get(url))).rejects.toThrow('Hosted MCP requires');
    await expect(derived(get(url))).rejects.toThrow('Hosted MCP requires');
    expect(() =>
      mountMcpProtectedResourceMetadataRoute({
        runtime: { resolvedRuntime: runtime.resolvedRuntime } as never,
      }),
    ).toThrow(
      'mountMcpProtectedResourceMetadataRoute: runtime must provide verifyLocalMcpToken, resolveMcpPrincipal.',
    );
    expect(() =>
      mountMcpProtectedResourceMetadataRoute({
        runtime,
        authenticate: async () => ({ ok: false }),
      } as never),
    ).toThrow('not both');
  });
});

describe('runtime route resolution and fail-closed behaviour', () => {
  it('re-resolves the profile per request and never reuses another profile adapter', async () => {
    stubHostedEnvironment();
    const runtime = fakeRuntime('local');
    const seen: Array<McpAppPrincipal | null> = [];
    const POST = mountMcpAppRoute({ ...routeOptions(seen), runtime });
    const local = await POST(
      rpc({
        method: 'tools/call',
        name: 'whoami',
        authorization: `Bearer ${TOKEN}`,
      }) as never,
    );
    expect(local.status).toBe(200);
    runtime.state.profile = 'self-hosted';
    // The same owner token is not a hosted access token: the hosted adapter
    // challenges it with its resource metadata; it is never accepted.
    const hosted = await POST(
      rpc({
        method: 'tools/call',
        name: 'whoami',
        url: HOSTED.resource,
        authorization: `Bearer ${TOKEN}`,
      }) as never,
    );
    expect(hosted.status).toBe(401);
    expect(hosted.headers.get('www-authenticate')).toContain(
      'resource_metadata=',
    );
    runtime.state.profile = 'local';
    const again = await POST(
      rpc({
        method: 'tools/call',
        name: 'whoami',
        authorization: `Bearer ${TOKEN}`,
      }) as never,
    );
    expect(again.status).toBe(200);
    expect(runtime.state.resolveCalls).toBe(3);
    expect(seen.map((principal) => principal?.id)).toEqual([
      'owner-user',
      'owner-user',
    ]);
  });

  it('rejects before dispatch when hosted configuration is missing, as the hand-wired route does', async () => {
    const runtime = fakeRuntime('self-hosted');
    const { explicit, derived, explicitSeen, runtimeSeen } = mountBoth(runtime);
    const init = {
      method: 'tools/call' as const,
      name: 'whoami',
      url: HOSTED.resource,
      locals: cookieLocals,
    };
    await expect(explicit(rpc(init) as never)).rejects.toThrow(
      'Hosted MCP requires SMRT_MCP_RESOURCE.',
    );
    await expect(derived(rpc(init) as never)).rejects.toThrow(
      'Hosted MCP requires SMRT_MCP_RESOURCE.',
    );
    expect([...explicitSeen, ...runtimeSeen]).toEqual([]);
  });

  it('rejects before dispatch when the profile cannot be resolved or is unknown', async () => {
    const runtime = fakeRuntime('local');
    const seen: Array<McpAppPrincipal | null> = [];
    const POST = mountMcpAppRoute({ ...routeOptions(seen), runtime });
    runtime.state.resolveError = new Error('config unavailable');
    await expect(
      POST(
        rpc({
          method: 'tools/call',
          name: 'whoami',
          locals: cookieLocals,
        }) as never,
      ),
    ).rejects.toThrow('config unavailable');
    runtime.state.resolveError = undefined;
    runtime.state.profile = 'staging';
    await expect(
      POST(
        rpc({
          method: 'tools/call',
          name: 'whoami',
          locals: cookieLocals,
        }) as never,
      ),
    ).rejects.toThrow('unknown deployment profile');
    expect(seen).toEqual([]);
  });

  it('throws at mount for a runtime missing a binding', () => {
    const runtime = fakeRuntime('local');
    const { runAsPrincipal: _bind, ...unbindable } = runtime;
    expect(() =>
      mountMcpAppRoute({ ...routeOptions([]), runtime: unbindable as never }),
    ).toThrow('mountMcpAppRoute: runtime must provide runAsPrincipal.');
    expect(() =>
      mountMcpAppRoute({ ...routeOptions([]), runtime: null as never }),
    ).toThrow(
      'mountMcpAppRoute: runtime must provide resolvedRuntime, verifyLocalMcpToken, resolveMcpPrincipal, databaseConfig, runAsPrincipal.',
    );
  });

  it('refuses a foreign Origin before resolving the profile', async () => {
    const runtime = fakeRuntime('local');
    const POST = mountMcpAppRoute({ ...routeOptions([]), runtime });
    const response = await POST(
      rpc({
        method: 'tools/list',
        origin: 'https://evil.example',
        locals: cookieLocals,
      }) as never,
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error.data.code).toBe(
      MCP_ORIGIN_DENIED_CODE,
    );
    expect(runtime.state.resolveCalls).toBe(0);
  });

  it('keeps explicit smrtOptions, bindPrincipal and auth as overrides', async () => {
    const runtime = fakeRuntime('self-hosted');
    const binds: string[] = [];
    const seen: Array<McpAppPrincipal | null> = [];
    const POST = mountMcpAppRoute({
      ...routeOptions(seen),
      runtime,
      smrtOptions: () => ({ db }),
      bindPrincipal: async (principal, run) => {
        binds.push(principal.id);
        return run();
      },
      auth: {
        metadataUrl: '',
        metadataResponse: () => new Response(null, { status: 404 }),
        authenticate: async () => ({
          ok: true,
          principal: {
            id: 'gateway-user',
            tenantId: 't',
            kind: 'human',
            scopes: [READ],
          },
        }),
      },
    });
    const response = await POST(
      rpc({ method: 'tools/call', name: 'runtimeroutenote_list' }) as never,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('runtime note');
    expect(binds).toEqual(['gateway-user']);
    // Neither the runtime's profile, database nor binder was consulted.
    expect(runtime.state.resolveCalls).toBe(0);
    expect(runtime.state.databaseCalls).toBe(0);
    expect(runtime.state.bound).toEqual([]);

    // `auth: null` is an explicit choice of the session path.
    const sessionOnly = mountMcpAppRoute({
      ...routeOptions(seen),
      runtime,
      auth: null,
    });
    const session = await sessionOnly(
      rpc({
        method: 'tools/call',
        name: 'whoami',
        locals: cookieLocals,
      }) as never,
    );
    expect((await session.json()).result.structuredContent.id).toBe(
      'cookie-user',
    );
    expect(runtime.state.resolveCalls).toBe(0);
  });
});
