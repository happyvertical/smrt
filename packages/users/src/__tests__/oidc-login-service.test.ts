import { createServer, type IncomingMessage, type Server } from 'node:http';
import { clearCache, setConfig } from '@happyvertical/smrt-config';
import {
  createIsolatedTestDb,
  type IsolatedTestDbResult,
} from '@happyvertical/smrt-vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
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

interface OidcTestServerOptions {
  audience?: string | string[];
  authorizedParty?: string;
  includeEmailInIdToken?: boolean;
}

const OIDC_TEST_SCHEMA = `
CREATE TABLE IF NOT EXISTS "profile_types" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "slug" TEXT NOT NULL,
  "context" TEXT NOT NULL DEFAULT '',
  "_meta_type" TEXT NOT NULL,
  "_meta_data" JSON,
  "created_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "updated_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "tenant_id" TEXT,
  "name" TEXT DEFAULT '',
  "description" TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS "profile_types_slug_context_meta_type_idx" ON "profile_types" ("slug", "context", "_meta_type");
CREATE INDEX IF NOT EXISTS "profile_types_meta_type_idx" ON "profile_types" ("_meta_type");

CREATE TABLE IF NOT EXISTS "profiles" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "slug" TEXT NOT NULL,
  "context" TEXT NOT NULL DEFAULT '',
  "_meta_type" TEXT NOT NULL,
  "_meta_data" JSON,
  "created_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "updated_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "tenant_id" TEXT,
  "type_id" TEXT,
  "email" TEXT,
  "name" TEXT DEFAULT '',
  "description" TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS "profiles_slug_context_meta_type_idx" ON "profiles" ("slug", "context", "_meta_type");
CREATE INDEX IF NOT EXISTS "profiles_meta_type_idx" ON "profiles" ("_meta_type");

CREATE TABLE IF NOT EXISTS "oidc_identities" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "slug" TEXT NOT NULL,
  "context" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "updated_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "profile_id" TEXT,
  "provider" TEXT DEFAULT '',
  "issuer" TEXT DEFAULT '',
  "subject" TEXT DEFAULT '',
  "email" TEXT DEFAULT '',
  "last_used_at" TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "oidc_identities_slug_context_idx" ON "oidc_identities" ("slug", "context");

CREATE TABLE IF NOT EXISTS "users" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "slug" TEXT NOT NULL,
  "context" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "updated_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "profile_id" TEXT DEFAULT '',
  "email" TEXT DEFAULT '',
  "status" TEXT,
  "last_login_at" TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "users_slug_context_idx" ON "users" ("slug", "context");

CREATE TABLE IF NOT EXISTS "sessions" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "slug" TEXT NOT NULL,
  "context" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "updated_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "user_id" TEXT DEFAULT '',
  "tenant_id" TEXT,
  "status" TEXT,
  "expires_at" TIMESTAMP,
  "user_agent" TEXT DEFAULT '',
  "ip_address" TEXT DEFAULT '',
  "last_accessed_at" TIMESTAMP,
  "data" JSON DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS "sessions_slug_context_idx" ON "sessions" ("slug", "context");
`;

const activeServers = new Set<Server>();

async function closeServer(server: Server): Promise<void> {
  if (!activeServers.has(server)) return;

  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  activeServers.delete(server);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(
  response: import('node:http').ServerResponse,
  status: number,
  body: unknown,
) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function startOidcServer(options: OidcTestServerOptions = {}) {
  const { privateKey, publicKey } = await generateKeyPair('RS256', {
    extractable: true,
  });
  const jwk = await exportJWK(publicKey);
  jwk.alg = 'RS256';
  jwk.kid = 'test-key';
  jwk.use = 'sig';

  let issuer = '';
  let nonce = '';
  const tokenRequests: Array<{
    authorization?: string;
    params: URLSearchParams;
  }> = [];
  const userinfoRequests: Array<{
    authorization?: string;
  }> = [];

  const server: Server = createServer(async (request, response) => {
    if (!request.url) {
      sendJson(response, 404, { error: 'not_found' });
      return;
    }

    const url = new URL(request.url, issuer);

    if (url.pathname === '/.well-known/openid-configuration') {
      sendJson(response, 200, {
        authorization_endpoint: `${issuer}/authorize`,
        issuer,
        jwks_uri: `${issuer}/jwks`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
      });
      return;
    }

    if (url.pathname === '/jwks') {
      sendJson(response, 200, { keys: [jwk] });
      return;
    }

    if (url.pathname === '/token') {
      const body = await readBody(request);
      const params = new URLSearchParams(body);
      tokenRequests.push({
        authorization: request.headers.authorization,
        params,
      });

      const idTokenClaims: Record<string, unknown> = {
        nonce,
      };
      if (options.includeEmailInIdToken !== false) {
        idTokenClaims.email = 'dex.user@example.com';
        idTokenClaims.email_verified = true;
        idTokenClaims.name = 'Dex User';
        idTokenClaims.preferred_username = 'dex-user';
      }
      if (options.authorizedParty) {
        idTokenClaims.azp = options.authorizedParty;
      }

      const idToken = await new SignJWT(idTokenClaims)
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setAudience(options.audience ?? 'smrt-client')
        .setExpirationTime('5m')
        .setIssuedAt()
        .setIssuer(issuer)
        .setSubject('dex-user-123')
        .sign(privateKey);

      sendJson(response, 200, {
        access_token: 'access-token',
        expires_in: 3600,
        id_token: idToken,
        token_type: 'Bearer',
      });
      return;
    }

    if (url.pathname === '/userinfo') {
      userinfoRequests.push({
        authorization: request.headers.authorization,
      });
      sendJson(response, 200, {
        email: 'dex.user@example.com',
        email_verified: true,
        name: 'Dex User',
        preferred_username: 'dex-user',
        sub: 'dex-user-123',
      });
      return;
    }

    sendJson(response, 404, { error: 'not_found' });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to start OIDC test server');
  }

  activeServers.add(server);
  issuer = `http://127.0.0.1:${address.port}`;

  return {
    close: () => closeServer(server),
    issuer,
    setNonce: (value: string) => {
      nonce = value;
    },
    tokenRequests,
    userinfoRequests,
  };
}

async function createOidcTestDb(): Promise<IsolatedTestDbResult> {
  return createIsolatedTestDb({ schema: OIDC_TEST_SCHEMA });
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
    await Promise.all([...activeServers].map((server) => closeServer(server)));
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
    const clientSecret = 's:e+c ret';
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

    expect(server.tokenRequests[0]?.authorization).toBe(
      `Basic ${btoa(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`)}`,
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
