/**
 * The app as its own MCP issuer (#5080): `mcp.authorizationServer` wires the
 * smrt-users OAuth server to hosted MCP resource auth. Real local SQLite,
 * real OAuth server and consent service; issue -> call -> revoke -> refuse.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuthorizationServer } from '@happyvertical/auth/server';
import { createHostedMcpResourceAuth } from '@happyvertical/smrt-app-mcp/auth';
import { resolveApplicationRuntime } from '@happyvertical/smrt-config';
import { disableTenancy } from '@happyvertical/smrt-tenancy';
import {
  DEFAULT_ROLE_SLUGS,
  MembershipCollection,
  MembershipStatus,
  PermissionCollection,
  RoleCollection,
  RolePermissionCollection,
  SessionService,
  SmrtOAuthAuthorizationService,
  SmrtOAuthAuthorizationStorage,
  UserCollection,
  UserStatus,
} from '@happyvertical/smrt-users';
import { exportJWK, generateKeyPair } from 'jose';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  createSmrtSvelteKitRuntime,
  type SmrtSvelteKitRuntime,
} from './sveltekit.js';

const RESOURCE = 'https://app.example/mcp';
const ISSUER = 'https://app.example/oauth';
const REDIRECT = 'https://client.example/callback';
const READ = 'notes.read';

const roots: string[] = [];
const runtimes: SmrtSvelteKitRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    try {
      await (await runtime.localRuntime()).db.close?.();
    } catch {
      // Never started.
    }
  }
  await Promise.all(
    roots
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
afterAll(() => disableTenancy());

async function fixture(label: string) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), `smrt-self-issuer-${label}-`)),
  );
  roots.push(root);
  const sourceRoot = join(root, 'source');
  await mkdir(sourceRoot);
  await writeFile(
    join(sourceRoot, 'package.json'),
    JSON.stringify({ name: `@acme/${label}` }),
  );
  const local = createSmrtSvelteKitRuntime({
    sourceRoot,
    dataDirectory: join(root, 'data'),
    runtime: resolveApplicationRuntime({ profile: 'local' }),
    env: { NODE_ENV: 'development' },
  });
  runtimes.push(local);
  await local.init();
  const runtime = await local.localRuntime();
  const db = runtime.db;
  const owner = await runtime.claimOwner({
    token: (await runtime.rotateBootstrapInvitation()).token,
    name: 'Owner',
    email: 'owner@example.test',
  });
  const roles = await RoleCollection.create({ db });
  const ownerRole = await roles.findSystemRoleBySlug(DEFAULT_ROLE_SLUGS.OWNER);
  const permission = await (
    await PermissionCollection.create({ db })
  ).findOrCreate(READ, { name: READ });
  await (await RolePermissionCollection.create({ db })).addPermission(
    ownerRole?.id as string,
    permission.id as string,
  );

  const authorization = await SmrtOAuthAuthorizationService.create({
    db,
    scopePermissions: { [READ]: [READ] },
  });
  const storage = await SmrtOAuthAuthorizationStorage.create({ db });
  const keys = await generateKeyPair('ES256');
  const server = createAuthorizationServer({
    issuer: ISSUER,
    storage,
    identity: authorization.identity,
    signingKey: {
      ...keys,
      publicJwk: await exportJWK(keys.publicKey),
      algorithm: 'ES256',
      keyId: 'self',
    },
    scopes: [READ],
    resources: [RESOURCE],
  });
  const clientId = randomUUID();
  await storage.registerClient({
    id: clientId,
    redirectUris: [REDIRECT],
    allowedScopes: [READ],
    tokenEndpointAuthMethod: 'none',
    createdAt: new Date(),
  });
  const sessions = await SessionService.create({ db });
  const sessionId = await sessions.createSession(owner.userId, owner.tenantId, {
    authMethod: 'magic-link',
  });
  const verifier = 'a'.repeat(43);
  const issue = async (resource = RESOURCE) => {
    const request = await server.parseAuthorizationRequest(
      new URLSearchParams({
        client_id: clientId,
        redirect_uri: REDIRECT,
        response_type: 'code',
        scope: READ,
        code_challenge: createHash('sha256')
          .update(verifier)
          .digest('base64url'),
        code_challenge_method: 'S256',
        resource,
      }),
    );
    const approved = await authorization.approve(server, request, sessionId);
    const tokens = await server.token(
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: new URL(approved.redirectUri).searchParams.get('code') as string,
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
        resource,
      }),
    );
    return tokens.access_token;
  };

  const hostedOptions = (withSelf: boolean) => ({
    appId: `self-${label}`,
    runtime: resolveApplicationRuntime({ profile: 'self-hosted' }),
    // Only a selector; every class below is overridden onto the SQLite db.
    env: { DATABASE_URL: 'postgres://unused.invalid/db' },
    classOverrides: Object.fromEntries(
      ['OidcIdentity', 'User', 'Membership'].map((name) => [name, { db }]),
    ),
    ...(withSelf
      ? {
          mcp: {
            authorizationServer: {
              server,
              authorization,
              resource: RESOURCE,
              scopes: [READ],
            },
          },
        }
      : {}),
  });
  const hosted = createSmrtSvelteKitRuntime(hostedOptions(true));
  const external = createSmrtSvelteKitRuntime(hostedOptions(false));
  const call = (
    auth: ReturnType<ReturnType<typeof createHostedMcpResourceAuth>> & object,
    token: string,
  ) =>
    auth.authenticate(
      new Request(RESOURCE, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      }),
    );
  return {
    db,
    owner,
    authorization,
    server,
    sessionId,
    issue,
    hosted,
    external,
    call,
  };
}

describe('app as its own MCP issuer (#5080)', () => {
  it('accepts its own token, then refuses the next call after the grant is revoked', async () => {
    const f = await fixture('round-trip');
    const auth = createHostedMcpResourceAuth({
      profile: 'self-hosted',
      runtime: f.hosted,
      env: {},
    })();
    if (!auth) throw new Error('adapter missing');
    // Metadata advertises the app's own issuer.
    expect(await auth.metadataResponse().json()).toMatchObject({
      resource: RESOURCE,
      authorization_servers: [ISSUER],
      scopes_supported: [READ],
    });
    const token = await f.issue();
    const ok = await f.call(auth, token);
    expect(ok).toMatchObject({
      ok: true,
      principal: {
        id: f.owner.userId,
        tenantId: f.owner.tenantId,
        scopes: [READ],
        tenantBinding: 'direct',
      },
    });
    const [grant] = await f.authorization.listGrants(f.sessionId);
    expect(await f.authorization.revokeGrant(f.sessionId, grant.id)).toBe(true);
    const refused = await f.call(auth, token);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.response.status).toBe(401);
      expect(refused.response.headers.get('www-authenticate')).toContain(
        'invalid_token',
      );
      expect(await refused.response.text()).toBe('');
    }
  });

  it('refuses tampered and malformed tokens', async () => {
    const f = await fixture('audience');
    const auth = createHostedMcpResourceAuth({
      profile: 'self-hosted',
      runtime: f.hosted,
      env: {},
    })()!;
    const token = await f.issue();
    const [head, body] = token.split('.');
    expect((await f.call(auth, `${head}.${body}.AAAA`)).ok).toBe(false);
    expect((await f.call(auth, 'not-a-jwt')).ok).toBe(false);
  });

  it('keeps liveness when the host overrides the principal mapping', async () => {
    const f = await fixture('override');
    const auth = createHostedMcpResourceAuth({
      profile: 'self-hosted',
      runtime: f.hosted,
      env: {},
      resolvePrincipal: async () => ({
        id: 'host-mapped',
        tenantId: 'host-tenant',
      }),
    })()!;
    const token = await f.issue();
    expect(await f.call(auth, token)).toMatchObject({
      ok: true,
      principal: { id: 'host-mapped', tenantId: 'host-tenant' },
    });
    const [grant] = await f.authorization.listGrants(f.sessionId);
    await f.authorization.revokeGrant(f.sessionId, grant.id);
    expect((await f.call(auth, token)).ok).toBe(false);
  });

  it('refuses an inactive user and a lost membership on the very next call', async () => {
    const f = await fixture('inactive');
    const auth = createHostedMcpResourceAuth({
      profile: 'self-hosted',
      runtime: f.hosted,
      env: {},
    })()!;
    const token = await f.issue();
    expect((await f.call(auth, token)).ok).toBe(true);

    const memberships = await MembershipCollection.create({ db: f.db });
    const [membership] = await memberships.findActiveByUser(f.owner.userId);
    membership.status = MembershipStatus.SUSPENDED;
    await membership.save();
    expect((await f.call(auth, token)).ok).toBe(false);
    membership.status = MembershipStatus.ACTIVE;
    await membership.save();
    expect((await f.call(auth, token)).ok).toBe(true);

    const users = await UserCollection.create({ db: f.db });
    const user = await users.get({ id: f.owner.userId });
    if (!user) throw new Error('user missing');
    user.status = UserStatus.SUSPENDED;
    await user.save();
    expect((await f.call(auth, token)).ok).toBe(false);
  });

  it('maps app-issued sub/tenant_id by default but never trusts claims alone', async () => {
    const f = await fixture('mapping');
    const token = await f.issue();
    const claims = await f.server.verifyAccessToken(token, RESOURCE);
    const identity = (extra: Record<string, unknown> = {}) => ({
      issuer: ISSUER,
      subject: claims.sub as string,
      claims: { ...claims, ...extra },
    });
    await expect(f.hosted.resolveMcpPrincipal(identity())).resolves.toEqual({
      id: f.owner.userId,
      tenantId: f.owner.tenantId,
      kind: 'human',
      tenantBinding: 'direct',
    });
    // Tenant mismatch: a forged tenant_id fails the live grant check.
    await expect(
      f.hosted.resolveMcpPrincipal(identity({ tenant_id: randomUUID() })),
    ).resolves.toBeNull();
    // Subject mismatch.
    await expect(
      f.hosted.resolveMcpPrincipal({
        ...identity(),
        subject: randomUUID(),
      }),
    ).resolves.toBeNull();
    // No claims: fail closed.
    await expect(
      f.hosted.resolveMcpPrincipal({
        issuer: ISSUER,
        subject: claims.sub as string,
      }),
    ).resolves.toBeNull();
  });

  it('leaves the external-issuer path unchanged', async () => {
    const f = await fixture('external');
    expect(f.external.mcpSelfIssuer).toBeUndefined();
    expect(f.hosted.mcpSelfIssuer?.issuer).toBe(ISSUER);
    // Without the option, hosted auth still demands the operator environment.
    const auth = createHostedMcpResourceAuth({
      profile: 'self-hosted',
      runtime: f.external,
      env: {},
    });
    expect(() => auth()).toThrow('Hosted MCP requires SMRT_MCP_RESOURCE.');
    const configured = createHostedMcpResourceAuth({
      profile: 'self-hosted',
      runtime: f.external,
      env: {
        SMRT_MCP_RESOURCE: RESOURCE,
        SMRT_MCP_ISSUER: 'https://idp.example/',
        SMRT_MCP_JWKS_URI: 'https://idp.example/jwks',
        SMRT_MCP_SCOPES: READ,
      },
    })()!;
    expect(await configured.metadataResponse().json()).toMatchObject({
      authorization_servers: ['https://idp.example/'],
    });
    // A foreign issuer through a self-issuer runtime takes the OIDC path (unlinked: deny).
    await expect(
      f.hosted.resolveMcpPrincipal({
        issuer: 'https://idp.example/',
        subject: 'someone',
      }),
    ).resolves.toBeNull();
  });
});
