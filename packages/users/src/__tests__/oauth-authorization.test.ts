import { createHash, randomUUID } from 'node:crypto';
import {
  createAuthorizationServer,
  type OAuthAuthorizationCodeGrant,
  type OAuthRefreshGrant,
} from '@happyvertical/auth/server';
import { getRetentionTasks } from '@happyvertical/smrt-core';
import {
  createIsolatedTestDbFromManifest,
  getTestDbConfig,
  type IsolatedTestDbResult,
} from '@happyvertical/smrt-vitest';
import type { DatabaseInterface } from '@happyvertical/sql';
import { exportJWK, generateKeyPair } from 'jose';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { MembershipCollection } from '../collections/MembershipCollection.js';
import { PermissionCollection } from '../collections/PermissionCollection.js';
import { RoleCollection } from '../collections/RoleCollection.js';
import { RolePermissionCollection } from '../collections/RolePermissionCollection.js';
import { SessionCollection } from '../collections/SessionCollection.js';
import { TenantCollection } from '../collections/TenantCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import {
  OAUTH_CREDENTIALS_RETENTION_TASK,
  registerUserRetentionTasks,
  unregisterUserRetentionTasks,
} from '../retention.js';
import { SmrtOAuthAuthorizationService } from '../services/OAuthAuthorizationService.js';
import { SmrtOAuthAuthorizationStorage } from '../services/OAuthAuthorizationStorage.js';
import {
  OAUTH_REFRESH_REPLAY_RETENTION_MS,
  pruneOAuthCredentials,
} from '../services/oauth-retention.js';
import { SessionService } from '../services/SessionService.js';
import { createOAuthHandlers } from '../sveltekit/oauth-handlers.js';
import { MembershipStatus, TenantStatus, UserStatus } from '../types/index.js';

const objects = [
  'User',
  'Tenant',
  'Role',
  'Permission',
  'RolePermission',
  'Membership',
  'MembershipOverride',
  'TenantPermissionOverride',
  'Group',
  'GroupMember',
  'GroupRole',
  'Session',
  'UsersOAuthClient',
  'UsersOAuthAuthorizationCode',
  'UsersOAuthAuthorization',
  'UsersOAuthRefreshGrant',
  'UsersOAuthRefreshFamily',
  'UsersOAuthAccessTokenRevocation',
];
const resource = 'https://service.example/mcp';
const redirectUri = 'https://client.example/callback';
const expiresAt = () => new Date(Date.now() + 60_000);
function code(): OAuthAuthorizationCodeGrant {
  return {
    id: randomUUID(),
    codeHash: randomUUID(),
    clientId: 'client',
    subject: 'subject',
    scopes: ['read'],
    redirectUri,
    codeChallenge: 'challenge',
    expiresAt: expiresAt(),
  };
}
function refresh(): OAuthRefreshGrant {
  return {
    id: randomUUID(),
    tokenHash: randomUUID(),
    familyId: randomUUID(),
    clientId: 'client',
    subject: 'subject',
    scopes: ['read'],
    expiresAt: expiresAt(),
  };
}
function replacement() {
  return { id: randomUUID(), tokenHash: randomUUID(), expiresAt: expiresAt() };
}

describe('durable OAuth on the configured SQLite/PostgreSQL executor', () => {
  // Replica tests commit transactions, so a shared rollback fixture cannot
  // isolate their rows from other PostgreSQL files (notably permission catalogs).
  let postgresAdmin: DatabaseInterface | undefined;
  let postgresName: string | undefined;
  beforeAll(async () => {
    const config = getTestDbConfig();
    if (config.type !== 'postgres') return;
    const sql =
      await vi.importActual<typeof import('@happyvertical/sql')>(
        '@happyvertical/sql',
      );
    postgresAdmin = await sql.getDatabase({ ...config, dbid: randomUUID() });
    postgresName = `smrt_oauth_${randomUUID().replaceAll('-', '')}`;
    await postgresAdmin.query(`CREATE DATABASE "${postgresName}"`);
    const url = new URL(config.url);
    url.pathname = `/${postgresName}`;
    vi.stubEnv('DATABASE_URL', url.toString());
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    if (postgresAdmin && postgresName) {
      await postgresAdmin.query(`DROP DATABASE "${postgresName}" WITH (FORCE)`);
      await postgresAdmin.close?.();
    }
  });
  let isolated: IsolatedTestDbResult;
  let storage: SmrtOAuthAuthorizationStorage;
  let replica: SmrtOAuthAuthorizationStorage;
  let connections: DatabaseInterface[];
  let reconnect: () => Promise<DatabaseInterface>;
  beforeEach(async () => {
    isolated = await createIsolatedTestDbFromManifest({
      includeObjects: objects,
    });
    // These tests exercise real committed service transactions, not nested
    // savepoints in an enclosing fixture transaction.
    await isolated.db.rollback();
    connections = [];
    // Open real connections against the fixture's already migrated schema.
    // The test setup's getDatabase wrapper syncs schema and is not a runtime factory.
    const sql =
      await vi.importActual<typeof import('@happyvertical/sql')>(
        '@happyvertical/sql',
      );
    const recoverDatabase = async () => {
      const db = await sql.getDatabase({
        ...isolated.config,
        dbid: randomUUID(),
      });
      connections.push(db);
      if (isolated.config.type === 'sqlite')
        await db.query('PRAGMA foreign_keys = ON');
      return db;
    };
    reconnect = recoverDatabase;
    storage = await SmrtOAuthAuthorizationStorage.create({
      db: isolated.baseDb,
      recoverDatabase,
    });
    replica = await SmrtOAuthAuthorizationStorage.create({
      db: isolated.baseDb,
      recoverDatabase,
    });
  });
  afterEach(async () => {
    for (const db of connections ?? [])
      await (
        db as DatabaseInterface & { close?: () => Promise<void> }
      ).close?.();
    await isolated?.cleanup();
  });

  it('registers OAuth retention and previews expiry without mutating live authority', async () => {
    const now = new Date();
    const old = new Date(
      now.getTime() - OAUTH_REFRESH_REPLAY_RETENTION_MS - 1000,
    );
    const expiredCode = { ...code(), expiresAt: old };
    const liveCode = code();
    await storage.createAuthorizationCode(expiredCode);
    await storage.createAuthorizationCode(liveCode);
    await storage.revokeAccessToken({ jti: 'expired', expiresAt: old });
    await storage.revokeAccessToken({ jti: 'live', expiresAt: expiresAt() });
    const dead = { ...refresh(), expiresAt: old };
    const grace = { ...refresh(), expiresAt: new Date(now.getTime() - 1000) };
    const live = refresh();
    await storage.createRefreshGrant(dead);
    await storage.createRefreshGrant(grace);
    await storage.createRefreshGrant(live);
    const db = isolated.baseDb;
    const before = await db.query(
      'SELECT * FROM users_oauth_refresh_families ORDER BY id',
    );
    registerUserRetentionTasks();
    const task = getRetentionTasks().find(
      (entry) => entry.name === OAUTH_CREDENTIALS_RETENTION_TASK,
    );
    if (!task) throw new Error('OAuth retention task was not registered');
    expect(await task.run(db, { dryRun: true, now })).toBe(4);
    expect(
      (await db.query('SELECT * FROM users_oauth_refresh_families ORDER BY id'))
        .rows,
    ).toEqual(before.rows);
    expect(await task.run(db, { dryRun: false, now })).toBe(4);
    expect(await pruneOAuthCredentials(db, { now })).toBe(0);
    expect(
      (await db.query('SELECT id FROM users_oauth_refresh_grants')).rows,
    ).toHaveLength(2);
    expect(await storage.isAccessTokenRevoked('live', now)).toBe(true);
    expect(
      (await storage.consumeAuthorizationCode({ ...liveCode, now })).status,
    ).toBe('consumed');
    expect(
      (
        await storage.rotateRefreshGrant({
          ...live,
          replacement: replacement(),
          now,
        })
      ).status,
    ).toBe('rotated');
    unregisterUserRetentionTasks();
    expect(
      getRetentionTasks().some(
        (entry) => entry.name === OAUTH_CREDENTIALS_RETENTION_TASK,
      ),
    ).toBe(false);
  });

  it('bounds old family history while preserving valid and grace-window replay detection', async () => {
    const now = new Date();
    const old = {
      ...refresh(),
      expiresAt: new Date(
        now.getTime() - OAUTH_REFRESH_REPLAY_RETENTION_MS - 1000,
      ),
    };
    await storage.createRefreshGrant(old);
    const live = replacement();
    // Model a long-lived family: this rotation happened before the old expiry.
    expect(
      (
        await storage.rotateRefreshGrant({
          ...old,
          replacement: live,
          now: new Date(old.expiresAt.getTime() - 1000),
        })
      ).status,
    ).toBe('rotated');
    expect(await pruneOAuthCredentials(isolated.baseDb, { now })).toBe(1);
    expect(
      (
        await storage.rotateRefreshGrant({
          ...live,
          clientId: old.clientId,
          replacement: replacement(),
          now,
        })
      ).status,
    ).toBe('rotated');
    // The live consumed hash survives cleanup and replay still revokes all descendants.
    await pruneOAuthCredentials(isolated.baseDb, { now });
    expect(
      (
        await replica.rotateRefreshGrant({
          ...live,
          clientId: old.clientId,
          replacement: replacement(),
          now,
        })
      ).status,
    ).toBe('replayed');
    const grace = { ...refresh(), expiresAt: new Date(now.getTime() - 1000) };
    await storage.createRefreshGrant(grace);
    await storage.rotateRefreshGrant({
      ...grace,
      replacement: replacement(),
      now: new Date(grace.expiresAt.getTime() - 1000),
    });
    await pruneOAuthCredentials(isolated.baseDb, { now });
    expect(
      (
        await replica.rotateRefreshGrant({
          ...grace,
          replacement: replacement(),
          now,
        })
      ).status,
    ).toBe('replayed');
  });

  it('serializes cleanup with rotation without orphaning the replacement family', async () => {
    const now = new Date();
    const old = {
      ...refresh(),
      expiresAt: new Date(
        now.getTime() - OAUTH_REFRESH_REPLAY_RETENTION_MS - 1000,
      ),
    };
    await storage.createRefreshGrant(old);
    const live = replacement();
    await storage.rotateRefreshGrant({
      ...old,
      replacement: live,
      now: new Date(old.expiresAt.getTime() - 1000),
    });
    const next = replacement();
    const [swept, rotated] = await Promise.allSettled([
      pruneOAuthCredentials(await reconnect(), { now }),
      replica.rotateRefreshGrant({
        ...live,
        clientId: old.clientId,
        replacement: next,
        now,
      }),
    ]);
    expect(rotated.status).toBe('fulfilled');
    if (rotated.status !== 'fulfilled') throw rotated.reason;
    expect(rotated.value.status).toBe('rotated');
    if (swept.status === 'rejected') {
      // SQLite deliberately invalidates a connection on contended rollback.
      // The sweep reports failure instead of reusing it or deleting unsafely;
      // its host must acquire a fresh connection before retrying.
      expect(isolated.config.type).toBe('sqlite');
      const failures: Array<{
        code?: string;
        connectionInvalidated?: boolean;
        message?: string;
      }> = [];
      for (
        let failure = swept.reason;
        failure && failures.length < 6;
        failure = failure.cause
      ) {
        failures.push({
          code: failure.code,
          connectionInvalidated: failure.connectionInvalidated,
          message: failure.message,
        });
      }
      expect(failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'SQLITE_BUSY',
            connectionInvalidated: true,
          }),
        ]),
      );
      await pruneOAuthCredentials(await reconnect(), { now });
    }
    expect(
      (
        await storage.rotateRefreshGrant({
          ...next,
          clientId: old.clientId,
          replacement: replacement(),
          now,
        })
      ).status,
    ).toBe('rotated');
  });

  it('persists client metadata and allows exactly one concurrent code consume', async () => {
    const clientId = randomUUID();
    await storage.registerClient({
      id: clientId,
      redirectUris: [redirectUri],
      allowedScopes: ['read'],
      tokenEndpointAuthMethod: 'none',
      createdAt: new Date(),
    });
    expect(await replica.getClient(clientId)).toMatchObject({
      redirectUris: [redirectUri],
    });
    const restrictedId = randomUUID();
    await storage.registerClient({
      id: restrictedId,
      redirectUris: [redirectUri],
      allowedScopes: ['read'],
      allowedResources: [],
      tokenEndpointAuthMethod: 'none',
      createdAt: new Date(),
    });
    expect((await replica.getClient(restrictedId))?.allowedResources).toEqual(
      [],
    );
    expect(
      (await replica.getClient(clientId))?.allowedResources,
    ).toBeUndefined();
    const grant = code();
    await storage.createAuthorizationCode(grant);
    const input = { ...grant, now: new Date() };
    expect(
      await storage.consumeAuthorizationCode({ ...input, clientId: 'foreign' }),
    ).toEqual({ status: 'invalid' });
    expect(
      await storage.consumeAuthorizationCode({
        ...input,
        redirectUri: 'https://evil.example',
      }),
    ).toEqual({ status: 'invalid' });
    expect(
      await storage.consumeAuthorizationCode({ ...input, resource }),
    ).toEqual({ status: 'invalid' });
    const results = await Promise.all([
      storage.consumeAuthorizationCode(input),
      replica.consumeAuthorizationCode(input),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      'consumed',
      'replayed',
    ]);
    const expired = { ...code(), expiresAt: new Date(0) };
    await storage.createAuthorizationCode(expired);
    expect(
      await replica.consumeAuthorizationCode({ ...expired, now: new Date() }),
    ).toEqual({ status: 'expired' });
  });

  it('serializes refresh reuse and revokes every descendant, including concurrent replacements', async () => {
    const grant = refresh();
    await storage.createRefreshGrant(grant);
    const input = { ...grant, replacement: replacement(), now: new Date() };
    expect(
      await storage.rotateRefreshGrant({ ...input, tokenHash: 'wrong' }),
    ).toEqual({ status: 'invalid' });
    expect(
      await storage.rotateRefreshGrant({ ...input, clientId: 'foreign' }),
    ).toEqual({ status: 'invalid' });
    const next = replacement();
    const result = await Promise.all([
      storage.rotateRefreshGrant(input),
      replica.rotateRefreshGrant({ ...input, replacement: next }),
    ]);
    expect(result.map((r) => r.status).sort()).toEqual(['replayed', 'rotated']);
    const winner = result[0].status === 'rotated' ? input.replacement : next;
    expect(
      await storage.rotateRefreshGrant({
        ...winner,
        clientId: grant.clientId,
        replacement: replacement(),
        now: new Date(),
      }),
    ).toEqual({ status: 'revoked' });
    await storage.revokeRefreshGrant({ ...grant, now: new Date() });
    await storage.revokeRefreshGrant({ ...grant, now: new Date() });
  });

  it('rolls back consume if replacement insertion fails and never resurrects revoked families', async () => {
    const grant = refresh();
    await storage.createRefreshGrant(grant);
    await expect(
      storage.rotateRefreshGrant({
        ...grant,
        replacement: {
          id: grant.id,
          tokenHash: 'collision',
          expiresAt: expiresAt(),
        },
        now: new Date(),
      }),
    ).rejects.toThrow();
    const next = replacement();
    expect(
      await storage.rotateRefreshGrant({
        ...grant,
        replacement: next,
        now: new Date(),
      }),
    ).toMatchObject({ status: 'rotated' });
    const outcomes = await Promise.all([
      storage.rotateRefreshGrant({
        ...next,
        clientId: grant.clientId,
        replacement: replacement(),
        now: new Date(),
      }),
      replica.revokeRefreshGrant({ ...grant, now: new Date() }),
    ]);
    expect(['rotated', 'revoked']).toContain(
      (outcomes[0] as { status: string }).status,
    );
    const rows = await isolated.baseDb.query(
      'SELECT revoked_at FROM users_oauth_refresh_grants WHERE family_id = ?',
      grant.familyId,
    );
    expect(rows.rows.every((row) => row.revoked_at != null)).toBe(true);
  });

  it('persists refresh scope narrowing and refuses expansion, reuse and revoked replacements', async () => {
    const grant = {
      ...refresh(),
      scopes: ['read', 'write'],
      claims: { permission: 'write', obsolete: true },
    };
    await storage.createRefreshGrant(grant);
    await storage.narrowRefreshGrant({
      ...grant,
      scopes: ['read'],
      claims: { permission: 'read' },
    });
    await expect(
      replica.narrowRefreshGrant({ ...grant, scopes: ['read', 'write'] }),
    ).rejects.toThrow();
    await expect(
      replica.narrowRefreshGrant({ ...grant, tokenHash: 'wrong', scopes: [] }),
    ).rejects.toThrow();
    const next = replacement();
    expect(
      await replica.rotateRefreshGrant({
        ...grant,
        replacement: next,
        now: new Date(),
      }),
    ).toMatchObject({
      status: 'rotated',
      grant: { scopes: ['read'], claims: { permission: 'read' } },
    });
    await expect(
      storage.narrowRefreshGrant({ ...grant, scopes: [] }),
    ).rejects.toThrow();
    await storage.narrowRefreshGrant({
      ...next,
      scopes: ['read'],
      claims: undefined,
    });
    const cleared = await isolated.baseDb.query(
      'SELECT claims FROM users_oauth_refresh_grants WHERE id = ?',
      next.id,
    );
    expect(JSON.parse(String(cleared.rows[0]?.claims))).toEqual({});
    await storage.revokeRefreshGrant({ ...next, now: new Date() });
    await expect(
      replica.narrowRefreshGrant({ ...next, scopes: [], claims: undefined }),
    ).rejects.toThrow();
  });

  it('requires explicit connection recovery and propagates ordinary storage failures', async () => {
    const invalidated = Object.assign(
      new Error('Connection invalidated; recreate configured adapter.'),
      { code: 'SQLITE_BUSY', connectionInvalidated: true },
    );
    const failed = {
      ...isolated.baseDb,
      transaction: async () => {
        throw invalidated;
      },
    } as DatabaseInterface;
    const fixed = await SmrtOAuthAuthorizationStorage.create({ db: failed });
    await expect(fixed.createAuthorizationCode(code())).rejects.toBe(
      invalidated,
    );
    let creations = 0;
    const recovered = await SmrtOAuthAuthorizationStorage.create({
      db: isolated.baseDb,
      recoverDatabase: async () =>
        ++creations === 1 ? failed : isolated.baseDb,
    });
    const grant = code();
    await recovered.createAuthorizationCode(grant);
    expect(creations).toBe(2);
    expect(
      await recovered.consumeAuthorizationCode({ ...grant, now: new Date() }),
    ).toMatchObject({ status: 'consumed' });
    const ordinary = new Error('Storage unavailable');
    const unavailable = await SmrtOAuthAuthorizationStorage.create({
      db: {
        ...isolated.baseDb,
        transaction: async () => {
          throw ordinary;
        },
      } as DatabaseInterface,
    });
    await expect(unavailable.createAuthorizationCode(code())).rejects.toBe(
      ordinary,
    );
  });

  it('makes access revocation durable and repeat-safe', async () => {
    const jti = randomUUID();
    expect(await storage.isAccessTokenRevoked(jti, new Date())).toBe(false);
    await Promise.all([
      storage.revokeAccessToken({ jti, expiresAt: expiresAt() }),
      storage.revokeAccessToken({ jti, expiresAt: expiresAt() }),
    ]);
    expect(await storage.isAccessTokenRevoked(jti, new Date())).toBe(true);
    expect(
      await storage.isAccessTokenRevoked(jti, new Date(Date.now() + 120_000)),
    ).toBe(false);
  });

  async function fixture() {
    const options = { db: isolated.baseDb };
    const users = await UserCollection.create(options);
    const user = await users.create({
      email: `${randomUUID()}@owner.example.com`,
    });
    await user.save();
    const foreign = await users.create({
      email: `${randomUUID()}@foreign.example.com`,
    });
    await foreign.save();
    const tenant = await (await TenantCollection.create(options)).create({
      name: 'Workspace',
    });
    await tenant.save();
    const role = await (await RoleCollection.create(options)).create({
      name: 'Reader',
    });
    await role.save();
    const permissions = await PermissionCollection.create(options);
    const permission =
      (await permissions.findBySlug('catalog.read')) ??
      (await permissions.create({
        slug: 'catalog.read',
        name: 'Read catalog',
      }));
    await permission.save();
    await (await RolePermissionCollection.create(options)).addPermission(
      role.id as string,
      permission.id as string,
    );
    const membership = await (
      await MembershipCollection.create(options)
    ).create({ userId: user.id, tenantId: tenant.id, roleId: role.id });
    await membership.save();
    const sessions = await SessionService.create(options);
    const sessionId = await sessions.createSession(
      user.id as string,
      tenant.id as string,
      { authMethod: 'magic-link' },
    );
    const foreignSession = await sessions.createSession(foreign.id as string);
    const authorization = await SmrtOAuthAuthorizationService.create({
      ...options,
      scopePermissions: { read: ['catalog.read'] },
    });
    const keys = await generateKeyPair('ES256');
    const server = createAuthorizationServer({
      issuer: 'https://service.example/oauth',
      storage,
      identity: authorization.identity,
      signingKey: {
        ...keys,
        publicJwk: await exportJWK(keys.publicKey),
        algorithm: 'ES256',
        keyId: 'test',
      },
      scopes: ['read'],
      resources: [resource],
    });
    const clientId = randomUUID();
    await storage.registerClient({
      id: clientId,
      redirectUris: [redirectUri],
      allowedScopes: ['read'],
      tokenEndpointAuthMethod: 'none',
      createdAt: new Date(),
    });
    const verifier = 'a'.repeat(43);
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'read',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      resource,
    });
    const request = await server.parseAuthorizationRequest(params);
    const issue = async () => {
      const approved = await authorization.approve(server, request, sessionId);
      return server.token(
        new URLSearchParams({
          grant_type: 'authorization_code',
          code: new URL(approved.redirectUri).searchParams.get(
            'code',
          ) as string,
          client_id: clientId,
          redirect_uri: redirectUri,
          code_verifier: verifier,
          resource,
        }),
      );
    };
    return {
      clientId,
      user,
      foreign,
      tenant,
      membership,
      sessions,
      sessionId,
      foreignSession,
      authorization,
      server,
      params,
      request,
      issue,
    };
  }

  it('binds grants to live session/tenant/permissions and confines listing/revoke to the subject', async () => {
    const f = await fixture();
    const tokens = await f.issue();
    const payload = await f.server.verifyAccessToken(
      tokens.access_token,
      resource,
    );
    expect(
      (await f.authorization.validateAccessTokenClaims(payload))?.user.id,
    ).toBe(f.user.id);
    const grants = await f.authorization.listGrants(f.sessionId);
    expect(grants).toHaveLength(1);
    expect(JSON.stringify(grants)).not.toContain(f.sessionId);
    expect(await f.authorization.listGrants(f.foreignSession)).toEqual([]);
    expect(
      await f.authorization.revokeGrant(f.foreignSession, grants[0].id),
    ).toBe(false);
    expect(
      await f.authorization.validateAccessTokenClaims({
        ...payload,
        sub: f.foreign.id,
      }),
    ).toBeNull();
    expect(
      await f.authorization.validateAccessTokenClaims({
        ...payload,
        tenant_id: randomUUID(),
      }),
    ).toBeNull();
    expect(
      await f.authorization.validateAccessTokenClaims({
        ...payload,
        scope: 'write',
      }),
    ).toBeNull();
    expect(await f.authorization.revokeGrant(f.sessionId, grants[0].id)).toBe(
      true,
    );
    expect(await f.authorization.revokeGrant(f.sessionId, grants[0].id)).toBe(
      true,
    );
    expect(await f.authorization.validateAccessTokenClaims(payload)).toBeNull();
    await expect(
      f.server.token(
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: tokens.refresh_token as string,
          client_id: f.clientId,
          resource,
        }),
      ),
    ).rejects.toThrow();
  });

  it('denies live membership loss, user disablement, ceiling changes and destroyed sessions', async () => {
    const f = await fixture();
    const tokens = await f.issue();
    const payload = await f.server.verifyAccessToken(
      tokens.access_token,
      resource,
    );
    f.membership.status = MembershipStatus.INACTIVE;
    await f.membership.save();
    expect(await f.authorization.validateAccessTokenClaims(payload)).toBeNull();
    f.membership.status = MembershipStatus.ACTIVE;
    await f.membership.save();
    f.user.status = UserStatus.SUSPENDED;
    await f.user.save();
    expect(await f.authorization.validateAccessTokenClaims(payload)).toBeNull();
    f.user.status = UserStatus.ACTIVE;
    await f.user.save();
    const sessions = await SessionCollection.create({ db: isolated.baseDb });
    const session = await sessions.get(f.sessionId);
    session?.setData('permissionCeiling', []);
    await session?.save();
    expect(await f.authorization.validateAccessTokenClaims(payload)).toBeNull();
    await f.sessions.destroySession(f.sessionId);
    expect(await f.authorization.validateAccessTokenClaims(payload)).toBeNull();
  });

  it('rechecks consent before exchanging codes and cascades refresh revocation to live access', async () => {
    const f = await fixture();
    const approved = await f.authorization.approve(
      f.server,
      f.request,
      f.sessionId,
    );
    f.membership.status = MembershipStatus.INACTIVE;
    await f.membership.save();
    await expect(
      f.server.token(
        new URLSearchParams({
          grant_type: 'authorization_code',
          code: new URL(approved.redirectUri).searchParams.get(
            'code',
          ) as string,
          client_id: f.clientId,
          redirect_uri: redirectUri,
          code_verifier: 'a'.repeat(43),
          resource,
        }),
      ),
    ).rejects.toThrow();
    f.membership.status = MembershipStatus.ACTIVE;
    await f.membership.save();
    const tokens = await f.issue();
    const payload = await f.server.verifyAccessToken(
      tokens.access_token,
      resource,
    );
    await f.server.revoke(
      new URLSearchParams({ token: tokens.refresh_token as string }),
    );
    expect(await f.authorization.validateAccessTokenClaims(payload)).toBeNull();
  });

  it('preserves consent permission ceilings across mapping changes and denies inactive tenants', async () => {
    const f = await fixture();
    const tokens = await f.issue();
    const payload = await f.server.verifyAccessToken(
      tokens.access_token,
      resource,
    );
    const permissions = await PermissionCollection.create({
      db: isolated.baseDb,
    });
    const elevated = await permissions.create({
      slug: `catalog.write-${randomUUID()}`,
      name: 'Write catalog',
    });
    await (
      await RolePermissionCollection.create({ db: isolated.baseDb })
    ).addPermission(f.membership.roleId, elevated.id as string);
    const changedPolicy = await SmrtOAuthAuthorizationService.create({
      db: isolated.baseDb,
      scopePermissions: { read: [elevated.slug as string] },
    });
    expect(await changedPolicy.validateAccessTokenClaims(payload)).toBeNull();
    f.tenant.status = TenantStatus.INACTIVE;
    await f.tenant.save();
    expect(await f.authorization.validateAccessTokenClaims(payload)).toBeNull();
  });

  it('denies an expired session and a revoked parent without storing bearer credentials in tokens', async () => {
    const f = await fixture();
    const child = await f.sessions.createSession(
      f.user.id as string,
      f.tenant.id as string,
      {
        authMethod: 'pin',
        parentSessionId: f.sessionId,
        data: { permissionCeiling: ['catalog.read'] },
      },
    );
    const approved = await f.authorization.approve(f.server, f.request, child);
    const tokens = await f.server.token(
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: new URL(approved.redirectUri).searchParams.get('code') as string,
        client_id: f.clientId,
        redirect_uri: redirectUri,
        code_verifier: 'a'.repeat(43),
        resource,
      }),
    );
    const payload = await f.server.verifyAccessToken(
      tokens.access_token,
      resource,
    );
    expect(JSON.stringify(payload)).not.toContain(child);
    expect(JSON.stringify(payload)).not.toContain(f.sessionId);
    expect(
      (await f.authorization.validateAccessTokenClaims(payload))?.permissions,
    ).toEqual(['catalog.read']);
    await f.sessions.destroySession(f.sessionId);
    expect(await f.authorization.validateAccessTokenClaims(payload)).toBeNull();
    const expired = await f.sessions.createSession(
      f.user.id as string,
      f.tenant.id as string,
      { ttl: -1 },
    );
    await expect(
      f.authorization.approve(f.server, f.request, expired),
    ).rejects.toThrow();
  });

  it('requires explicit same-origin session consent and isolates account grant routes', async () => {
    const f = await fixture();
    const handlers = createOAuthHandlers({
      server: f.server,
      authorization: f.authorization,
      getSessionId: () => f.sessionId,
    });
    const url = new URL(`https://service.example/oauth/authorize?${f.params}`);
    const event = (origin: string | null, decision = 'approve') => ({
      url,
      request: new Request(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          ...(origin ? { origin } : {}),
        },
        body: new URLSearchParams({ decision }),
      }),
    });
    expect((await handlers.consent(event(null))).status).toBe(403);
    expect((await handlers.consent(event('https://evil.example'))).status).toBe(
      403,
    );
    expect((await handlers.consent(event(url.origin, 'deny'))).status).toBe(
      403,
    );
    expect((await handlers.consent(event(url.origin))).status).toBe(303);
    await f.sessions.destroySession(f.sessionId);
    expect((await handlers.consent(event(url.origin))).status).toBe(403);
  });
});
