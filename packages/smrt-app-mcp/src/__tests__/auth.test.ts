import { createServer } from 'node:http';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMcpResourceAuth, type McpResourceAuthOptions } from '../auth.js';
import { createMcpAppServer } from '../server.js';
import { mountMcpRoute } from '../sveltekit.js';

const dispatched = vi.hoisted(() =>
  vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] })),
);
vi.mock('@happyvertical/smrt-core/generators/mcp', () => ({
  MCP_STABLE_CATALOG_TTL_MS: 86400000,
  MCPGenerator: class {
    getToolIdentity() {
      return {
        objectName: 'Record',
        action: 'get',
        originalName: 'record_get',
      };
    }
    async generateTools() {
      return [
        {
          name: 'record_get',
          description: 'record',
          inputSchema: { type: 'object', properties: {} },
        },
      ];
    }
    handleToolCall = dispatched;
  },
}));

const pair = await generateKeyPair('RS256');
const jwk = {
  ...(await exportJWK(pair.publicKey)),
  kid: 'test-key',
  alg: 'RS256',
  use: 'sig',
};
const esPair = await generateKeyPair('ES256');
const esJwk = {
  ...(await exportJWK(esPair.publicKey)),
  kid: 'es-key',
  alg: 'ES256',
  use: 'sig',
};
let origin = '';
let unavailable = false;
const provider = createServer((req, res) => {
  if (req.url === '/malformed') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ keys: 'invalid' }));
    return;
  }
  if (unavailable || req.url !== '/jwks') {
    res.writeHead(503).end();
    return;
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ keys: [jwk, esJwk] }));
});
beforeAll(async () => {
  await new Promise<void>((resolve) =>
    provider.listen(0, '127.0.0.1', resolve),
  );
  const address = provider.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(() => new Promise<void>((resolve) => provider.close(() => resolve())));
function options(
  overrides: Partial<McpResourceAuthOptions> = {},
): McpResourceAuthOptions {
  return {
    profile: 'local',
    issuer: origin,
    resource: `${origin}/mcp`,
    jwksUri: `${origin}/jwks`,
    algorithms: ['RS256'],
    scopes: ['read'],
    resolvePrincipal: async ({ subject }) => ({
      id: subject,
      tenantId: 'tenant-a',
    }),
    ...overrides,
  };
}
async function token(
  claims: JWTPayload = {},
  header: Record<string, string> = {},
) {
  return new SignJWT({
    iss: origin,
    aud: `${origin}/mcp`,
    sub: 'alice',
    exp: Math.floor(Date.now() / 1000) + 60,
    scope: 'read',
    ...claims,
  })
    .setProtectedHeader({
      alg: 'RS256',
      kid: 'test-key',
      typ: 'at+jwt',
      ...header,
    })
    .sign(pair.privateKey);
}
function request(value?: string) {
  return new Request(`${origin}/mcp`, {
    headers: value === undefined ? {} : { authorization: `Bearer ${value}` },
  });
}

describe('remote protected resource', () => {
  it('publishes resource-specific metadata and a safe challenge', async () => {
    const auth = createMcpResourceAuth(options());
    expect(auth.metadataUrl).toBe(
      `${origin}/.well-known/oauth-protected-resource/mcp`,
    );
    expect(await auth.metadataResponse().json()).toEqual({
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      scopes_supported: ['read'],
      bearer_methods_supported: ['header'],
    });
    const result = await auth.authenticate(request());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(401);
    expect(result.response.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${auth.metadataUrl}", scope="read"`,
    );
    expect(await result.response.text()).toBe('');
  });
  it('wires the documented adapter around modern HTTP requests and overwrites ambient browser identity', async () => {
    let received: unknown;
    const route = mountMcpRoute({
      serverInfo: { name: 'auth-route', version: '1' },
      listTools: async ({ principal }) => {
        received = principal;
        return [];
      },
      callTool: async () => ({ content: [] }),
    });
    const auth = createMcpResourceAuth(options());
    const handle = async (bearer?: string) => {
      const request = new Request(`${origin}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': 'tools/list',
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {
            _meta: {
              [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
              [CLIENT_INFO_META_KEY]: { name: 'auth-test', version: '1' },
              [CLIENT_CAPABILITIES_META_KEY]: {},
            },
          },
        }),
      });
      const event = {
        request,
        url: new URL(request.url),
        locals: { user: { id: 'browser-user', tenantId: 'wrong' } },
      };
      const result = await auth.authenticate(event.request);
      if (!result.ok) return result.response;
      return route({
        ...event,
        locals: { ...event.locals, user: result.principal },
      });
    };
    expect((await handle()).status).toBe(401);
    expect(received).toBeUndefined();
    const response = await handle(await token());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { tools: [] } });
    expect(received).toMatchObject({ id: 'alice', tenantId: 'tenant-a' });
  });
  it.each([
    'Bearer ',
    'Bearer  ',
    'bEaReR   ',
  ])('accepts RFC 6750 ASCII spacing with %j', async (prefix) => {
    const auth = createMcpResourceAuth(options());
    const result = await auth.authenticate(
      new Request(`${origin}/mcp`, {
        headers: { authorization: `${prefix}${await token()}` },
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      principal: { id: 'alice', tenantId: 'tenant-a' },
    });
  });
  it.each([
    'Bearer\t',
    'Bearer',
    'Bearer \t',
    'Bearer opaque',
    'Bearer a.b.',
  ])('rejects invalid bearer separator or token %j before principal resolution', async (prefix) => {
    let resolutions = 0;
    const auth = createMcpResourceAuth(
      options({
        resolvePrincipal: async () => {
          resolutions += 1;
          return { id: 'alice', tenantId: 'tenant-a' };
        },
      }),
    );
    const result = await auth.authenticate(
      new Request(`${origin}/mcp`, {
        headers: { authorization: `${prefix}${await token()}` },
      }),
    );
    expect(result.ok).toBe(false);
    expect(resolutions).toBe(0);
  });
  it('verifies signatures and snapshots trusted options', async () => {
    const config = options();
    const auth = createMcpResourceAuth(config);
    config.issuer = 'https://evil.example';
    expect(await auth.authenticate(request(await token()))).toEqual({
      ok: true,
      principal: {
        id: 'alice',
        tenantId: 'tenant-a',
        scopes: ['read'],
        roles: undefined,
        kind: undefined,
      },
    });
  });
  it.each([
    ['issuer', { iss: 'https://evil.example' }],
    ['issuer slash', { iss: 'TRAILING_SLASH' }],
    ['audience', { aud: 'https://evil.example' }],
    ['expiry', { exp: 1 }],
    ['missing expiry', { exp: undefined }],
    ['missing subject', { sub: undefined }],
    ['empty subject', { sub: '' }],
    ['future nbf', { nbf: 9999999999 }],
    ['malformed scope', { scope: ['read'] }],
    ['missing scope', { scope: undefined }],
  ] as const)('rejects %s', async (_name, claims) => {
    const payload = { ...claims } as JWTPayload;
    if (payload.iss === 'TRAILING_SLASH') payload.iss = `${origin}/`;
    const result = await createMcpResourceAuth(options()).authenticate(
      request(await token(payload)),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });
  it('supports explicitly allowed ES256 and rejects it outside the configured algorithm set', async () => {
    const value = await new SignJWT({
      iss: origin,
      aud: `${origin}/mcp`,
      sub: 'alice',
      exp: Math.floor(Date.now() / 1000) + 60,
      scope: 'read',
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'es-key', typ: 'at+jwt' })
      .sign(esPair.privateKey);
    expect(
      (
        await createMcpResourceAuth(
          options({ algorithms: ['ES256'] }),
        ).authenticate(request(value))
      ).ok,
    ).toBe(true);
    expect(
      (await createMcpResourceAuth(options()).authenticate(request(value))).ok,
    ).toBe(false);
  });
  it('rejects malformed JWKS and retains only the documented key cache during an outage', async () => {
    const value = await token();
    expect(
      (
        await createMcpResourceAuth(
          options({ jwksUri: `${origin}/malformed` }),
        ).authenticate(request(value))
      ).ok,
    ).toBe(false);
    const auth = createMcpResourceAuth(options());
    expect((await auth.authenticate(request(value))).ok).toBe(true);
    unavailable = true;
    try {
      expect((await auth.authenticate(request(value))).ok).toBe(true);
    } finally {
      unavailable = false;
    }
  });
  it('returns insufficient_scope without revealing claims', async () => {
    const result = await createMcpResourceAuth(options()).authenticate(
      request(await token({ scope: 'write' })),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      expect(result.response.headers.get('www-authenticate')).toContain(
        'error="insufficient_scope"',
      );
    }
  });
  it('rejects malformed, unknown-key, wrong-type, wrong-key and disallowed-algorithm tokens', async () => {
    const other = await generateKeyPair('RS256');
    const wrongKey = await new SignJWT({
      iss: origin,
      aud: `${origin}/mcp`,
      sub: 'alice',
      exp: Math.floor(Date.now() / 1000) + 60,
      scope: 'read',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key', typ: 'at+jwt' })
      .sign(other.privateKey);
    const es = await generateKeyPair('ES256');
    const wrongAlg = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
      .sign(es.privateKey);
    for (const value of [
      'secret',
      'x.y.z',
      wrongKey,
      wrongAlg,
      await token({}, { kid: 'unknown' }),
      await token({}, { typ: 'JWT' }),
    ]) {
      const result = await createMcpResourceAuth(options()).authenticate(
        request(value),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(await result.response.text()).not.toContain(value);
    }
  });
  it('fails closed when signing keys or application provider are unavailable', async () => {
    unavailable = true;
    try {
      expect(
        (
          await createMcpResourceAuth(options()).authenticate(
            request(await token()),
          )
        ).ok,
      ).toBe(false);
    } finally {
      unavailable = false;
    }
    const auth = createMcpResourceAuth(
      options({
        resolvePrincipal: async () => {
          throw new Error('private provider failure');
        },
      }),
    );
    const result = await auth.authenticate(request(await token()));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(await result.response.text()).toBe('');
  });
  it.each([
    null,
    { id: '' },
    { id: 'alice' },
    { id: 'alice', tenantId: '' },
    { id: 'alice', tenantId: ' a' },
    { id: 'alice', tenantId: 'a\nb' },
    { id: 'alice', tenantId: 'a', roles: [4] },
  ])('rejects malformed mapping %j', async (mapping) => {
    const auth = createMcpResourceAuth(
      options({ resolvePrincipal: async () => mapping as never }),
    );
    expect((await auth.authenticate(request(await token()))).ok).toBe(false);
  });
  it('rechecks active tenant and membership on every reconnect; token tenant is not authority', async () => {
    let active: string | null = 'a';
    const auth = createMcpResourceAuth(
      options({
        resolvePrincipal: async ({ subject }) =>
          active && ['alice', 'bob'].includes(subject)
            ? { id: subject, tenantId: active }
            : null,
      }),
    );
    for (const actor of ['alice', 'bob', 'unknown']) {
      for (const tenant of ['a', 'b']) {
        active = tenant;
        const result = await auth.authenticate(
          request(await token({ sub: actor, tenantId: 'attacker' })),
        );
        expect(result.ok).toBe(actor !== 'unknown');
        if (result.ok) {
          for (const owner of ['alice', 'bob'])
            for (const resourceTenant of ['a', 'b']) {
              const server = createMcpAppServer({
                serverInfo: { name: 'ownership-fixture', version: '1' },
                smrtOptions: () => ({}),
                allowedClassNames: ['Record'],
                resources: [
                  {
                    uri: 'ui://auth/v1/view.html',
                    version: 'v1',
                    name: 'View',
                    html: '<!doctype html><title>View</title>',
                  },
                ],
                resourcePolicy: ({ principal }) =>
                  principal?.id === owner &&
                  principal.tenantId === resourceTenant,
                toolPolicy: ({ principal }) =>
                  principal?.id === owner &&
                  principal.tenantId === resourceTenant,
              });
              dispatched.mockClear();
              const call = server.callTool({
                name: 'record_get',
                principal: result.principal,
                arguments: { owner: actor, tenantId: tenant },
              });
              if (actor === owner && tenant === resourceTenant) {
                await expect(call).resolves.toBeDefined();
                expect(dispatched).toHaveBeenCalledTimes(1);
                expect(
                  await server.listResources?.({ principal: result.principal }),
                ).toHaveLength(1);
                await expect(
                  server.readResource?.({
                    uri: 'ui://auth/v1/view.html',
                    principal: result.principal,
                  }),
                ).resolves.toMatchObject({
                  text: '<!doctype html><title>View</title>',
                });
              } else {
                await expect(call).rejects.toMatchObject({ status: 403 });
                expect(dispatched).not.toHaveBeenCalled();
                expect(
                  await server.listResources?.({ principal: result.principal }),
                ).toEqual([]);
                await expect(
                  server.readResource?.({
                    uri: 'ui://auth/v1/view.html',
                    principal: result.principal,
                  }),
                ).rejects.toMatchObject({ status: 404 });
              }
            }
        }
      }
    }
    const reconnect = request(await token());
    active = 'a';
    expect((await auth.authenticate(reconnect)).ok).toBe(true);
    active = null;
    expect((await auth.authenticate(reconnect)).ok).toBe(false);
  });
  it('accepts explicit single-tenant mapping without granting cross-tenant override', async () => {
    const auth = createMcpResourceAuth(
      options({
        requireTenant: false,
        resolvePrincipal: async () => ({ id: 'alice', allowCrossTenant: true }),
      }),
    );
    const result = await auth.authenticate(request(await token()));
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.principal).not.toHaveProperty('allowCrossTenant');
  });
  it.each([
    'self-hosted',
    'cloud',
  ] as const)('supports HTTPS %s and rejects plaintext', (profile) => {
    expect(() => createMcpResourceAuth(options({ profile }))).toThrow();
    expect(
      createMcpResourceAuth(
        options({
          profile,
          resource: 'https://mcp.example/mcp',
          issuer: 'https://auth.example/',
          jwksUri: 'https://auth.example/keys',
        }),
      ).metadataUrl,
    ).toBe('https://mcp.example/.well-known/oauth-protected-resource/mcp');
  });
  it('rejects unsafe/unknown profile configuration', () => {
    for (const patch of [
      { profile: 'unknown' },
      { resource: 'https://public.example/mcp' },
      { issuer: `${origin}/?secret=x` },
      { jwksUri: 'http://user:password@localhost/keys' },
      { scopes: ['x"\r\n'] },
      { algorithms: ['HS256'] },
      { tokenType: 'unknown' },
    ]) {
      expect(() => createMcpResourceAuth(options(patch as never))).toThrow();
    }
  });
});
