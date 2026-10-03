/**
 * Local-profile owner tokens and runtime bindings (#3413). In the local
 * profile `createHostedMcpResourceAuth({ runtime })` yields a session-fallback
 * adapter: requests without `Authorization` keep the session principal, a
 * presented bearer must verify and never falls back to the cookie. Hosted
 * profiles default to the runtime's membership-backed resolver unless the
 * application passes its own.
 */

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import {
  createHostedMcpResourceAuth,
  createLocalMcpTokenAuth,
  type McpAuthRuntime,
} from '../auth.js';
import { MCP_ORIGIN_DENIED_CODE } from '../errors.js';
import type { McpAppPrincipal } from '../server.js';
import {
  mountMcpAppRoute,
  mountMcpProtectedResourceMetadataRoute,
} from '../sveltekit.js';

const TOKEN = `smrt_mcp_${'a'.repeat(43)}`;
const owner = {
  id: 'owner-user',
  tenantId: 'owner-tenant',
  kind: 'human',
  scopes: ['notes.read'],
};
const cookieLocals = {
  user: { id: 'cookie-user' },
  tenantId: 'cookie-tenant',
  permissions: ['notes.read'],
  sessionId: 'sid',
};

function runtime(
  verify: McpAuthRuntime['verifyLocalMcpToken'] = async (token) =>
    token === TOKEN ? { ...owner, scopes: [...owner.scopes] } : null,
): McpAuthRuntime & { verifyLocalMcpToken: ReturnType<typeof vi.fn> } {
  return { verifyLocalMcpToken: vi.fn(verify) } as never;
}

function rpc(
  options: {
    authorization?: string;
    origin?: string;
    locals?: Record<string, unknown>;
  } = {},
) {
  const url = new URL('http://127.0.0.1:5173/mcp');
  return {
    locals: options.locals ?? {},
    url,
    request: new Request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': 'whoami',
        ...(options.authorization
          ? { authorization: options.authorization }
          : {}),
        ...(options.origin ? { origin: options.origin } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'whoami',
          arguments: {},
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
            [CLIENT_INFO_META_KEY]: { name: 'local-token', version: '0' },
            [CLIENT_CAPABILITIES_META_KEY]: {},
          },
        },
      }),
    }),
  };
}

function route(source: ReturnType<typeof createHostedMcpResourceAuth>) {
  const seen: Array<McpAppPrincipal | null> = [];
  const bindings: string[] = [];
  const bound: McpAppPrincipal[] = [];
  const POST = mountMcpAppRoute({
    models: [],
    requiredScopes: ['notes.read'],
    effects: ['read'],
    smrtOptions: () => ({}),
    auth: source,
    bindPrincipal: async (principal, run) => {
      bindings.push(principal.id);
      bound.push(principal);
      return run(principal);
    },
    workflowTools: [
      {
        name: 'whoami',
        description: 'Report the dispatch principal.',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: { type: 'object' },
        effect: 'read',
        idempotent: true,
        openWorld: false,
        async execute(context) {
          seen.push(context.principal ?? null);
          return {
            content: [{ type: 'text', text: 'ok' }],
            structuredContent: { id: context.principal?.id ?? null },
          };
        },
      },
    ],
  });
  return { POST, seen, bindings, bound };
}

describe('createLocalMcpTokenAuth', () => {
  it('maps a verified token to its principal and copies only identity fields', async () => {
    const verify = vi.fn(async () => ({
      ...owner,
      allowCrossTenant: true,
      roles: ['owner'],
      tenantBinding: 'direct-or-inherited',
    }));
    const auth = createLocalMcpTokenAuth({ verify });
    expect(auth.sessionFallback).toBe(true);
    expect(auth.metadataUrl).toBe('');
    expect(auth.metadataResponse().status).toBe(404);
    const result = await auth.authenticate(
      new Request('http://127.0.0.1/mcp', {
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(verify).toHaveBeenCalledWith(TOKEN);
    // Local owner tokens always bind direct-only, whatever verify returns.
    expect(result).toEqual({
      ok: true,
      principal: { ...owner, tenantBinding: 'direct' },
    });
  });

  it('copies a frozen scopes array from the verifier', async () => {
    const scopes = Object.freeze(['notes.read']);
    const result = await createLocalMcpTokenAuth({
      verify: async () => ({ id: 'u', tenantId: 't', kind: 'human', scopes }),
    }).authenticate(
      new Request('http://127.0.0.1/mcp', {
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.principal.scopes).toEqual(['notes.read']);
      expect(result.principal.scopes).not.toBe(scopes);
    }
  });

  it.each([
    ['no header', undefined],
    ['another scheme', `Basic ${TOKEN}`],
    ['an empty bearer', 'Bearer '],
    ['a short bearer', 'Bearer abc'],
    ['an embedded space', `Bearer ${TOKEN} extra`],
  ])('challenges %s without calling verify', async (_label, header) => {
    const verify = vi.fn(async () => owner);
    const result = await createLocalMcpTokenAuth({ verify }).authenticate(
      new Request('http://127.0.0.1/mcp', {
        headers: header ? { authorization: header } : {},
      }),
    );
    expect(verify).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      expect(result.response.headers.get('www-authenticate')).toBe(
        'Bearer error="invalid_token"',
      );
    }
  });

  it.each([
    ['null', async () => null],
    [
      'a throw',
      async () => {
        throw new Error(`database said ${TOKEN}`);
      },
    ],
    ['no tenant', async () => ({ ...owner, tenantId: '' })],
    ['no id', async () => ({ ...owner, id: '' })],
    ['missing scopes', async () => ({ id: 'u', tenantId: 't' })],
    ['bad scopes', async () => ({ ...owner, scopes: ['has space'] })],
  ])('denies %s from verify with a bare 401', async (_label, verify) => {
    const result = await createLocalMcpTokenAuth({
      verify: verify as never,
    }).authenticate(
      new Request('http://127.0.0.1/mcp', {
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      expect(await result.response.text()).toBe('');
    }
  });
});

describe('createHostedMcpResourceAuth({ runtime })', () => {
  it('keeps the local profile inert without a runtime token verifier', () => {
    expect(createHostedMcpResourceAuth({ profile: 'local' })()).toBeNull();
    expect(
      createHostedMcpResourceAuth({ profile: 'local', runtime: {} })(),
    ).toBeNull();
  });

  it('yields one cached local token adapter when the runtime verifies tokens', () => {
    const auth = createHostedMcpResourceAuth({
      profile: 'local',
      runtime: runtime(),
    });
    const adapter = auth();
    expect(adapter?.sessionFallback).toBe(true);
    expect(auth()).toBe(adapter);
  });

  it('defaults hosted identity mapping to the runtime and lets the app override it', async () => {
    const env = {
      SMRT_MCP_RESOURCE: 'https://app.example/api/mcp',
      SMRT_MCP_ISSUER: 'https://identity.example/',
      SMRT_MCP_JWKS_URI: 'https://identity.example/keys',
      SMRT_MCP_SCOPES: 'notes.read',
    };
    const resolveMcpPrincipal = vi.fn(async () => null);
    const viaRuntime = createHostedMcpResourceAuth({
      profile: 'cloud',
      env,
      runtime: { resolveMcpPrincipal },
    });
    expect(viaRuntime()?.sessionFallback).toBeUndefined();
    // A hosted runtime verifier never enables local tokens.
    const verifyLocalMcpToken = vi.fn(async () => owner);
    const hosted = createHostedMcpResourceAuth({
      profile: 'self-hosted',
      env,
      runtime: { verifyLocalMcpToken, resolveMcpPrincipal },
    })();
    const challenge = await hosted?.authenticate(
      new Request('https://app.example/api/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(challenge?.ok).toBe(false);
    expect(verifyLocalMcpToken).not.toHaveBeenCalled();
    // Without either binding the hosted profile still fails closed.
    expect(() =>
      createHostedMcpResourceAuth({ profile: 'cloud', env, runtime: {} })(),
    ).toThrow('application-owned resolvePrincipal');
  });
});

describe('mountMcpAppRoute with the local token adapter', () => {
  it('serves a valid bearer as the token owner through bindPrincipal, ignoring the cookie', async () => {
    const rt = runtime();
    const { POST, seen, bindings, bound } = route(
      createHostedMcpResourceAuth({ profile: 'local', runtime: rt }),
    );
    const response = await POST(
      rpc({ authorization: `Bearer ${TOKEN}`, locals: cookieLocals }),
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.result.structuredContent).toEqual({
      id: owner.id,
    });
    expect(bindings).toEqual([owner.id]);
    expect(bound[0]).toMatchObject({ tenantBinding: 'direct' });
    expect(seen[0]).toMatchObject({
      id: owner.id,
      tenantId: owner.tenantId,
    });
  });

  it('keeps the session principal when no Authorization header is sent', async () => {
    const rt = runtime();
    const { POST, seen, bindings } = route(
      createHostedMcpResourceAuth({ profile: 'local', runtime: rt }),
    );
    const response = await POST(rpc({ locals: cookieLocals }));
    expect(response.status).toBe(200);
    expect(rt.verifyLocalMcpToken).not.toHaveBeenCalled();
    expect(bindings).toEqual([]);
    expect(seen[0]).toMatchObject({ id: 'cookie-user' });
  });

  it('refuses an invalid, revoked or expired bearer and never falls back to the cookie', async () => {
    const rt = runtime(async () => null);
    const { POST, seen } = route(
      createHostedMcpResourceAuth({ profile: 'local', runtime: rt }),
    );
    for (const authorization of [`Bearer ${TOKEN}`, 'Bearer nope']) {
      const response = await POST(rpc({ authorization, locals: cookieLocals }));
      expect(response.status).toBe(401);
    }
    expect(seen).toEqual([]);
  });

  it('runs the origin check before verifying a bearer', async () => {
    const rt = runtime();
    const { POST, seen } = route(
      createHostedMcpResourceAuth({ profile: 'local', runtime: rt }),
    );
    const response = await POST(
      rpc({ authorization: `Bearer ${TOKEN}`, origin: 'https://evil.test' }),
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error.data.code).toBe(
      MCP_ORIGIN_DENIED_CODE,
    );
    expect(rt.verifyLocalMcpToken).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it('serves no protected-resource metadata for the local adapter', async () => {
    const GET = mountMcpProtectedResourceMetadataRoute(
      createHostedMcpResourceAuth({ profile: 'local', runtime: runtime() }),
    );
    const url = new URL(
      'http://127.0.0.1:5173/.well-known/oauth-protected-resource/mcp',
    );
    const response = await GET({ url, request: new Request(url) });
    expect(response.status).toBe(404);
  });
});
