/** Hosted protected-resource factory replacing the template's mcp-hosted.ts (#3373). */

import { describe, expect, it, vi } from 'vitest';
import { createHostedMcpResourceAuth, HOSTED_MCP_AUTH_ENV } from '../auth.js';

const env = {
  SMRT_MCP_RESOURCE: 'https://app.example/api/mcp',
  SMRT_MCP_ISSUER: 'https://identity.example/',
  SMRT_MCP_JWKS_URI: 'https://identity.example/keys',
  SMRT_MCP_SCOPES: ' items.read  items.write ',
};
const resolvePrincipal = async () => null;

describe('createHostedMcpResourceAuth', () => {
  it('disables bearer authentication for the local profile without reading configuration', () => {
    const resolve = vi.fn(resolvePrincipal);
    const auth = createHostedMcpResourceAuth({
      profile: 'local',
      env: {},
      resolvePrincipal: resolve,
    });
    expect(auth()).toBeNull();
  });

  it('builds one cached adapter from operator environment', async () => {
    const auth = createHostedMcpResourceAuth({
      profile: () => 'self-hosted',
      env,
      resolvePrincipal,
    });
    const first = auth();
    expect(first).not.toBeNull();
    expect(auth()).toBe(first);
    expect(first?.metadataUrl).toBe(
      'https://app.example/.well-known/oauth-protected-resource/api/mcp',
    );
    expect(await first?.metadataResponse().json()).toEqual({
      resource: 'https://app.example/api/mcp',
      authorization_servers: ['https://identity.example/'],
      scopes_supported: ['items.read', 'items.write'],
      bearer_methods_supported: ['header'],
    });
    const challenge = await first!.authenticate(
      new Request('https://app.example/api/mcp', { method: 'POST' }),
    );
    expect(challenge.ok).toBe(false);
    if (!challenge.ok) expect(challenge.response.status).toBe(401);
  });

  it.each(
    Object.values(HOSTED_MCP_AUTH_ENV),
  )('fails closed when %s is missing', (name) => {
    const auth = createHostedMcpResourceAuth({
      profile: 'cloud',
      env: { ...env, [name]: '  ' },
      resolvePrincipal,
    });
    expect(() => auth()).toThrow(`Hosted MCP requires ${name}.`);
  });

  it('requires an application-owned principal binding for hosted profiles', () => {
    const auth = createHostedMcpResourceAuth({ profile: 'self-hosted', env });
    expect(() => auth()).toThrow('application-owned resolvePrincipal');
  });

  it('retries a failed construction instead of caching it', () => {
    const mutable: Record<string, string | undefined> = {
      ...env,
      SMRT_MCP_ISSUER: undefined,
    };
    const auth = createHostedMcpResourceAuth({
      profile: 'self-hosted',
      env: mutable,
      resolvePrincipal,
    });
    expect(() => auth()).toThrow('SMRT_MCP_ISSUER');
    mutable.SMRT_MCP_ISSUER = env.SMRT_MCP_ISSUER;
    const recovered = auth();
    expect(recovered).not.toBeNull();
    expect(auth()).toBe(recovered);
  });

  it('rejects non-HTTPS hosted configuration through the existing validator', () => {
    const auth = createHostedMcpResourceAuth({
      profile: 'cloud',
      env: { ...env, SMRT_MCP_JWKS_URI: 'http://identity.example/keys' },
      resolvePrincipal,
    });
    expect(() => auth()).toThrow('Invalid MCP authorization URL');
  });

  describe('runtime.mcpSelfIssuer (#5080)', () => {
    const payload = {
      sub: 'u1',
      scope: 'items.read items.write',
      tenant_id: 't1',
    };
    const bearer = new Request('https://app.example/api/mcp', {
      method: 'POST',
      headers: { authorization: 'Bearer aaa.bbb.ccc' },
    });
    const build = (live: boolean) => {
      const verifyAccessToken = vi.fn(async () => payload);
      const validateGrant = vi.fn(async () => live);
      const auth = createHostedMcpResourceAuth({
        profile: 'cloud',
        env: {
          SMRT_MCP_RESOURCE: env.SMRT_MCP_RESOURCE,
          SMRT_MCP_SCOPES: 'items.read',
        },
        runtime: {
          mcpSelfIssuer: {
            issuer: 'https://app.example/oauth',
            verifyAccessToken,
            validateGrant,
          },
          resolveMcpPrincipal: async () => ({ id: 'u1', tenantId: 't1' }),
        },
      })();
      return { auth: auth!, verifyAccessToken, validateGrant };
    };

    it('needs no issuer or JWKS environment and advertises its own issuer', async () => {
      const { auth } = build(true);
      expect(
        (await auth.metadataResponse().json()).authorization_servers,
      ).toEqual(['https://app.example/oauth']);
    });

    it('verifies in process with the resource as audience and checks liveness per call', async () => {
      const { auth, verifyAccessToken, validateGrant } = build(true);
      const result = await auth.authenticate(bearer);
      expect(result.ok).toBe(true);
      expect(verifyAccessToken).toHaveBeenCalledWith(
        'aaa.bbb.ccc',
        env.SMRT_MCP_RESOURCE,
      );
      await auth.authenticate(bearer);
      expect(validateGrant).toHaveBeenCalledTimes(2);
    });

    it('fails closed when the grant is not live', async () => {
      const { auth } = build(false);
      const result = await auth.authenticate(bearer);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(401);
    });
  });
});
