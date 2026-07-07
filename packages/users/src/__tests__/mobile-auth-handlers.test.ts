/**
 * `/api/mobile` handler tests (issue #1748): full PKCE round-trip against a
 * real test IdP (jose-signed ID tokens, discovery, JWKS), 401/expiry bearer
 * semantics, tenant-option resolution incl. `Role.inheritsToDescendants`
 * (#1867), and the permission-guarded route wrapper.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MembershipCollection } from '../collections/MembershipCollection.js';
import { PermissionCollection } from '../collections/PermissionCollection.js';
import { RoleCollection } from '../collections/RoleCollection.js';
import { RolePermissionCollection } from '../collections/RolePermissionCollection.js';
import { TenantCollection } from '../collections/TenantCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import type { Tenant } from '../models/Tenant.js';
import type { User } from '../models/User.js';
import {
  MobileAuthService,
  validateMobileRedirectUri,
} from '../services/MobileAuthService.js';
import { assertOperationPermission } from '../services/OperationPermissionService.js';
import {
  createMobileAuthHandlers,
  type MobileAuthHandlers,
  type MobileRequestEvent,
  resolveMobileUploadDedupKey,
} from '../sveltekit/index.js';
import { MembershipStatus } from '../types/index.js';
import {
  closeAllOidcServers,
  OIDC_USERS_TEST_SCHEMA,
  type OidcTestServer,
  startOidcServer,
} from './helpers/oidc-test-server.js';

const APP_REDIRECT = 'com.example.app://auth/callback';

interface JsonBody {
  [key: string]: unknown;
}

function postEvent(body: unknown, headers: Record<string, string> = {}) {
  return {
    request: new Request('http://app.local/api/mobile/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    getClientAddress: () => '203.0.113.7',
    locals: {},
  } satisfies MobileRequestEvent;
}

function bearerEvent(token?: string) {
  return {
    request: new Request('http://app.local/api/mobile/session', {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }),
    locals: {},
  } satisfies MobileRequestEvent;
}

async function readJson(response: Response): Promise<JsonBody> {
  return (await response.json()) as JsonBody;
}

interface SeededWorld {
  user: User;
  outsider: User;
  network: Tenant;
  alpha: Tenant;
  beta: Tenant;
  gamma: Tenant;
  adminRoleId: string;
  viewerRoleId: string;
}

/**
 * Seed a user with a tenant hierarchy exercising #1867:
 *
 * - `network` (root) — user holds `net-admin` (inheritsToDescendants: true)
 * - `alpha` (child) — NO direct membership → inherited via network admin
 * - `beta` (child) — direct ACTIVE `viewer` membership → pinned to viewer
 * - `gamma` (child) — direct INACTIVE membership → pinned to the empty set
 *   and therefore excluded from the tenant options entirely
 */
async function seedWorld(db: { type: string; url: string }) {
  const users = await UserCollection.create({ db });
  const tenants = await TenantCollection.create({ db });
  const roles = await RoleCollection.create({ db });
  const memberships = await MembershipCollection.create({ db });

  const user = await users.create({ email: 'rider@example.com' });
  await user.save();
  const outsider = await users.create({ email: 'outsider@example.com' });
  await outsider.save();

  const network = await tenants.create({ name: 'Network', slug: 'network' });
  await network.save();
  const alpha = await tenants.createChild(network.id as string, {
    name: 'Alpha Town',
    slug: 'alpha',
  });
  const beta = await tenants.createChild(network.id as string, {
    name: 'Beta Town',
    slug: 'beta',
  });
  const gamma = await tenants.createChild(network.id as string, {
    name: 'Gamma Town',
    slug: 'gamma',
  });

  const adminRole = await roles.create({
    slug: 'net-admin',
    name: 'Network Admin',
    inheritsToDescendants: true,
  });
  await adminRole.save();
  const viewerRole = await roles.create({ slug: 'viewer', name: 'Viewer' });
  await viewerRole.save();

  for (const seed of [
    {
      userId: user.id,
      tenantId: network.id,
      roleId: adminRole.id,
      status: MembershipStatus.ACTIVE,
    },
    {
      userId: user.id,
      tenantId: beta.id,
      roleId: viewerRole.id,
      status: MembershipStatus.ACTIVE,
    },
    {
      userId: user.id,
      tenantId: gamma.id,
      roleId: viewerRole.id,
      status: MembershipStatus.INACTIVE,
    },
    {
      userId: outsider.id,
      tenantId: beta.id,
      roleId: viewerRole.id,
      status: MembershipStatus.ACTIVE,
    },
  ]) {
    const membership = await memberships.create(seed);
    await membership.save();
  }

  return {
    user,
    outsider,
    network,
    alpha,
    beta,
    gamma,
    adminRoleId: adminRole.id as string,
    viewerRoleId: viewerRole.id as string,
  } satisfies SeededWorld;
}

describe('mobile auth handlers (/api/mobile)', () => {
  let dbPath: string;
  let db: { type: 'sqlite'; url: string };
  let server: OidcTestServer;
  let world: SeededWorld;

  beforeEach(async () => {
    dbPath = join(
      tmpdir(),
      `smrt-mobile-auth-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    db = { type: 'sqlite', url: dbPath };
    server = await startOidcServer();
    world = await seedWorld(db);
  });

  afterEach(async () => {
    await server.close();
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch {
        // best-effort temp cleanup
      }
    }
  });

  afterAll(async () => {
    await closeAllOidcServers();
  });

  function makeHandlers(
    overrides: Record<string, unknown> = {},
  ): MobileAuthHandlers {
    return createMobileAuthHandlers({
      db,
      defaultProvider: 'kanidm',
      providers: {
        kanidm: {
          issuer: server.issuer,
          clientId: 'smrt-client',
          clientSecret: 'secret',
          kind: 'kanidm',
        },
      },
      redirectUris: [APP_REDIRECT, 'http://127.0.0.1/cb/'],
      resolveUser: async ({ claims }) => ({
        id: world.user.id as string,
        email: claims.email ?? world.user.email,
      }),
      ...overrides,
    });
  }

  /** Drive start → (simulated IdP redirect) → complete. */
  async function signIn(handlers: MobileAuthHandlers) {
    const startResponse = await handlers.authStart(
      postEvent({ redirectUri: APP_REDIRECT }),
    );
    expect(startResponse.status).toBe(200);
    const start = await readJson(startResponse);
    server.setNonce(start.nonce as string);

    const completeResponse = await handlers.authComplete(
      postEvent({
        providerId: start.providerId,
        code: 'authorization-code',
        state: start.state,
        codeVerifier: start.codeVerifier,
        redirectUri: APP_REDIRECT,
      }),
    );
    return { start, completeResponse };
  }

  it('start returns a PKCE authorization URL with the handshake material', async () => {
    const handlers = makeHandlers();
    const response = await handlers.authStart(
      postEvent({ redirectUri: APP_REDIRECT, scopes: ['openid', 'groups'] }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = await readJson(response);
    expect(body.providerId).toBe('kanidm');
    expect(body.redirectUri).toBe(APP_REDIRECT);
    expect(typeof body.state).toBe('string');
    expect(typeof body.codeVerifier).toBe('string');
    expect(typeof body.nonce).toBe('string');

    const url = new URL(body.authorizationUrl as string);
    expect(url.origin).toBe(server.issuer);
    expect(url.searchParams.get('client_id')).toBe('smrt-client');
    expect(url.searchParams.get('redirect_uri')).toBe(APP_REDIRECT);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe(body.state);
    expect(url.searchParams.get('nonce')).toBe(body.nonce);
    expect(url.searchParams.get('scope')).toBe('openid groups');
  });

  it('completes the full PKCE round-trip into a working bearer session', async () => {
    const handlers = makeHandlers();
    const { start, completeResponse } = await signIn(handlers);

    expect(completeResponse.status).toBe(200);
    expect(completeResponse.headers.get('cache-control')).toBe(
      'private, no-store',
    );
    const session = await readJson(completeResponse);
    expect(session.tokenType).toBe('Bearer');
    expect(typeof session.accessToken).toBe('string');
    expect(Date.parse(session.expiresAt as string)).toBeGreaterThan(Date.now());
    expect((session.user as JsonBody).id).toBe(world.user.id);

    // PKCE proof: the token exchange carried OUR code verifier and the
    // app-scheme redirect URI.
    const exchange = server.tokenRequests.at(-1);
    expect(exchange?.params.get('code_verifier')).toBe(start.codeVerifier);
    expect(exchange?.params.get('redirect_uri')).toBe(APP_REDIRECT);
    expect(exchange?.params.get('grant_type')).toBe('authorization_code');

    // Default tenant binding: the first DIRECT membership tenant by name
    // (Beta) — never an inherited descendant.
    expect((session.activeTenant as JsonBody).id).toBe(world.beta.id);

    // The bearer works against the session bootstrap.
    const bootstrapResponse = await handlers.session.GET(
      bearerEvent(session.accessToken as string),
    );
    expect(bootstrapResponse.status).toBe(200);
    const bootstrap = await readJson(bootstrapResponse);
    expect((bootstrap.user as JsonBody).id).toBe(world.user.id);
    expect((bootstrap.activeTenant as JsonBody).id).toBe(world.beta.id);
  });

  it('resolves tenant options per #1867: direct, inherited, pinned, and inactive', async () => {
    const handlers = makeHandlers();
    const { completeResponse } = await signIn(handlers);
    const session = await readJson(completeResponse);
    const tenants = session.tenants as Array<Record<string, string>>;

    expect(tenants.map((tenant) => tenant.name)).toEqual([
      'Alpha Town',
      'Beta Town',
      'Network',
    ]);
    const byId = new Map(tenants.map((tenant) => [tenant.id, tenant]));
    // Direct membership labels.
    expect(byId.get(world.network.id as string)?.roleSlug).toBe('net-admin');
    // Direct row PINS beta to viewer even though network admin inherits.
    expect(byId.get(world.beta.id as string)?.roleSlug).toBe('viewer');
    // No direct row on alpha → inherited from the flagged network membership.
    expect(byId.get(world.alpha.id as string)?.roleSlug).toBe('net-admin');
    // Inactive direct row on gamma pins it to the empty set → excluded.
    expect(byId.has(world.gamma.id as string)).toBe(false);
  });

  it('omits inherited descendants when includeInheritedTenants is false', async () => {
    const handlers = makeHandlers({ includeInheritedTenants: false });
    const { completeResponse } = await signIn(handlers);
    const session = await readJson(completeResponse);
    const names = (session.tenants as Array<Record<string, string>>).map(
      (tenant) => tenant.name,
    );
    expect(names).toEqual(['Beta Town', 'Network']);
  });

  it('verifies the ID-token nonce against the state token', async () => {
    const handlers = makeHandlers();
    const first = await handlers.authStart(
      postEvent({ redirectUri: APP_REDIRECT }),
    );
    const handshake = await readJson(first);
    // The IdP issues the ID token with a DIFFERENT handshake's nonce.
    server.setNonce('some-other-handshake-nonce');

    const response = await handlers.authComplete(
      postEvent({
        providerId: 'kanidm',
        code: 'authorization-code',
        state: handshake.state,
        codeVerifier: handshake.codeVerifier,
        redirectUri: APP_REDIRECT,
      }),
    );
    expect(response.status).toBe(401);
    const body = await readJson(response);
    expect(body.code).toBe('exchange_failed');
    expect(body.error).toMatch(/nonce/iu);
  });

  it('rejects a tampered state token', async () => {
    const handlers = makeHandlers();
    const start = await readJson(
      await handlers.authStart(postEvent({ redirectUri: APP_REDIRECT })),
    );
    const state = start.state as string;
    const tampered = `${state.slice(0, -2)}${state.endsWith('AA') ? 'BB' : 'AA'}`;

    const response = await handlers.authComplete(
      postEvent({
        code: 'authorization-code',
        state: tampered,
        codeVerifier: start.codeVerifier,
        redirectUri: APP_REDIRECT,
      }),
    );
    expect(response.status).toBe(401);
    expect((await readJson(response)).code).toBe('invalid_state');
    expect(server.tokenRequests).toHaveLength(0);
  });

  it('rejects an expired handshake', async () => {
    const handlers = makeHandlers({ transactionTtl: 1 });
    const start = await readJson(
      await handlers.authStart(postEvent({ redirectUri: APP_REDIRECT })),
    );
    server.setNonce(start.nonce as string);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const response = await handlers.authComplete(
      postEvent({
        code: 'authorization-code',
        state: start.state,
        codeVerifier: start.codeVerifier,
        redirectUri: APP_REDIRECT,
      }),
    );
    expect(response.status).toBe(401);
    expect((await readJson(response)).code).toBe('expired_transaction');
  });

  it('rejects a state token started for a different provider', async () => {
    const handlers = makeHandlers({
      providers: {
        kanidm: {
          issuer: server.issuer,
          clientId: 'smrt-client',
          clientSecret: 'secret',
        },
        backup: {
          issuer: server.issuer,
          clientId: 'smrt-client',
          clientSecret: 'secret',
        },
      },
    });
    const start = await readJson(
      await handlers.authStart(
        postEvent({ providerId: 'kanidm', redirectUri: APP_REDIRECT }),
      ),
    );

    const response = await handlers.authComplete(
      postEvent({
        providerId: 'backup',
        code: 'authorization-code',
        state: start.state,
        codeVerifier: start.codeVerifier,
        redirectUri: APP_REDIRECT,
      }),
    );
    expect(response.status).toBe(401);
    expect((await readJson(response)).code).toBe('invalid_state');
  });

  it('requires the PKCE code verifier on complete', async () => {
    const handlers = makeHandlers();
    const start = await readJson(
      await handlers.authStart(postEvent({ redirectUri: APP_REDIRECT })),
    );
    const response = await handlers.authComplete(
      postEvent({
        code: 'authorization-code',
        state: start.state,
        redirectUri: APP_REDIRECT,
      }),
    );
    expect(response.status).toBe(400);
    expect((await readJson(response)).code).toBe('missing_code_verifier');
  });

  it('validates redirect URIs (schemes and allow list)', async () => {
    const handlers = makeHandlers();
    for (const redirectUri of [
      'javascript:alert(1)',
      'http://evil.example.com/cb',
      'https://not-on-the-list.example.com/cb',
      'not-a-url',
      '',
    ]) {
      const response = await handlers.authStart(postEvent({ redirectUri }));
      expect(response.status).toBe(400);
      expect((await readJson(response)).code).toBe('invalid_redirect_uri');
    }

    // Loopback http on the allow list (prefix entry) is fine per RFC 8252.
    const ok = await handlers.authStart(
      postEvent({ redirectUri: 'http://127.0.0.1/cb/native' }),
    );
    expect(ok.status).toBe(200);
  });

  it('rejects path traversal past a prefix allow-list entry (regression)', async () => {
    const handlers = makeHandlers();
    // The allow list has the prefix entry 'http://127.0.0.1/cb/'. A raw
    // string startsWith would accept '/cb/../evil/', but it normalizes to
    // '/evil/' — outside the registered callback subtree — so the code must
    // never be sent there.
    for (const redirectUri of [
      'http://127.0.0.1/cb/../evil/',
      'http://127.0.0.1/cb/../../evil',
      'http://127.0.0.1/cbsomethingelse',
    ]) {
      const response = await handlers.authStart(postEvent({ redirectUri }));
      expect(response.status).toBe(400);
      expect((await readJson(response)).code).toBe('invalid_redirect_uri');
    }

    // A genuine sub-path of the prefix still resolves within it and is allowed.
    const ok = await handlers.authStart(
      postEvent({ redirectUri: 'http://127.0.0.1/cb/sub/native' }),
    );
    expect(ok.status).toBe(200);
  });

  it('validateMobileRedirectUri allows app schemes and loopback without an allow list', () => {
    expect(validateMobileRedirectUri(APP_REDIRECT)).toBe(APP_REDIRECT);
    expect(validateMobileRedirectUri('http://localhost:8080/cb')).toBe(
      'http://localhost:8080/cb',
    );
    expect(validateMobileRedirectUri('https://app.example.com/cb')).toBe(
      'https://app.example.com/cb',
    );
    expect(() => validateMobileRedirectUri('data:text/html,x')).toThrow(
      /unsupported scheme/iu,
    );
  });

  it('caps the client-supplied correlation state', async () => {
    const handlers = makeHandlers();
    const response = await handlers.authStart(
      postEvent({ redirectUri: APP_REDIRECT, state: 'x'.repeat(600) }),
    );
    expect(response.status).toBe(400);
    expect((await readJson(response)).code).toBe('invalid_request');
  });

  it('rejects malformed JSON bodies', async () => {
    const handlers = makeHandlers();
    const response = await handlers.authStart(postEvent('{not json'));
    expect(response.status).toBe(400);
    expect((await readJson(response)).code).toBe('invalid_request');
  });

  it('refuses sign-in when resolveUser returns null', async () => {
    const handlers = makeHandlers({ resolveUser: async () => null });
    const { completeResponse } = await signIn(handlers);
    expect(completeResponse.status).toBe(403);
    expect((await readJson(completeResponse)).code).toBe(
      'signin_not_permitted',
    );
  });

  it('honors the resolveTenantId hook for the session binding', async () => {
    const handlers = makeHandlers({
      resolveTenantId: async () => world.network.id as string,
    });
    const { completeResponse } = await signIn(handlers);
    const session = await readJson(completeResponse);
    expect((session.activeTenant as JsonBody).id).toBe(world.network.id);
  });

  it('session bootstrap 401s per the mobile client contract', async () => {
    const handlers = makeHandlers();

    const missing = await handlers.session.GET(bearerEvent());
    expect(missing.status).toBe(401);
    expect((await readJson(missing)).code).toBe('missing_bearer_token');

    const junk = await handlers.session.GET(bearerEvent('not-a-session'));
    expect(junk.status).toBe(401);
    expect(junk.headers.get('cache-control')).toBe('private, no-store');
    expect((await readJson(junk)).code).toBe('invalid_bearer_token');
  });

  it('expired sessions 401 (client clears its session and re-authenticates)', async () => {
    const handlers = makeHandlers();
    const service = await handlers.getService();
    const token = await service
      .getSessionService()
      .createSession(world.user.id as string, world.beta.id as string, {
        ttl: -10,
      });

    const response = await handlers.session.GET(bearerEvent(token));
    expect(response.status).toBe(401);
    expect((await readJson(response)).code).toBe('invalid_bearer_token');
  });

  it('DELETE /session revokes the bearer and is idempotent', async () => {
    const handlers = makeHandlers();
    const { completeResponse } = await signIn(handlers);
    const session = await readJson(completeResponse);
    const token = session.accessToken as string;

    const first = await handlers.session.DELETE(bearerEvent(token));
    expect(first.status).toBe(200);
    expect(await readJson(first)).toMatchObject({ ok: true, destroyed: true });

    const after = await handlers.session.GET(bearerEvent(token));
    expect(after.status).toBe(401);

    // Revocation is idempotent at the HTTP level; `destroyed` reflects
    // whether a session ROW was found (an already-revoked row still is).
    const second = await handlers.session.DELETE(bearerEvent(token));
    expect(second.status).toBe(200);
    expect((await readJson(second)).ok).toBe(true);

    const headerless = await handlers.session.DELETE(bearerEvent());
    expect(headerless.status).toBe(200);
    expect(await readJson(headerless)).toMatchObject({
      ok: true,
      destroyed: false,
    });
  });

  it('exposes extras + resolved permissions to the bootstrap hook', async () => {
    let hookPermissions: string[] | undefined;
    const handlers = makeHandlers({
      buildExtras: async ({ permissions, activeTenant }) => {
        hookPermissions = permissions;
        return { theme: 'dark', town: activeTenant?.id ?? null };
      },
    });
    const { completeResponse } = await signIn(handlers);
    const session = await readJson(completeResponse);

    const bootstrapResponse = await handlers.session.GET(
      bearerEvent(session.accessToken as string),
    );
    const bootstrap = await readJson(bootstrapResponse);
    expect(bootstrap.extras).toMatchObject({
      theme: 'dark',
      town: world.beta.id,
    });
    expect(Array.isArray(hookPermissions)).toBe(true);
  });

  it('guard enforces bearer auth and maps permission denials to 403 + reason', async () => {
    const handlers = makeHandlers();
    const service = await handlers.getService();

    // Grant users.read to the viewer role only.
    const permissions = await PermissionCollection.create({ db });
    const rolePermissions = await RolePermissionCollection.create({ db });
    const permission = await permissions.create({
      slug: 'users.read',
      name: 'Read users',
    });
    await permission.save();
    const grant = await rolePermissions.create({
      roleId: world.viewerRoleId,
      permissionId: permission.id,
    });
    await grant.save();

    const guarded = handlers.guard(async (event, context) => {
      await assertOperationPermission({
        db,
        collection: 'users',
        action: 'read',
      });
      // The guard populates locals like the cookie session handler does.
      expect((event.locals?.user as JsonBody)?.id).toBe(context.userId);
      return new Response(
        JSON.stringify({ ok: true, tenantId: context.tenantId }),
        { headers: { 'content-type': 'application/json' } },
      );
    });

    // No bearer → 401 without invoking the route body.
    const anonymous = await guarded(bearerEvent());
    expect(anonymous.status).toBe(401);

    // Viewer in beta HOLDS users.read → 200.
    const viewerToken = await service
      .getSessionService()
      .createSession(world.user.id as string, world.beta.id as string);
    const allowed = await guarded(bearerEvent(viewerToken));
    expect(allowed.status).toBe(200);
    expect(await readJson(allowed)).toMatchObject({
      ok: true,
      tenantId: world.beta.id,
    });

    // The outsider's viewer session in beta also holds users.read, but a
    // session bound to a tenant with NO grant for its role is denied: bind
    // the user to network (net-admin has no users.read grant).
    const adminToken = await service
      .getSessionService()
      .createSession(world.user.id as string, world.network.id as string);
    const denied = await guarded(bearerEvent(adminToken));
    expect(denied.status).toBe(403);
    const deniedBody = await readJson(denied);
    expect(deniedBody.code).toBe('permission_denied');
    expect(deniedBody.reason).toBe('permission_denied');
    expect(deniedBody.permission).toBe('users.read');
  });

  it('MobileAuthService.resolveSessionContext resolves permissions for the bearer', async () => {
    const service = await MobileAuthService.create({
      db,
      providers: {},
    });
    const token = await service
      .getSessionService()
      .createSession(world.user.id as string, world.beta.id as string);

    const context = await service.resolveSessionContext(`Bearer ${token}`);
    expect(context.user.id).toBe(world.user.id);
    expect(context.tenantId).toBe(world.beta.id);
    expect(Array.isArray(context.permissions)).toBe(true);
  });

  it('accepts a case-insensitive bearer scheme', async () => {
    const handlers = makeHandlers();
    const { completeResponse } = await signIn(handlers);
    const token = (await readJson(completeResponse)).accessToken as string;

    const lower = {
      request: new Request('http://app.local/api/mobile/session', {
        headers: { authorization: `bearer ${token}` },
      }),
      locals: {},
    } satisfies MobileRequestEvent;
    const response = await handlers.session.GET(lower);
    expect(response.status).toBe(200);
    expect((await readJson(response)).user).toBeTruthy();
  });

  it('drops non-string scopes rather than failing', async () => {
    const handlers = makeHandlers();
    const response = await handlers.authStart(
      postEvent({
        redirectUri: APP_REDIRECT,
        scopes: [123, 'openid', null, { x: 1 }, 'groups'],
      }),
    );
    expect(response.status).toBe(200);
    const url = new URL((await readJson(response)).authorizationUrl as string);
    expect(url.searchParams.get('scope')).toBe('openid groups');
  });

  it('omits extras when the buildExtras hook returns null', async () => {
    const handlers = makeHandlers({ buildExtras: async () => null });
    const { completeResponse } = await signIn(handlers);
    const token = (await readJson(completeResponse)).accessToken as string;
    const bootstrap = await readJson(
      await handlers.session.GET(bearerEvent(token)),
    );
    expect('extras' in bootstrap).toBe(false);
  });

  it('502s when the provider is unavailable at start', async () => {
    const handlers = makeHandlers({
      // Discovery fails → createAuthorizationUrl throws → provider_unavailable.
      fetch: async () =>
        new Response('unavailable', {
          status: 503,
          headers: { 'content-type': 'text/plain' },
        }),
    });
    const response = await handlers.authStart(
      postEvent({ redirectUri: APP_REDIRECT }),
    );
    expect(response.status).toBe(502);
    expect((await readJson(response)).code).toBe('provider_unavailable');
  });

  it('maps a token-endpoint error to exchange_failed (401)', async () => {
    const realFetch = globalThis.fetch;
    const handlers = makeHandlers({
      // Everything reaches the live test IdP except the token exchange, which
      // fails as if the code were already used / invalid_grant.
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith('/token')) {
          return new Response(
            JSON.stringify({
              error: 'invalid_grant',
              error_description: 'code already used',
            }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          );
        }
        return realFetch(input, init);
      }) as typeof fetch,
    });

    const start = await readJson(
      await handlers.authStart(postEvent({ redirectUri: APP_REDIRECT })),
    );
    const response = await handlers.authComplete(
      postEvent({
        code: 'authorization-code',
        state: start.state,
        codeVerifier: start.codeVerifier,
        redirectUri: APP_REDIRECT,
      }),
    );
    expect(response.status).toBe(401);
    expect((await readJson(response)).code).toBe('exchange_failed');
  });

  it('defaults guarded successes to no-store but keeps an app Cache-Control', async () => {
    const handlers = makeHandlers();
    const token = await (await handlers.getService())
      .getSessionService()
      .createSession(world.user.id as string, world.beta.id as string);

    const bare = handlers.guard(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    const bareResponse = await bare(bearerEvent(token));
    expect(bareResponse.status).toBe(200);
    expect(bareResponse.headers.get('cache-control')).toBe('private, no-store');

    const cached = handlers.guard(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          headers: {
            'content-type': 'application/json',
            'cache-control': 'public, max-age=60',
          },
        }),
    );
    const cachedResponse = await cached(bearerEvent(token));
    expect(cachedResponse.headers.get('cache-control')).toBe(
      'public, max-age=60',
    );
  });
});

describe('mobile auth state-token signing modes', () => {
  let dbPath: string;
  let db: { type: 'sqlite'; url: string };
  let server: OidcTestServer;
  let userId: string;

  beforeEach(async () => {
    dbPath = join(
      tmpdir(),
      `smrt-mobile-signing-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    db = { type: 'sqlite', url: dbPath };
    server = await startOidcServer();
    const users = await UserCollection.create({ db });
    const user = await users.create({ email: 'signer@example.com' });
    await user.save();
    userId = user.id as string;
  });

  afterEach(async () => {
    await server.close();
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch {
        // best-effort temp cleanup
      }
    }
  });

  afterAll(async () => {
    await closeAllOidcServers();
  });

  /** A public OIDC client: no clientSecret configured. */
  function publicClientHandlers(
    overrides: Record<string, unknown> = {},
  ): MobileAuthHandlers {
    return createMobileAuthHandlers({
      db,
      defaultProvider: 'kanidm',
      providers: {
        kanidm: { issuer: server.issuer, clientId: 'smrt-client' },
      },
      redirectUris: [APP_REDIRECT],
      resolveUser: async () => ({ id: userId }),
      ...overrides,
    });
  }

  it('fails closed (500 server_misconfigured) when no signing secret is available', async () => {
    const handlers = publicClientHandlers();
    const response = await handlers.authStart(
      postEvent({ redirectUri: APP_REDIRECT }),
    );
    expect(response.status).toBe(500);
    expect((await readJson(response)).code).toBe('server_misconfigured');
  });

  it('signs with an explicit stateSecret even for a secret-less provider', async () => {
    const handlers = publicClientHandlers({ stateSecret: 'server-hmac-key' });
    const start = await readJson(
      await handlers.authStart(postEvent({ redirectUri: APP_REDIRECT })),
    );
    // A signed state carries an HMAC segment after a '.'.
    expect((start.state as string).includes('.')).toBe(true);
    server.setNonce(start.nonce as string);
    const completeResponse = await handlers.authComplete(
      postEvent({
        code: 'authorization-code',
        state: start.state,
        codeVerifier: start.codeVerifier,
        redirectUri: APP_REDIRECT,
      }),
    );
    expect(completeResponse.status).toBe(200);
  });

  it('round-trips unsigned tokens only when allowUnsignedState is opted in', async () => {
    const handlers = publicClientHandlers({ allowUnsignedState: true });
    const start = await readJson(
      await handlers.authStart(postEvent({ redirectUri: APP_REDIRECT })),
    );
    // Unsigned state is bare base64url — no HMAC segment.
    expect((start.state as string).includes('.')).toBe(false);
    server.setNonce(start.nonce as string);
    const completeResponse = await handlers.authComplete(
      postEvent({
        code: 'authorization-code',
        state: start.state,
        codeVerifier: start.codeVerifier,
        redirectUri: APP_REDIRECT,
      }),
    );
    expect(completeResponse.status).toBe(200);
    expect((await readJson(completeResponse)).tokenType).toBe('Bearer');
  });
});

describe('mobile auth default user provisioning', () => {
  let dbPath: string;
  let db: { type: 'sqlite'; url: string };
  let server: OidcTestServer;

  beforeEach(async () => {
    dbPath = join(
      tmpdir(),
      `smrt-mobile-provision-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    db = { type: 'sqlite', url: dbPath };
    // getOrCreateFromOidc touches the smrt-profiles tables, which the users
    // test manifest does not prepare — apply their DDL explicitly.
    const { getDatabase, syncSchema } = await import('@happyvertical/sql');
    const handle = await getDatabase(db);
    await syncSchema({ db: handle, schema: OIDC_USERS_TEST_SCHEMA });
    server = await startOidcServer();
  });

  afterEach(async () => {
    await server.close();
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch {
        // best-effort temp cleanup
      }
    }
  });

  afterAll(async () => {
    await closeAllOidcServers();
  });

  it('provisions the SMRT user via getOrCreateFromOidc when no resolveUser hook is set', async () => {
    const handlers = createMobileAuthHandlers({
      db,
      defaultProvider: 'dex',
      providers: {
        dex: {
          issuer: server.issuer,
          clientId: 'smrt-client',
          clientSecret: 'secret',
          kind: 'dex',
        },
      },
      redirectUris: [APP_REDIRECT],
    });

    const start = await readJson(
      await handlers.authStart(postEvent({ redirectUri: APP_REDIRECT })),
    );
    server.setNonce(start.nonce as string);

    const completeResponse = await handlers.authComplete(
      postEvent({
        code: 'authorization-code',
        state: start.state,
        codeVerifier: start.codeVerifier,
        redirectUri: APP_REDIRECT,
      }),
    );
    expect(completeResponse.status).toBe(200);
    const session = await readJson(completeResponse);
    expect((session.user as JsonBody).email).toBe('dex.user@example.com');
    // Tenant policy is the app's concern — no membership rows were seeded,
    // so the session binds no tenant and the picker list is empty.
    expect(session.activeTenant).toBeNull();
    expect(session.tenants).toEqual([]);

    const users = await UserCollection.create({ db });
    const provisioned = await users.findByEmail('dex.user@example.com');
    expect(provisioned?.id).toBe((session.user as JsonBody).id);

    const bootstrap = await handlers.session.GET(
      bearerEvent(session.accessToken as string),
    );
    expect(bootstrap.status).toBe(200);
  });
});

describe('resolveMobileUploadDedupKey', () => {
  it('prefers the clientCaptureId field over the Idempotency-Key header', () => {
    const formData = new FormData();
    formData.set('clientCaptureId', ' capture-1 ');
    const headers = new Headers({ 'idempotency-key': 'entry-9' });
    expect(resolveMobileUploadDedupKey(formData, headers)).toBe('capture-1');
  });

  it('falls back to the Idempotency-Key header', () => {
    const formData = new FormData();
    const headers = new Headers({ 'Idempotency-Key': ' entry-9 ' });
    expect(resolveMobileUploadDedupKey(formData, headers)).toBe('entry-9');
    expect(resolveMobileUploadDedupKey(null, headers)).toBe('entry-9');
  });

  it('returns null when neither source is present', () => {
    expect(resolveMobileUploadDedupKey(new FormData(), new Headers())).toBe(
      null,
    );
    const blankField = new FormData();
    blankField.set('clientCaptureId', '   ');
    expect(resolveMobileUploadDedupKey(blankField, new Headers())).toBe(null);
  });
});
