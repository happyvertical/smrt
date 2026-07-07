import { clearCache, setConfig } from '@happyvertical/smrt-config';
import {
  createIsolatedTestDb,
  type IsolatedTestDbResult,
} from '@happyvertical/smrt-vitest';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  decodeOidcTransaction,
  encodeOidcTransaction,
  OidcLoginService,
  type OidcTransaction,
  resolveOidcProviderConfig,
} from '../services/OidcLoginService.js';
import {
  beginOidcLogin,
  createOidcCallbackHandler,
} from '../sveltekit/index.js';
import {
  closeAllOidcServers,
  OIDC_USERS_TEST_SCHEMA,
  startOidcServer,
} from './helpers/oidc-test-server.js';

async function createOidcTestDb(): Promise<IsolatedTestDbResult> {
  return createIsolatedTestDb({ schema: OIDC_USERS_TEST_SCHEMA });
}

function toFetchUrl(input: Parameters<typeof fetch>[0]): string {
  if (input instanceof Request) return input.url;
  if (input instanceof URL) return input.toString();
  return String(input);
}

function createCookieJar(initial: Record<string, string> = {}) {
  const jar = new Map(Object.entries(initial));
  const setOptions = new Map<string, Record<string, unknown> | undefined>();
  const deleted: Array<{ name: string; options?: Record<string, unknown> }> =
    [];

  return {
    cookies: {
      delete: (name: string, options?: Record<string, unknown>) => {
        deleted.push({ name, options });
        jar.delete(name);
      },
      get: (name: string) => jar.get(name),
      set: (name: string, value: string, options?: Record<string, unknown>) => {
        jar.set(name, value);
        setOptions.set(name, options);
      },
    },
    deleted,
    jar,
    setOptions,
  };
}

describe('OidcLoginService', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    clearCache();

    while (cleanup.length > 0) {
      await cleanup.pop()?.();
    }
  });

  afterAll(async () => {
    await closeAllOidcServers();
  });

  it('resolves Kanidm and Dex provider config from packages.users.auth.oidc', () => {
    setConfig({
      packages: {
        users: {
          auth: {
            oidc: {
              defaultProvider: 'kanidm',
              providers: {
                dex: {
                  clientId: 'dex-client',
                  issuer: 'https://dex.example.com/dex',
                  kind: 'dex',
                },
                kanidm: {
                  clientId: 'kanidm-client',
                  issuer: 'https://idm.example.com/oauth2/openid/smrt',
                  kind: 'kanidm',
                },
              },
            },
          },
        },
      },
    });

    expect(resolveOidcProviderConfig().provider).toMatchObject({
      clientId: 'kanidm-client',
      kind: 'kanidm',
    });
    expect(resolveOidcProviderConfig('dex').provider).toMatchObject({
      clientId: 'dex-client',
      kind: 'dex',
    });
  });

  it('round-trips login transaction cookies', () => {
    const transaction: OidcTransaction = {
      codeVerifier: 'verifier',
      createdAt: Date.now(),
      nonce: 'nonce',
      provider: 'kanidm',
      returnTo: '/dashboard',
      state: 'state',
    };

    expect(decodeOidcTransaction(encodeOidcTransaction(transaction))).toEqual(
      transaction,
    );
  });

  it('signs OIDC transaction cookies and uses cross-site cookie defaults on HTTPS', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          authorization_endpoint: 'https://dex.example.com/dex/auth',
          issuer: 'https://dex.example.com/dex',
          jwks_uri: 'https://dex.example.com/dex/jwks',
          token_endpoint: 'https://dex.example.com/dex/token',
        }),
        { headers: { 'content-type': 'application/json' }, status: 200 },
      );
    });
    const { cookies, jar, setOptions } = createCookieJar();
    const url = new URL(
      'https://app.example.com/auth/dex/login?returnTo=/dashboard',
    );

    await beginOidcLogin(
      {
        cookies,
        params: { provider: 'dex' },
        request: new Request(url),
        url,
      },
      {
        db: { type: 'sqlite', url: ':memory:' },
        fetch: fetchMock,
        provider: 'dex',
        providers: {
          dex: {
            clientId: 'smrt-client',
            clientSecret: 'secret',
            issuer: 'https://dex.example.com/dex',
            redirectUri: 'https://app.example.com/auth/dex/callback',
          },
        },
      },
    );

    expect(jar.get('smrt_oidc_dex')).toContain('.');
    expect(setOptions.get('smrt_oidc_dex')).toMatchObject({
      httpOnly: true,
      sameSite: 'none',
      secure: true,
    });
  });

  it('rejects OIDC transaction cookies with invalid signatures', async () => {
    const transaction: OidcTransaction = {
      codeVerifier: 'verifier',
      createdAt: Date.now(),
      nonce: 'nonce',
      provider: 'dex',
      returnTo: '/dashboard',
      state: 'state',
    };
    const { cookies, jar } = createCookieJar({
      smrt_oidc_dex: `${encodeOidcTransaction(transaction)}.invalid`,
    });
    const callbackUrl = new URL(
      'https://app.example.com/auth/dex/callback?code=code&state=state',
    );
    const handler = createOidcCallbackHandler({
      db: { type: 'sqlite', url: ':memory:' },
      provider: 'dex',
      providers: {
        dex: {
          clientId: 'smrt-client',
          clientSecret: 'secret',
          issuer: 'https://dex.example.com/dex',
          redirectUri: 'https://app.example.com/auth/dex/callback',
        },
      },
    });

    const response = await handler({
      cookies,
      params: { provider: 'dex' },
      request: new Request(callbackUrl),
      url: callbackUrl,
    });

    expect(response.status).toBe(401);
    await expect(response.text()).resolves.toContain('signature');
    expect(jar.has('smrt_oidc_dex')).toBe(false);
  });

  it('builds a PKCE authorization URL for Kanidm-compatible OIDC', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          authorization_endpoint:
            'https://idm.example.com/oauth2/openid/smrt/auth',
          issuer: 'https://idm.example.com/oauth2/openid/smrt',
          jwks_uri: 'https://idm.example.com/oauth2/openid/smrt/jwks',
          token_endpoint: 'https://idm.example.com/oauth2/openid/smrt/token',
        }),
        { headers: { 'content-type': 'application/json' }, status: 200 },
      );
    });
    const service = new OidcLoginService({
      db: { type: 'sqlite', url: ':memory:' },
      fetch: fetchMock,
      provider: {
        clientId: 'smrt-kanidm',
        issuer: 'https://idm.example.com/oauth2/openid/smrt',
        kind: 'kanidm',
        redirectUri: 'http://localhost:5173/auth/kanidm/callback',
        scopes: ['openid', 'profile', 'email', 'groups'],
      },
      providerName: 'kanidm',
    });
    const transaction: OidcTransaction = {
      codeVerifier: 'test-code-verifier',
      createdAt: 1,
      nonce: 'nonce-123',
      provider: 'kanidm',
      state: 'state-123',
    };

    const { url } = await service.createAuthorizationUrl({ transaction });

    expect(url.origin).toBe('https://idm.example.com');
    expect(url.pathname).toBe('/oauth2/openid/smrt/auth');
    expect(url.searchParams.get('client_id')).toBe('smrt-kanidm');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:5173/auth/kanidm/callback',
    );
    expect(url.searchParams.get('scope')).toBe('openid profile email groups');
    expect(url.searchParams.get('state')).toBe('state-123');
    expect(url.searchParams.get('nonce')).toBe('nonce-123');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('exchanges a Dex-compatible callback, verifies the ID token, and creates a SMRT user', async () => {
    const server = await startOidcServer();
    cleanup.push(server.close);
    const isolated = await createOidcTestDb();
    cleanup.push(isolated.cleanup);
    const { db } = isolated;

    const fetchSpy = vi.fn(
      (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        fetch(input, init),
    );
    const service = new OidcLoginService({
      db,
      fetch: fetchSpy,
      provider: {
        clientId: 'smrt-client',
        clientSecret: 'secret',
        issuer: server.issuer,
        kind: 'dex',
        redirectUri: `${server.issuer}/auth/dex/callback`,
      },
      providerName: 'dex',
    });
    const transaction = service.createTransaction('/dashboard');
    server.setNonce(transaction.nonce);

    const callbackUrl = new URL(`${server.issuer}/auth/dex/callback`);
    callbackUrl.searchParams.set('code', 'authorization-code');
    callbackUrl.searchParams.set('state', transaction.state);
    callbackUrl.searchParams.set('iss', server.issuer);

    const result = await service.completeLogin(callbackUrl, transaction);

    expect(result.user.email).toBe('dex.user@example.com');
    expect(result.user.lastLoginAt).toBeInstanceOf(Date);
    expect(result.profile.email).toBe('dex.user@example.com');
    expect(result.oidcIdentity.provider).toBe('dex');
    expect(result.oidcIdentity.subject).toBe('dex-user-123');
    expect(result.claims.email_verified).toBe(true);
    expect(result.created).toBe(true);

    expect(server.tokenRequests).toHaveLength(1);
    expect(server.tokenRequests[0]?.authorization).toBe(
      `Basic ${btoa('smrt-client:secret')}`,
    );
    expect(server.tokenRequests[0]?.params.get('code_verifier')).toBe(
      transaction.codeVerifier,
    );

    const fetchUrls = fetchSpy.mock.calls.map(([input]) => toFetchUrl(input));
    expect(fetchUrls).toContain(`${server.issuer}/jwks`);
  });

  it('form-encodes client credentials for client_secret_basic token requests', async () => {
    const clientId = 'smrt client:dev@local';
    const clientSecret = 's:e+c ret ü';
    const server = await startOidcServer({ audience: clientId });
    cleanup.push(server.close);
    const service = new OidcLoginService({
      db: { type: 'sqlite', url: ':memory:' },
      provider: {
        clientId,
        clientSecret,
        issuer: server.issuer,
        kind: 'dex',
        redirectUri: `${server.issuer}/auth/dex/callback`,
      },
      providerName: 'dex',
    });
    const transaction = service.createTransaction('/dashboard');
    server.setNonce(transaction.nonce);

    const callbackUrl = new URL(`${server.issuer}/auth/dex/callback`);
    callbackUrl.searchParams.set('code', 'authorization-code');
    callbackUrl.searchParams.set('state', transaction.state);

    await service.exchangeCallback(callbackUrl, transaction);

    const encodeForm = (value: string): string => {
      const params = new URLSearchParams();
      params.set('value', value);
      return params.toString().slice('value='.length);
    };
    const expectedCredentials = `${encodeForm(clientId)}:${encodeForm(clientSecret)}`;

    expect(expectedCredentials).toBe(
      'smrt+client%3Adev%40local:s%3Ae%2Bc+ret+%C3%BC',
    );
    expect(server.tokenRequests[0]?.authorization).toBe(
      `Basic ${Buffer.from(expectedCredentials, 'utf8').toString('base64')}`,
    );
  });

  it('uses the userinfo endpoint when the ID token omits required email claims', async () => {
    const server = await startOidcServer({ includeEmailInIdToken: false });
    cleanup.push(server.close);
    const isolated = await createOidcTestDb();
    cleanup.push(isolated.cleanup);
    const { db } = isolated;

    const service = new OidcLoginService({
      db,
      provider: {
        clientId: 'smrt-client',
        clientSecret: 'secret',
        issuer: server.issuer,
        kind: 'dex',
        redirectUri: `${server.issuer}/auth/dex/callback`,
      },
      providerName: 'dex',
    });
    const transaction = service.createTransaction('/dashboard');
    server.setNonce(transaction.nonce);

    const callbackUrl = new URL(`${server.issuer}/auth/dex/callback`);
    callbackUrl.searchParams.set('code', 'authorization-code');
    callbackUrl.searchParams.set('state', transaction.state);

    const result = await service.completeLogin(callbackUrl, transaction);

    expect(result.user.email).toBe('dex.user@example.com');
    expect(result.claims.email).toBe('dex.user@example.com');
    expect(server.userinfoRequests).toHaveLength(1);
    expect(server.userinfoRequests[0]?.authorization).toBe(
      'Bearer access-token',
    );
  });

  it('rejects multi-audience ID tokens with a mismatched authorized party', async () => {
    const server = await startOidcServer({
      audience: ['smrt-client', 'other-client'],
      authorizedParty: 'other-client',
    });
    cleanup.push(server.close);
    const service = new OidcLoginService({
      db: { type: 'sqlite', url: ':memory:' },
      provider: {
        clientId: 'smrt-client',
        clientSecret: 'secret',
        issuer: server.issuer,
        kind: 'dex',
        redirectUri: `${server.issuer}/auth/dex/callback`,
      },
      providerName: 'dex',
    });
    const transaction = service.createTransaction('/dashboard');
    server.setNonce(transaction.nonce);

    const callbackUrl = new URL(`${server.issuer}/auth/dex/callback`);
    callbackUrl.searchParams.set('code', 'authorization-code');
    callbackUrl.searchParams.set('state', transaction.state);

    await expect(
      service.exchangeCallback(callbackUrl, transaction),
    ).rejects.toThrow('authorized party');
  });

  it('ignores non-local return targets from callback transaction cookies', async () => {
    const server = await startOidcServer();
    cleanup.push(server.close);
    const isolated = await createOidcTestDb();
    cleanup.push(isolated.cleanup);
    const { db } = isolated;

    const service = new OidcLoginService({
      db,
      provider: {
        clientId: 'smrt-client',
        clientSecret: 'secret',
        issuer: server.issuer,
        kind: 'dex',
        redirectUri: `${server.issuer}/auth/dex/callback`,
      },
      providerName: 'dex',
    });
    const transaction = service.createTransaction('https://evil.example/phish');
    server.setNonce(transaction.nonce);

    const callbackUrl = new URL(`${server.issuer}/auth/dex/callback`);
    callbackUrl.searchParams.set('code', 'authorization-code');
    callbackUrl.searchParams.set('state', transaction.state);
    callbackUrl.searchParams.set('iss', server.issuer);

    const { cookies, jar } = createCookieJar({
      smrt_oidc_dex: encodeOidcTransaction(transaction),
    });
    const handler = createOidcCallbackHandler({
      db,
      provider: 'dex',
      providers: {
        dex: {
          clientId: 'smrt-client',
          issuer: server.issuer,
          kind: 'dex',
          redirectUri: `${server.issuer}/auth/dex/callback`,
          tokenEndpointAuthMethod: 'none',
        },
      },
    });

    const response = await handler({
      cookies,
      getClientAddress: () => '127.0.0.1',
      params: { provider: 'dex' },
      request: new Request(callbackUrl),
      url: callbackUrl,
    });

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/');
    expect(jar.has('smrt_oidc_dex')).toBe(false);
  });
});
