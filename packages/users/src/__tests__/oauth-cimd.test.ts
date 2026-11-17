import { createHash, randomBytes } from 'node:crypto';
import {
  InMemoryOAuthAuthorizationStorage,
  OAuthAuthorizationServer,
} from '@happyvertical/auth/server';
import { exportJWK, generateKeyPair } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import {
  type CimdFetcher,
  type CimdRejectionReason,
  createCimdAuthorizationServer,
  createSafeCimdFetcher,
  isBlockedCimdAddress,
} from '../services/index.js';

const issuer = 'https://auth.example/oauth';
const clientId = 'https://client.example/oauth/client.json';
const redirectUri = 'https://client.example/callback';
const doc = (extra: Record<string, unknown> = {}) => ({
  client_id: clientId,
  client_name: 'Example',
  redirect_uris: [redirectUri],
  token_endpoint_auth_method: 'none',
  grant_types: ['authorization_code'],
  response_types: ['code'],
  ...extra,
});
const json =
  (body: unknown, headers: Record<string, string> = {}) =>
  async () => ({
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

async function build(
  fetcher: CimdFetcher | undefined,
  cimd: Record<string, unknown> | false = {},
) {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const rejected: [string, CimdRejectionReason][] = [];
  const server = createCimdAuthorizationServer({
    issuer,
    signingKey: {
      privateKey,
      publicKey,
      publicJwk: await exportJWK(publicKey),
      algorithm: 'ES256',
      keyId: 'k1',
    },
    storage: new InMemoryOAuthAuthorizationStorage(),
    identity: { revalidateConsent: async (context) => context },
    scopes: ['read'],
    ...(cimd === false
      ? {}
      : {
          clientIdMetadataDocuments: {
            allowClientOrigin: () => true,
            ...(fetcher ? { fetcher } : {}),
            onRejected: (id: string, reason: CimdRejectionReason) =>
              rejected.push([id, reason]),
            ...cimd,
          },
        }),
  });
  return { server, rejected };
}
const authorizeParams = (verifier: string, id = clientId, uri = redirectUri) =>
  new URLSearchParams({
    response_type: 'code',
    client_id: id,
    redirect_uri: uri,
    scope: 'read',
    state: 'xyz',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  });

describe('Client ID Metadata Documents (#5081)', () => {
  it('completes authorization code + PKCE with no prior registration', async () => {
    const fetcher = vi.fn<CimdFetcher>(json(doc()));
    const { server } = await build(fetcher);
    const verifier = randomBytes(32).toString('base64url');
    const request = await server.parseAuthorizationRequest(
      authorizeParams(verifier),
    );
    const redirect = await server.approve(request, { subject: 'user-1' });
    const code = new URL(redirect.redirectUri).searchParams.get('code') ?? '';
    const token = await server.token(
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    );
    expect(token.token_type).toBe('Bearer');
    expect(token.scope).toBe('read');
    // One fetch served authorize, approve and token from the cache.
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('advertises support in RFC 8414 metadata only when enabled', async () => {
    const on = await build(json(doc()));
    expect(on.server.discovery()).toMatchObject({
      client_id_metadata_document_supported: true,
    });
    const served = await on.server.handle(
      new Request(
        'https://auth.example/.well-known/oauth-authorization-server/oauth',
      ),
    );
    expect((await served.json()).client_id_metadata_document_supported).toBe(
      true,
    );
    const off = await build(undefined, false);
    expect(off.server.discovery()).not.toHaveProperty(
      'client_id_metadata_document_supported',
    );
  });

  it('is disabled by default: https client_ids stay unknown and nothing is fetched', async () => {
    const fetcher = vi.fn<CimdFetcher>(json(doc()));
    const { server } = await build(fetcher, false);
    expect(server).toBeInstanceOf(OAuthAuthorizationServer);
    await expect(
      server.parseAuthorizationRequest(authorizeParams('v'.repeat(43))),
    ).rejects.toThrow(/Unknown client/u);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('refuses enabling without an origin policy', async () => {
    await expect(
      build(json(doc()), { allowClientOrigin: undefined }),
    ).rejects.toThrow(/allowClientOrigin/u);
  });

  const refused: [string, CimdFetcher, CimdRejectionReason][] = [
    ['malformed JSON', json('{not json'), 'malformed_document'],
    ['array document', json([]), 'malformed_document'],
    [
      'client_id mismatch',
      json(doc({ client_id: `${clientId}x` })),
      'invalid_document',
    ],
    [
      'missing redirect_uris',
      json(doc({ redirect_uris: undefined })),
      'invalid_document',
    ],
    [
      'http redirect',
      json(doc({ redirect_uris: ['http://client.example/cb'] })),
      'invalid_document',
    ],
    [
      'secret-based auth',
      json(doc({ token_endpoint_auth_method: 'client_secret_post' })),
      'invalid_document',
    ],
    [
      'embedded secret',
      json(doc({ client_secret: 's3cret' })),
      'invalid_document',
    ],
    [
      'unsupported grant',
      json(doc({ grant_types: ['password'] })),
      'invalid_document',
    ],
    [
      'wrong content type',
      json(doc(), { 'content-type': 'text/html' }),
      'content_type',
    ],
    [
      'non-200',
      async () => ({
        status: 302,
        headers: { location: 'https://x.example/' },
        body: '',
      }),
      'http_status',
    ],
    [
      'fetch error',
      async () => {
        throw new Error('boom');
      },
      'fetch_failed',
    ],
  ];
  it.each(refused)('refuses %s', async (_name, fetcher, reason) => {
    const { server, rejected } = await build(fetcher);
    await expect(
      server.parseAuthorizationRequest(authorizeParams('v'.repeat(43))),
    ).rejects.toThrow(/Unknown client/u);
    expect(rejected).toEqual([[clientId, reason]]);
  });

  it('refuses a request redirect_uri that is not in the document exactly', async () => {
    const { server } = await build(json(doc()));
    for (const uri of [
      'https://evil.example/callback',
      `${redirectUri}/`,
      `${redirectUri}?x=1`,
    ])
      await expect(
        server.parseAuthorizationRequest(
          authorizeParams('v'.repeat(43), clientId, uri),
        ),
      ).rejects.toThrow(/redirect_uri/u);
  });

  it('refuses oversize documents', async () => {
    const big = json(doc({ client_name: 'x'.repeat(40_000) }));
    const { server, rejected } = await build(big);
    await expect(
      server.parseAuthorizationRequest(authorizeParams('v'.repeat(43))),
    ).rejects.toThrow(/Unknown client/u);
    expect(rejected[0][1]).toBe('malformed_document');
  });

  it('consults the origin policy on every request and fails closed', async () => {
    const fetcher = vi.fn<CimdFetcher>(json(doc()));
    let allow: boolean | 'throw' = true;
    const { server, rejected } = await build(fetcher, {
      allowClientOrigin: (origin: string, id: string) => {
        expect(origin).toBe('https://client.example');
        expect(id).toBe(clientId);
        if (allow === 'throw') throw new Error('policy down');
        return allow;
      },
    });
    const params = authorizeParams('v'.repeat(43));
    await server.parseAuthorizationRequest(params);
    allow = false; // cached document must not bypass a changed policy
    await expect(server.parseAuthorizationRequest(params)).rejects.toThrow();
    allow = 'throw';
    await expect(server.parseAuthorizationRequest(params)).rejects.toThrow();
    expect(rejected.map(([, reason]) => reason)).toEqual([
      'origin_denied',
      'origin_denied',
    ]);
    const denied = await build(fetcher, { allowClientOrigin: () => false });
    await expect(
      denied.server.parseAuthorizationRequest(params),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    'https://127.0.0.1/c.json',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/c.json',
    'https://10.0.0.5/c.json',
    'https://localhost/c.json',
    'https://metadata/c.json',
    'https://svc.internal/c.json',
    'https://client.example/',
    'https://client.example',
    'https://client.example:8443/c.json',
    'https://user:pw@client.example/c.json',
    'https://client.example/c.json#frag',
    'https://client.example/c.json?x=1',
    'https://client.example/c.json?',
    'https://client.example/a/../c.json',
    'https://client.example/a/%2e%2e/c.json',
    'http://client.example/c.json',
  ])('never fetches client_id %s', async (id) => {
    const fetcher = vi.fn<CimdFetcher>(json(doc()));
    const { server } = await build(fetcher);
    await expect(
      server.parseAuthorizationRequest(authorizeParams('v'.repeat(43), id)),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  describe('caching', () => {
    it('honours Cache-Control within bounds and re-fetches after expiry', async () => {
      let t = 1_000_000;
      const fetcher = vi.fn<CimdFetcher>(
        json(doc(), { 'cache-control': 'max-age=120' }),
      );
      const { server } = await build(fetcher, { now: () => t });
      const params = authorizeParams('v'.repeat(43));
      await server.parseAuthorizationRequest(params);
      t += 119_000;
      await server.parseAuthorizationRequest(params);
      expect(fetcher).toHaveBeenCalledTimes(1);
      t += 2_000;
      await server.parseAuthorizationRequest(params);
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it.each([
      ['no-store', 60_000, 61_000],
      ['max-age=1', 60_000, 61_000],
      ['max-age=999999999', 86_400_000, 86_401_000],
    ])('bounds %s to the configured floor/ceiling', async (header, within, past) => {
      let t = 0;
      const fetcher = vi.fn<CimdFetcher>(
        json(doc(), { 'cache-control': header }),
      );
      const { server } = await build(fetcher, { now: () => t });
      const params = authorizeParams('v'.repeat(43));
      await server.parseAuthorizationRequest(params);
      t = within - 1;
      await server.parseAuthorizationRequest(params);
      expect(fetcher).toHaveBeenCalledTimes(1);
      t = past;
      await server.parseAuthorizationRequest(params);
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('briefly remembers failures so a bad client cannot drive fetches', async () => {
      const fetcher = vi.fn<CimdFetcher>(json('nope'));
      const { server } = await build(fetcher);
      const params = authorizeParams('v'.repeat(43));
      for (let i = 0; i < 3; i++)
        await expect(
          server.parseAuthorizationRequest(params),
        ).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  });

  it('bounds a never-settling fetcher by timeoutMs and then failure-caches', async () => {
    const fetcher = vi.fn<CimdFetcher>(() => new Promise(() => {}));
    const { server, rejected } = await build(fetcher, { timeoutMs: 20 });
    const params = authorizeParams('v'.repeat(43));
    await expect(server.parseAuthorizationRequest(params)).rejects.toThrow();
    await expect(server.parseAuthorizationRequest(params)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(rejected[0][1]).toBe('fetch_failed');
  });

  it('caps concurrent cache-miss fetches and refuses the excess without caching it', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetcher = vi.fn<CimdFetcher>(async (url) => {
      await gate;
      return json({ ...doc(), client_id: url.href })();
    });
    const { server, rejected } = await build(fetcher, {
      maxConcurrentFetches: 2,
    });
    const ids = [1, 2, 3].map((n) => `https://c${n}.example/m.json`);
    const calls = ids.map((id) =>
      server
        .parseAuthorizationRequest(authorizeParams('v'.repeat(43), id))
        .then(
          () => 'ok',
          () => 'refused',
        ),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    release?.();
    expect(await Promise.all(calls)).toEqual(['ok', 'ok', 'refused']);
    expect(rejected).toEqual([[ids[2], 'too_busy']]);
    // Not failure-cached: succeeds once capacity is free.
    await server.parseAuthorizationRequest(
      authorizeParams('v'.repeat(43), ids[2]),
    );
  });

  it('bounds the default fetcher DNS lookup by timeoutMs', async () => {
    await expect(
      createSafeCimdFetcher({ resolveHostname: () => new Promise(() => {}) })(
        new URL(clientId),
        { timeoutMs: 20, maxBytes: 1024 },
      ),
    ).rejects.toThrow(/timed out/u);
  });

  describe('default fetcher SSRF guard', () => {
    const limits = { timeoutMs: 1000, maxBytes: 1024 };
    it('blocks non-public address classes', () => {
      for (const address of [
        '0.0.0.0',
        '10.1.2.3',
        '100.64.0.1',
        '127.0.0.1',
        '169.254.169.254',
        '172.16.0.1',
        '192.168.1.1',
        '198.18.0.1',
        '224.0.0.1',
        '255.255.255.255',
        '::',
        '::1',
        'fe80::1',
        'fc00::1',
        'ff02::1',
        '::ffff:127.0.0.1',
        '::ffff:7f00:1',
        '64:ff9b::7f00:1',
        '2002:7f00:1::',
        '2001:db8::1',
        'not-an-ip',
      ])
        expect(isBlockedCimdAddress(address), address).toBe(true);
      for (const address of ['93.184.216.34', '8.8.8.8', '2606:2800:220:1::1'])
        expect(isBlockedCimdAddress(address), address).toBe(false);
    });
    it('refuses a public name that resolves (even partly) to a private address', async () => {
      for (const addresses of [
        [{ address: '127.0.0.1' }],
        [{ address: '93.184.216.34' }, { address: '10.0.0.1' }],
        [{ address: '::1' }],
        [],
      ])
        await expect(
          createSafeCimdFetcher({ resolveHostname: async () => addresses })(
            new URL(clientId),
            limits,
          ),
        ).rejects.toThrow(/public address/u);
    });
    it('refuses non-https', async () => {
      await expect(
        createSafeCimdFetcher({ resolveHostname: async () => [] })(
          new URL('http://client.example/c.json'),
          limits,
        ),
      ).rejects.toThrow(/https/u);
    });
  });
});
