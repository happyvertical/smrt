/**
 * PasswordCredentialService (#3274): hashing, sign-in, non-enumeration,
 * limiter integration, the password lifecycle and its authority rules, and
 * the closed surfaces of the credential object.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHANGE_FEED_TABLE,
  ensureChangeFeedTable,
  isChangeFeedSensitiveTable,
  ObjectRegistry,
  registerChangeFeedWriter,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MembershipCollection } from '../collections/MembershipCollection.js';
import { UsersPasswordCredentialCollection } from '../collections/PasswordCredentialCollection.js';
import { RoleCollection } from '../collections/RoleCollection.js';
import { SessionCollection } from '../collections/SessionCollection.js';
import { TenantCollection } from '../collections/TenantCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import { UsersPasswordCredential } from '../models/PasswordCredential.js';
import {
  parseScryptHash,
  scryptCost,
  scryptPaddingParams,
} from '../services/credential-hash.js';
import {
  type LoginAuditEntry,
  LoginRateLimitError,
} from '../services/LoginAttemptLimiter.js';
import {
  DEFAULT_PASSWORD_MANAGE_PERMISSION,
  PASSWORD_LOGIN_KIND,
  PasswordCredentialError,
  PasswordCredentialForbiddenError,
  PasswordCredentialService,
  type PasswordCredentialServiceOptions,
  PasswordPolicyError,
} from '../services/PasswordCredentialService.js';
import { PermissionCatalogService } from '../services/PermissionCatalogService.js';
import {
  type SessionContext,
  SessionService,
} from '../services/SessionService.js';
import { MembershipStatus, UserStatus } from '../types/index.js';

/** Every encoded hash a verification ran against, and every padded one. */
const verified = vi.hoisted(() => ({
  encodings: [] as string[],
  padded: [] as string[],
}));

vi.mock('../services/credential-hash.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../services/credential-hash.js')>();
  return {
    ...actual,
    verifySecretHash: async (
      secret: string,
      pepper: string,
      encoded: string,
    ) => {
      verified.encodings.push(encoded);
      return actual.verifySecretHash(secret, pepper, encoded);
    },
    padScryptWork: async (
      encoded: string,
      policy: import('../services/credential-hash.js').ScryptParams,
    ) => {
      verified.padded.push(encoded);
      return actual.padScryptWork(encoded, policy);
    },
  };
});

const SCRYPT = { N: 2 ** 10, r: 8, p: 1 };
const PASSWORD = 'correct horse battery';

describe('PasswordCredentialService', () => {
  let dbPath: string;
  let options: { db: { type: 'sqlite'; url: string } };
  let users: UserCollection;
  let sessions: SessionCollection;
  let memberships: MembershipCollection;
  let credentials: UsersPasswordCredentialCollection;
  let sessionService: SessionService;
  let service: PasswordCredentialService;
  let audit: LoginAuditEntry[];
  let tenantId: string;
  let otherTenantId: string;
  let roleId: string;
  let personId: string;
  let adminId: string;
  let noPasswordId: string;

  const make = (extra: Partial<PasswordCredentialServiceOptions> = {}) =>
    PasswordCredentialService.create({
      ...options,
      password: { scrypt: SCRYPT },
      limiter: {
        maxAttempts: 3,
        windowSeconds: 60,
        audit: { record: async (entry) => void audit.push(entry) },
      },
      ...extra,
    });

  const actorFor = (
    userId: string,
    extra: Partial<SessionContext> = {},
  ): SessionContext => ({
    user: { id: userId } as never,
    membership: null,
    permissions: [],
    tenantId,
    sessionId: `browser-${userId}`,
    authMethod: 'oidc',
    parent: null,
    ...extra,
  });

  const adminActor = (extra: Partial<SessionContext> = {}) =>
    actorFor(adminId, {
      permissions: [DEFAULT_PASSWORD_MANAGE_PERMISSION],
      ...extra,
    });

  const signIn = (
    identifier: string,
    password: string,
    extra: { ipAddress?: string; tenantId?: string | null } = {},
  ) =>
    service.signIn({
      identifier,
      password,
      tenantId: 'tenantId' in extra ? extra.tenantId : tenantId,
      ipAddress: extra.ipAddress ?? '198.51.100.1',
    });

  const addMember = async (userId: string, tenant: string) => {
    const membership = await memberships.create({
      userId,
      tenantId: tenant,
      roleId,
    });
    await membership.save();
    return membership;
  };

  const addUser = async (email: string, tenant: string | null = tenantId) => {
    const user = await users.create({ email });
    await user.save();
    if (tenant) await addMember(user.id as string, tenant);
    return user.id as string;
  };

  const activeSessionIds = async (userId: string) =>
    (await sessions.findByUser(userId))
      .filter((session) => session.isValid())
      .map((session) => session.id as string);

  beforeEach(async () => {
    verified.encodings.length = 0;
    verified.padded.length = 0;
    audit = [];
    dbPath = join(
      tmpdir(),
      `smrt-password-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
    );
    options = { db: { type: 'sqlite', url: dbPath } };
    users = await UserCollection.create(options);
    sessions = await SessionCollection.create(options);
    memberships = await MembershipCollection.create(options);
    credentials = await UsersPasswordCredentialCollection.create(options);
    const tenants = await TenantCollection.create(options);
    const roles = await RoleCollection.create(options);

    const tenant = await tenants.create({ name: 'Office' });
    await tenant.save();
    tenantId = tenant.id as string;
    const other = await tenants.create({ name: 'Elsewhere' });
    await other.save();
    otherTenantId = other.id as string;
    const role = await roles.create({ name: 'Staff' });
    await role.save();
    roleId = role.id as string;

    personId = await addUser('pat@example.com');
    adminId = await addUser('admin@example.com');
    noPasswordId = await addUser('nopass@example.com');

    sessionService = await SessionService.create(options);
    service = await make();
    await service.setPassword({
      actor: adminActor(),
      userId: personId,
      password: PASSWORD,
    });
    audit.length = 0;
    verified.encodings.length = 0;
    verified.padded.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    if (existsSync(dbPath)) rmSync(dbPath, { force: true });
  });

  // -------------------------------------------------------------------------
  // The credential object
  // -------------------------------------------------------------------------

  it('stores the password in its own sensitive table as a self-describing scrypt hash', async () => {
    expect(new UsersPasswordCredential().tableName).toBe(
      'users_password_credentials',
    );
    const stored = await credentials.findByUserId(personId);
    expect(stored?.passwordHash.startsWith('scrypt$1024$8$1$')).toBe(true);
    expect(stored?.passwordHash).not.toContain(PASSWORD);
    expect(stored?.rotatedBy).toBe(adminId);
    expect(stored?.mustChange).toBe(false);
    // A fresh salt per hash: the same password never encodes the same way.
    await service.resetPassword({
      actor: adminActor(),
      userId: personId,
      password: PASSWORD,
      mustChange: false,
    });
    const again = await credentials.findByUserId(personId);
    expect(parseScryptHash(again?.passwordHash as string)?.salt).not.toEqual(
      parseScryptHash(stored?.passwordHash as string)?.salt,
    );
    expect(again?.version).toBe((stored?.version ?? 0) + 1);
  });

  it('keeps the credential off every generated surface and out of public serialization', async () => {
    const registered = ObjectRegistry.getClassInPackage(
      '@happyvertical/smrt-users',
      'UsersPasswordCredential',
    ) as { config: Record<string, unknown> };
    expect(registered.config).toMatchObject({
      sensitive: true,
      api: false,
      mcp: false,
      cli: false,
    });
    expect(isChangeFeedSensitiveTable('users_password_credentials')).toBe(true);
    const stored = await credentials.findByUserId(personId);
    const exposed = JSON.stringify(stored?.toPublicJSON());
    expect(exposed).not.toContain('scrypt$');
    expect(exposed).not.toContain('passwordHash');
    // No generated custom-action permission for the credential collection,
    // and the management permission is in the runtime catalog.
    const catalog = await new PermissionCatalogService(options).getCatalog();
    const slugs = catalog.permissions.map((permission) => permission.slug);
    expect(slugs).toContain(DEFAULT_PASSWORD_MANAGE_PERMISSION);
    expect(
      slugs.filter((slug) => slug.startsWith('users_password_credentials')),
    ).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Sign-in
  // -------------------------------------------------------------------------

  it('signs an active member in with a first-class password session', async () => {
    const result = await signIn('  PAT@Example.COM ', PASSWORD);
    expect(result).toMatchObject({
      userId: personId,
      tenantId,
      authMethod: PASSWORD_LOGIN_KIND,
      mustChange: false,
    });
    const context = await sessionService.loadSessionContext(result.sessionId);
    expect(context?.user.id).toBe(personId);
    expect(context?.tenantId).toBe(tenantId);
    expect(context?.authMethod).toBe('password');
    expect(context?.parent).toBeNull();
    expect(audit.map((entry) => entry.outcome)).toEqual(['succeeded']);
  });

  it('signs in without a tenant context when none is given', async () => {
    const result = await signIn('pat@example.com', PASSWORD, {
      tenantId: null,
    });
    expect(result.tenantId).toBeNull();
    const context = await sessionService.loadSessionContext(result.sessionId);
    expect(context?.tenantId).toBeNull();
    expect(context?.permissions).toEqual([]);
  });

  it('refuses every failure mode with one indistinguishable error and creates no session', async () => {
    const inactiveId = await addUser('gone@example.com');
    await service.setPassword({
      actor: adminActor(),
      userId: inactiveId,
      password: PASSWORD,
    });
    const inactive = await users.get(inactiveId);
    if (!inactive) throw new Error('missing user');
    inactive.status = UserStatus.SUSPENDED;
    await inactive.save();
    const outsiderId = await addUser('outsider@example.com', otherTenantId);
    await service.setPassword({
      actor: adminActor({ tenantId: otherTenantId }),
      userId: outsiderId,
      password: PASSWORD,
    });

    const attempts: Array<[string, string, string]> = [
      ['unknown identifier', 'nobody@example.com', PASSWORD],
      ['no password set', 'nopass@example.com', PASSWORD],
      ['wrong password', 'pat@example.com', 'wrong horse battery'],
      ['inactive user', 'gone@example.com', PASSWORD],
      ['no membership in tenant', 'outsider@example.com', PASSWORD],
      ['malformed identifier', 'not an email', PASSWORD],
      ['empty password', 'pat@example.com', ''],
      ['over-long password', 'pat@example.com', 'x'.repeat(5000)],
    ];
    const seen = new Set<string>();
    for (const [index, [label, identifier, password]] of attempts.entries()) {
      // A fresh address each time so the source budget never trips.
      const error = await signIn(identifier, password, {
        ipAddress: `203.0.113.${index + 10}`,
      }).catch((caught: unknown) => caught);
      expect(error, label).toBeInstanceOf(PasswordCredentialError);
      seen.add(
        JSON.stringify([
          (error as Error).name,
          (error as Error).message,
          Object.keys(error as object),
        ]),
      );
    }
    expect(seen.size).toBe(1);
    for (const userId of [personId, noPasswordId, inactiveId, outsiderId]) {
      expect(await activeSessionIds(userId)).toEqual([]);
    }
  });

  it('runs one scrypt verification under the current policy whether or not the account or password exists', async () => {
    for (const [index, [identifier, password]] of [
      ['nobody@example.com', PASSWORD],
      ['nopass@example.com', PASSWORD],
      ['pat@example.com', 'wrong horse battery'],
      ['pat@example.com', PASSWORD],
    ].entries()) {
      verified.encodings.length = 0;
      verified.padded.length = 0;
      // A fresh address each time so the source budget never trips.
      await signIn(identifier, password, {
        ipAddress: `203.0.113.${index + 50}`,
      }).catch(() => undefined);
      expect(verified.encodings, identifier).toHaveLength(1);
      expect(parseScryptHash(verified.encodings[0])?.params).toEqual(SCRYPT);
    }
  });

  it('pads a wrong-password check against a weaker stored hash to the work an unknown account costs', async () => {
    const weak = await make({ password: { scrypt: { N: 2 ** 8 } } });
    await weak.resetPassword({
      actor: adminActor(),
      userId: personId,
      password: PASSWORD,
      mustChange: false,
    });
    const stored = (await credentials.findByUserId(personId))
      ?.passwordHash as string;
    verified.encodings.length = 0;
    verified.padded.length = 0;
    await expect(
      signIn('pat@example.com', 'wrong horse battery'),
    ).rejects.toBeInstanceOf(PasswordCredentialError);
    expect(verified.encodings).toEqual([stored]);
    expect(verified.padded).toEqual([stored]);
    const padding = scryptPaddingParams(stored, SCRYPT);
    if (!padding) throw new Error('expected padding');
    const total =
      scryptCost(parseScryptHash(stored)?.params ?? SCRYPT) +
      scryptCost(padding);
    expect(Math.abs(total - scryptCost(SCRYPT))).toBeLessThanOrEqual(
      scryptCost(SCRYPT) / 8,
    );
    // The dummy and current-policy hashes need no padding.
    verified.padded.length = 0;
    await expect(
      signIn('nobody@example.com', PASSWORD, { ipAddress: '203.0.113.99' }),
    ).rejects.toBeInstanceOf(PasswordCredentialError);
    expect(verified.padded).toHaveLength(1);
    expect(scryptPaddingParams(verified.padded[0], SCRYPT)).toBeNull();
    // A malformed stored encoding owes the whole policy cost.
    expect(scryptCost(scryptPaddingParams('junk', SCRYPT) ?? SCRYPT)).toBe(
      scryptCost(SCRYPT),
    );
  });

  it('reserves and fails malformed attempts like any other', async () => {
    for (const [identifier, password] of [
      ['', PASSWORD],
      ['pat@example.com', ''],
      ['   ', ''],
    ]) {
      await expect(
        signIn(identifier, password, { ipAddress: '192.0.2.150' }),
      ).rejects.toBeInstanceOf(PasswordCredentialError);
    }
    expect(audit.map((entry) => entry.outcome)).toEqual([
      'failed',
      'failed',
      'locked',
    ]);
    // The address is now out of budget, even with the right password.
    await expect(
      signIn('pat@example.com', PASSWORD, { ipAddress: '192.0.2.150' }),
    ).rejects.toBeInstanceOf(LoginRateLimitError);
    // With nothing at all to key a budget on, it is refused outright.
    await expect(
      service.signIn({ identifier: '', password: PASSWORD }),
    ).rejects.toBeInstanceOf(PasswordCredentialError);
  });

  it('keeps identifiers, passwords, and hashes out of audit metadata', async () => {
    await signIn('pat@example.com', 'wrong horse battery').catch(
      () => undefined,
    );
    await signIn('nobody@example.com', PASSWORD).catch(() => undefined);
    await signIn('pat@example.com', PASSWORD);
    expect(audit.map((entry) => entry.outcome)).toEqual([
      'failed',
      'failed',
      'succeeded',
    ]);
    // Unknown and wrong are recorded identically apart from the hashed key.
    expect(audit[0].metadata).toEqual(audit[1].metadata);
    const recorded = JSON.stringify(audit);
    for (const secret of [
      'pat@example.com',
      'nobody@example.com',
      PASSWORD,
      'wrong horse battery',
      personId,
      'scrypt$',
    ]) {
      expect(recorded).not.toContain(secret);
    }
  });

  it('locks an account out after repeated failures, for known and unknown identifiers alike', async () => {
    for (const identifier of ['pat@example.com', 'nobody@example.com']) {
      for (let i = 0; i < 3; i++) {
        await expect(
          signIn(identifier, 'wrong horse battery', {
            ipAddress: `192.0.2.${i}`,
          }),
        ).rejects.toBeInstanceOf(PasswordCredentialError);
      }
      // Even the right password is refused now, from a fresh address.
      const error = await signIn(identifier, PASSWORD, {
        ipAddress: '192.0.2.200',
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(LoginRateLimitError);
      expect((error as LoginRateLimitError).retryAfterSeconds).toBeGreaterThan(
        0,
      );
    }
    expect(await activeSessionIds(personId)).toEqual([]);
  });

  it('locks a client address out when it fails across several accounts', async () => {
    for (let i = 0; i < 3; i++) {
      await expect(
        signIn(`guess-${i}@example.com`, PASSWORD, { ipAddress: '192.0.2.9' }),
      ).rejects.toBeInstanceOf(PasswordCredentialError);
    }
    await expect(
      signIn('pat@example.com', PASSWORD, { ipAddress: '192.0.2.9' }),
    ).rejects.toBeInstanceOf(LoginRateLimitError);
    // The account itself is not locked: another address gets in.
    const result = await signIn('pat@example.com', PASSWORD, {
      ipAddress: '192.0.2.10',
    });
    expect(result.userId).toBe(personId);
  });

  it('rehashes on sign-in when the stored parameters are below policy, keeping the generation', async () => {
    const weak = await make({ password: { scrypt: { N: 2 ** 8 } } });
    await weak.resetPassword({
      actor: adminActor(),
      userId: personId,
      password: PASSWORD,
      mustChange: false,
    });
    const before = await credentials.findByUserId(personId);
    expect(parseScryptHash(before?.passwordHash as string)?.params.N).toBe(256);

    await signIn('pat@example.com', PASSWORD);
    const after = await credentials.findByUserId(personId);
    expect(parseScryptHash(after?.passwordHash as string)?.params).toEqual(
      SCRYPT,
    );
    expect(after?.passwordHash).not.toBe(before?.passwordHash);
    expect(after?.version).toBe(before?.version);
    // The upgraded hash still verifies, and is left alone from then on.
    await signIn('pat@example.com', PASSWORD);
    expect((await credentials.findByUserId(personId))?.passwordHash).toBe(
      after?.passwordHash,
    );
  });

  it('never lets a parameter upgrade overwrite a password that changed after verification', async () => {
    const stored = await credentials.findByUserId(personId);
    expect(
      await credentials.replaceHashIfUnchanged(
        personId,
        'scrypt$stale',
        'scrypt$upgraded',
      ),
    ).toBe(false);
    expect((await credentials.findByUserId(personId))?.passwordHash).toBe(
      stored?.passwordHash,
    );
  });

  it('undoes a sign-in whose password was reset while it was in flight', async () => {
    const internals = service as unknown as {
      sessionService: SessionService;
    };
    const original = internals.sessionService.createSession.bind(
      internals.sessionService,
    );
    vi.spyOn(internals.sessionService, 'createSession').mockImplementation(
      async (...args) => {
        const sessionId = await original(...args);
        await service.resetPassword({
          actor: adminActor(),
          userId: personId,
          password: 'a different secret',
        });
        return sessionId;
      },
    );
    await expect(signIn('pat@example.com', PASSWORD)).rejects.toBeInstanceOf(
      PasswordCredentialError,
    );
    expect(await activeSessionIds(personId)).toEqual([]);
  });

  it('revokes the session the browser held before signing in', async () => {
    const before = await sessionService.createSession(personId, tenantId);
    const result = await service.signIn({
      identifier: 'pat@example.com',
      password: PASSWORD,
      tenantId,
      replaceSessionId: before,
    });
    expect(await sessionService.loadSessionContext(before)).toBeNull();
    expect(
      await sessionService.loadSessionContext(result.sessionId),
    ).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Policy
  // -------------------------------------------------------------------------

  it('enforces length bounds, the denylist, the email rule, and the host hook', async () => {
    const custom = await make({
      password: {
        scrypt: SCRYPT,
        denylist: ['Fabrication Shop'],
        reject: (password) =>
          password.includes('welder') ? 'No shop words.' : null,
      },
    });
    const refusals: Array<[string, RegExp]> = [
      ['short', /at least 10/u],
      ['x'.repeat(257), /at most 256/u],
      ['1234567890', /too common/u],
      ['Password123', /too common/u],
      ['fabrication shop', /too common/u],
      ['nopass@example.com', /email/u],
      ['best welder in town', /No shop words/u],
    ];
    for (const [password, message] of refusals) {
      const error = await custom
        .setPassword({
          actor: actorFor(noPasswordId),
          userId: noPasswordId,
          password,
        })
        .catch((caught: unknown) => caught);
      expect(error, password).toBeInstanceOf(PasswordPolicyError);
      expect((error as Error).message, password).toMatch(message);
    }
    expect(await custom.hasPassword(noPasswordId)).toBe(false);
    // No composition rules: a long lowercase phrase is fine.
    await custom.setPassword({
      actor: actorFor(noPasswordId),
      userId: noPasswordId,
      password: 'plain lowercase phrase',
    });
    expect(await custom.hasPassword(noPasswordId)).toBe(true);
  });

  it('normalizes Unicode so the same password typed differently signs in', async () => {
    const composed = 'café au lait please';
    const decomposed = 'café au lait please';
    await service.setPassword({
      actor: actorFor(noPasswordId),
      userId: noPasswordId,
      password: composed,
    });
    const result = await signIn('nopass@example.com', decomposed);
    expect(result.userId).toBe(noPasswordId);
  });

  it('refuses unsafe policy configuration', async () => {
    expect(
      () =>
        new PasswordCredentialService({
          ...options,
          password: { maxLength: 100_000 },
        }),
    ).toThrow(/maxLength/u);
    expect(
      () =>
        new PasswordCredentialService({
          ...options,
          password: { minLength: 20, maxLength: 10 },
        }),
    ).toThrow(/minLength/u);
    expect(
      () =>
        new PasswordCredentialService({
          ...options,
          password: { scrypt: { N: 1000 } },
        }),
    ).toThrow(/scrypt/u);
  });

  // -------------------------------------------------------------------------
  // Lifecycle and authority
  // -------------------------------------------------------------------------

  it('lets a person set their own first password, but not replace it without the current one', async () => {
    await service.setPassword({
      actor: actorFor(noPasswordId),
      userId: noPasswordId,
      password: PASSWORD,
    });
    expect((await credentials.findByUserId(noPasswordId))?.rotatedBy).toBe(
      'self',
    );
    await expect(
      service.setPassword({
        actor: actorFor(noPasswordId),
        userId: noPasswordId,
        password: 'another long secret',
      }),
    ).rejects.toBeInstanceOf(PasswordCredentialForbiddenError);
  });

  it('requires the management permission to set, reset, or clear another person’s password', async () => {
    const peer = actorFor(noPasswordId);
    await expect(
      service.setPassword({
        actor: peer,
        userId: personId,
        password: 'another long secret',
      }),
    ).rejects.toBeInstanceOf(PasswordCredentialForbiddenError);
    await expect(
      service.resetPassword({
        actor: peer,
        userId: personId,
        password: 'another long secret',
      }),
    ).rejects.toBeInstanceOf(PasswordCredentialForbiddenError);
    await expect(
      service.clearPassword({ actor: peer, userId: personId }),
    ).rejects.toBeInstanceOf(PasswordCredentialForbiddenError);
    expect(await service.hasPassword(personId)).toBe(true);
  });

  it('never manages passwords from a layered device session or for oneself by reset', async () => {
    const pinSession = adminActor({
      authMethod: 'pin',
      parent: {
        sessionId: 'device-session',
        userId: 'device',
        tenantId,
        authMethod: 'terminal',
      },
    });
    await expect(
      service.resetPassword({
        actor: pinSession,
        userId: personId,
        password: 'another long secret',
      }),
    ).rejects.toBeInstanceOf(PasswordCredentialForbiddenError);
    await expect(
      service.setPassword({
        actor: { ...actorFor(noPasswordId), authMethod: 'pin' },
        userId: noPasswordId,
        password: 'another long secret',
      }),
    ).rejects.toBeInstanceOf(PasswordCredentialForbiddenError);
    // An administrator cannot reset their own password without the current one.
    await expect(
      service.resetPassword({
        actor: adminActor(),
        userId: adminId,
        password: 'another long secret',
      }),
    ).rejects.toBeInstanceOf(PasswordCredentialForbiddenError);
  });

  it('confines administration to people whose every active membership is in the admin’s tenant', async () => {
    const elsewhereId = await addUser('elsewhere@example.com', otherTenantId);
    const bothId = await addUser('both@example.com');
    await addMember(bothId, otherTenantId);
    const lapsedId = await addUser('lapsed@example.com', otherTenantId);
    await addMember(lapsedId, tenantId);
    for (const target of [elsewhereId, bothId, crypto.randomUUID(), 'junk']) {
      await expect(
        service.resetPassword({
          actor: adminActor(),
          userId: target,
          password: 'another long secret',
        }),
        target,
      ).rejects.toBeInstanceOf(PasswordCredentialForbiddenError);
    }
    // Inactive memberships elsewhere do not count against the admin.
    const otherMembership = (await memberships.findByUser(lapsedId)).find(
      (membership) => membership.tenantId === otherTenantId,
    );
    if (!otherMembership) throw new Error('missing membership');
    otherMembership.status = MembershipStatus.INACTIVE;
    await otherMembership.save();
    await service.setPassword({
      actor: adminActor(),
      userId: lapsedId,
      password: 'another long secret',
    });
    expect(await service.hasPassword(lapsedId)).toBe(true);
  });

  it('changes a password with the current one and ends every other session of the person', async () => {
    const current = await signIn('pat@example.com', PASSWORD);
    const other = await signIn('pat@example.com', PASSWORD);
    const oidc = await sessionService.createSession(personId, tenantId, {
      authMethod: 'oidc',
    });
    const actor = await sessionService.loadSessionContext(current.sessionId);
    if (!actor) throw new Error('missing session');

    await expect(
      service.changePassword({
        actor,
        currentPassword: 'wrong horse battery',
        newPassword: 'a brand new secret',
      }),
    ).rejects.toBeInstanceOf(PasswordCredentialError);

    const result = await service.changePassword({
      actor,
      currentPassword: PASSWORD,
      newPassword: 'a brand new secret',
    });
    expect(result).toEqual({ revokedSessions: 2, endedCurrentSession: false });
    expect(await activeSessionIds(personId)).toEqual([current.sessionId]);
    expect(await sessionService.loadSessionContext(other.sessionId)).toBeNull();
    expect(await sessionService.loadSessionContext(oidc)).toBeNull();
    await expect(signIn('pat@example.com', PASSWORD)).rejects.toBeInstanceOf(
      PasswordCredentialError,
    );
    expect((await signIn('pat@example.com', 'a brand new secret')).userId).toBe(
      personId,
    );
  });

  it('draws current-password checks from the sign-in budget', async () => {
    const current = await signIn('pat@example.com', PASSWORD);
    const actor = await sessionService.loadSessionContext(current.sessionId);
    if (!actor) throw new Error('missing session');
    for (let i = 0; i < 3; i++) {
      await expect(
        service.changePassword({
          actor,
          currentPassword: `wrong guess ${i}`,
          newPassword: 'a brand new secret',
          ipAddress: `192.0.2.${i}`,
        }),
      ).rejects.toBeInstanceOf(PasswordCredentialError);
    }
    await expect(
      signIn('pat@example.com', PASSWORD, { ipAddress: '192.0.2.99' }),
    ).rejects.toBeInstanceOf(LoginRateLimitError);
  });

  it('never lets a change or self-clear proven with the old password overwrite a reset that landed meanwhile', async () => {
    const internals = service as unknown as {
      hashPassword: (password: string) => Promise<string>;
      sessionService: SessionService;
    };
    const live = await signIn('pat@example.com', PASSWORD);
    const actor = await sessionService.loadSessionContext(live.sessionId);
    if (!actor) throw new Error('missing session');
    const resetMeanwhile = () =>
      service.resetPassword({
        actor: adminActor(),
        userId: personId,
        password: 'admin chosen secret',
        mustChange: false,
      });

    // Change: the reset lands after the current password was proven.
    const hash = internals.hashPassword.bind(service);
    const hashSpy = vi
      .spyOn(internals, 'hashPassword')
      .mockImplementationOnce(async (password) => {
        await resetMeanwhile();
        return hash(password);
      });
    await expect(
      service.changePassword({
        actor,
        currentPassword: PASSWORD,
        newPassword: 'attacker chosen secret',
      }),
    ).rejects.toBeInstanceOf(PasswordCredentialError);
    hashSpy.mockRestore();
    await expect(
      signIn('pat@example.com', 'attacker chosen secret'),
    ).rejects.toBeInstanceOf(PasswordCredentialError);
    const afterChange = await signIn('pat@example.com', 'admin chosen secret');

    // Self-clear: the reset lands between the proof and the delete.
    const self = await sessionService.loadSessionContext(afterChange.sessionId);
    if (!self) throw new Error('missing session');
    const sweep = internals.sessionService.destroyUserSessionsByAuthMethod.bind(
      internals.sessionService,
    );
    const sweepSpy = vi
      .spyOn(internals.sessionService, 'destroyUserSessionsByAuthMethod')
      .mockImplementationOnce(async (...args) => {
        await service.resetPassword({
          actor: adminActor(),
          userId: personId,
          password: 'second admin secret',
          mustChange: false,
        });
        return sweep(...args);
      });
    await expect(
      service.clearPassword({
        actor: self,
        userId: personId,
        currentPassword: 'admin chosen secret',
      }),
    ).rejects.toBeInstanceOf(PasswordCredentialError);
    sweepSpy.mockRestore();
    expect(await service.hasPassword(personId)).toBe(true);
    expect(
      (await signIn('pat@example.com', 'second admin secret')).userId,
    ).toBe(personId);
  });

  it('never lets a first password overwrite one set concurrently', async () => {
    const internals = service as unknown as {
      hashPassword: (password: string) => Promise<string>;
    };
    const hash = internals.hashPassword.bind(service);
    vi.spyOn(internals, 'hashPassword').mockImplementationOnce(
      async (password) => {
        await service.setPassword({
          actor: adminActor(),
          userId: noPasswordId,
          password: 'admin chosen secret',
        });
        return hash(password);
      },
    );
    await expect(
      service.setPassword({
        actor: actorFor(noPasswordId),
        userId: noPasswordId,
        password: 'self chosen secret',
      }),
    ).rejects.toBeInstanceOf(PasswordCredentialForbiddenError);
    expect(
      (await signIn('nopass@example.com', 'admin chosen secret')).userId,
    ).toBe(noPasswordId);
  });

  it('resets a password, ends every session, and forces a change at next sign-in', async () => {
    const before = await signIn('pat@example.com', PASSWORD);
    const pinLike = await sessionService.createSession(personId, tenantId, {
      authMethod: 'oidc',
    });
    const reset = await service.resetPassword({
      actor: adminActor(),
      userId: personId,
      password: 'temporary secret 1',
    });
    expect(reset.revokedSessions).toBe(2);
    expect(
      await sessionService.loadSessionContext(before.sessionId),
    ).toBeNull();
    expect(await sessionService.loadSessionContext(pinLike)).toBeNull();
    await expect(signIn('pat@example.com', PASSWORD)).rejects.toBeInstanceOf(
      PasswordCredentialError,
    );

    // The temporary password yields a session that can do nothing but change it.
    const restricted = await signIn('pat@example.com', 'temporary secret 1');
    expect(restricted.mustChange).toBe(true);
    const actor = await sessionService.loadSessionContext(restricted.sessionId);
    expect(actor?.permissions).toEqual([]);
    expect(actor?.permissionCeiling).toEqual([]);
    if (!actor) throw new Error('missing session');
    await expect(
      service.clearPassword({
        actor,
        userId: personId,
        currentPassword: 'temporary secret 1',
      }),
    ).rejects.toBeInstanceOf(PasswordCredentialForbiddenError);

    const changed = await service.changePassword({
      actor,
      currentPassword: 'temporary secret 1',
      newPassword: 'my own new secret',
    });
    expect(changed.endedCurrentSession).toBe(true);
    expect(
      await sessionService.loadSessionContext(restricted.sessionId),
    ).toBeNull();
    const normal = await signIn('pat@example.com', 'my own new secret');
    expect(normal.mustChange).toBe(false);
  });

  it('clears a password for an admin, or for the person with the current one', async () => {
    const live = await signIn('pat@example.com', PASSWORD);
    const self = await sessionService.loadSessionContext(live.sessionId);
    if (!self) throw new Error('missing session');
    await expect(
      service.clearPassword({ actor: self, userId: personId }),
    ).rejects.toBeInstanceOf(PasswordCredentialError);
    const cleared = await service.clearPassword({
      actor: self,
      userId: personId,
      currentPassword: PASSWORD,
    });
    expect(cleared.revokedSessions).toBe(1);
    expect(await service.hasPassword(personId)).toBe(false);
    await expect(signIn('pat@example.com', PASSWORD)).rejects.toBeInstanceOf(
      PasswordCredentialError,
    );

    await service.setPassword({
      actor: adminActor(),
      userId: personId,
      password: PASSWORD,
    });
    await service.clearPassword({ actor: adminActor(), userId: personId });
    expect(await service.hasPassword(personId)).toBe(false);
    expect(
      audit
        .filter((entry) => entry.outcome === 'managed')
        .map((entry) => entry.metadata?.action),
    ).toEqual(['clear', 'set', 'clear']);
  });
});

describe('password credentials and the change feed', () => {
  let dbPath: string;
  let db: DatabaseInterface;

  afterEach(async () => {
    if (db && typeof db.close === 'function') await db.close();
    if (existsSync(dbPath)) rmSync(dbPath, { force: true });
  });

  it('writes no change-feed row for a password write', async () => {
    registerChangeFeedWriter();
    dbPath = join(
      tmpdir(),
      `smrt-password-feed-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
    );
    const options = { db: { type: 'sqlite' as const, url: dbPath } };
    const users = await UserCollection.create(options);
    db = users.db as DatabaseInterface;
    await ensureChangeFeedTable(db);
    const user = await users.create({ email: 'feed@example.com' });
    await user.save();
    const service = await PasswordCredentialService.create({
      ...options,
      password: { scrypt: SCRYPT },
      limiter: { audit: false },
    });
    await service.setPassword({
      actor: {
        user: { id: user.id } as never,
        permissions: [],
        tenantId: null,
        sessionId: 'self',
        authMethod: 'oidc',
        parent: null,
      },
      userId: user.id as string,
      password: PASSWORD,
    });
    const count = async (table: string) => {
      const result = (await db.query(
        `SELECT COUNT(*) AS n FROM ${CHANGE_FEED_TABLE} WHERE table_name = ?`,
        table,
      )) as unknown as { rows?: { n: number }[] };
      const rows = Array.isArray(result) ? result : (result.rows ?? []);
      return Number((rows[0] as { n?: unknown })?.n ?? 0);
    };
    // The feed is live (the user row was recorded) ...
    expect(await count('users')).toBeGreaterThan(0);
    // ... and holds nothing for the credential table.
    expect(await count('users_password_credentials')).toBe(0);
  });
});
