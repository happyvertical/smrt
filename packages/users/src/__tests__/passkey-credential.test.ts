/**
 * PasskeyCredentialService (#3275): ceremony state, the passkey sign-in order
 * and its refusals, limiter integration, the registration guards, and the
 * management authority rules. Real WebAuthn cryptography throughout: a
 * software authenticator signs genuine assertions, and
 * `@simplewebauthn/server` verifies them.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isChangeFeedSensitiveTable,
  ObjectRegistry,
} from '@happyvertical/smrt-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MembershipCollection } from '../collections/MembershipCollection.js';
import { UsersPasskeyChallengeCollection } from '../collections/PasskeyChallengeCollection.js';
import { UsersPasskeyCredentialCollection } from '../collections/PasskeyCredentialCollection.js';
import { RoleCollection } from '../collections/RoleCollection.js';
import { SessionCollection } from '../collections/SessionCollection.js';
import { TenantCollection } from '../collections/TenantCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import {
  type LoginAuditEntry,
  LoginRateLimitError,
} from '../services/LoginAttemptLimiter.js';
import {
  DEFAULT_PASSKEY_MANAGE_PERMISSION,
  PASSKEY_LOGIN_KIND,
  PasskeyCredentialError,
  PasskeyCredentialForbiddenError,
  PasskeyCredentialService,
  type PasskeyCredentialServiceOptions,
  PasskeyReauthenticationRequiredError,
  PasskeyRegistrationError,
} from '../services/PasskeyCredentialService.js';
import { PermissionCatalogService } from '../services/PermissionCatalogService.js';
import {
  type SessionContext,
  SessionService,
} from '../services/SessionService.js';
import { TerminalAuthService } from '../services/TerminalAuthService.js';
import { MembershipStatus, UserStatus } from '../types/index.js';
import { SoftAuthenticator } from './helpers/soft-authenticator.js';

const ORIGIN = 'https://app.example.com';
const RP_ID = 'app.example.com';
const SECRET = 'a-challenge-secret-of-at-least-32-characters';
const IP = '198.51.100.1';

describe('PasskeyCredentialService', () => {
  let dbPath: string;
  let options: { db: { type: 'sqlite'; url: string } };
  let users: UserCollection;
  let sessions: SessionCollection;
  let memberships: MembershipCollection;
  let passkeys: UsersPasskeyCredentialCollection;
  let challenges: UsersPasskeyChallengeCollection;
  let sessionService: SessionService;
  let service: PasskeyCredentialService;
  let audit: LoginAuditEntry[];
  let tenantId: string;
  let otherTenantId: string;
  let roleId: string;
  let personId: string;
  let adminId: string;
  let outsiderId: string;

  const make = (extra: Partial<PasskeyCredentialServiceOptions> = {}) =>
    PasskeyCredentialService.create({
      ...options,
      relyingParty: { origin: ORIGIN, rpName: 'Acme' },
      challengeSecret: SECRET,
      limiter: {
        maxAttempts: 3,
        windowSeconds: 60,
        audit: { record: async (entry) => void audit.push(entry) },
      },
      ...extra,
    });

  const newAuthenticator = (
    config: Partial<ConstructorParameters<typeof SoftAuthenticator>[0]> = {},
  ) => new SoftAuthenticator({ origin: ORIGIN, rpId: RP_ID, ...config });

  /** A real stored session for `userId`, as the context a host hook builds. */
  const actorFor = async (
    userId: string,
    extra: {
      authMethod?: string;
      permissions?: string[];
      ageSeconds?: number;
      data?: Record<string, unknown>;
      parentSessionId?: string;
      tenant?: string | null;
    } = {},
  ): Promise<SessionContext> => {
    const sessionId = await sessionService.createSession(
      userId,
      extra.tenant === null ? undefined : (extra.tenant ?? tenantId),
      {
        authMethod: extra.authMethod ?? 'password',
        data: extra.data,
        parentSessionId: extra.parentSessionId,
      },
    );
    if (extra.ageSeconds) {
      await sessions.db.query(
        `UPDATE ${sessions.tableName} SET created_at = ? WHERE id = ?`,
        new Date(Date.now() - extra.ageSeconds * 1000).toISOString(),
        sessionId,
      );
    }
    const context = await sessionService.loadSessionContext(sessionId);
    if (!context) throw new Error('no session');
    return { ...context, permissions: extra.permissions ?? [] };
  };

  const adminActor = (extra: Parameters<typeof actorFor>[1] = {}) =>
    actorFor(adminId, {
      permissions: [DEFAULT_PASSKEY_MANAGE_PERMISSION],
      ...extra,
    });

  /** Register `authenticator` for `actor`'s person through the full ceremony. */
  const register = async (
    authenticator: SoftAuthenticator,
    actor: SessionContext,
    name?: string,
    svc: PasskeyCredentialService = service,
  ) => {
    const begun = await svc.beginRegistration({ actor });
    return svc.finishRegistration({
      actor,
      ceremonyId: begun.ceremonyId,
      response: authenticator.register(begun.options),
      name,
      ipAddress: IP,
    });
  };

  /** One full sign-in with a fresh ceremony. */
  const signIn = async (
    authenticator: SoftAuthenticator,
    extra: {
      assertion?: Parameters<SoftAuthenticator['assert']>[1];
      tenantId?: string | null | 'unique-active-membership';
      ipAddress?: string;
      replaceSessionId?: string | null;
      svc?: PasskeyCredentialService;
    } = {},
  ) => {
    const svc = extra.svc ?? service;
    const begun = await svc.beginAuthentication();
    return svc.finishAuthentication({
      ceremonyId: begun.ceremonyId,
      response: authenticator.assert(begun.options, extra.assertion),
      tenantId: 'tenantId' in extra ? extra.tenantId : tenantId,
      ipAddress: extra.ipAddress ?? IP,
      replaceSessionId: extra.replaceSessionId,
    });
  };

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

  const passkeySessionIds = async (userId: string) =>
    (await sessions.findByUser(userId))
      .filter(
        (session) => session.isValid() && session.authMethod === 'passkey',
      )
      .map((session) => session.id as string);

  const failures = () => audit.filter((entry) => entry.outcome === 'failed');

  /** A person with one registered passkey, ready to sign in. */
  const enrolled = async (userId = personId) => {
    const authenticator = newAuthenticator();
    await register(authenticator, await actorFor(userId), 'Laptop');
    audit.length = 0;
    return authenticator;
  };

  beforeEach(async () => {
    audit = [];
    dbPath = join(
      tmpdir(),
      `smrt-passkey-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
    );
    options = { db: { type: 'sqlite', url: dbPath } };
    users = await UserCollection.create(options);
    require('node:fs').writeFileSync(
      '/tmp/claude-1000/t3.txt',
      JSON.stringify(
        (
          await users.db.query(
            "select name from sqlite_master where type='table'",
          )
        ).rows.map((x: any) => x.name),
      ),
    );
    sessions = await SessionCollection.create(options);
    memberships = await MembershipCollection.create(options);
    passkeys = await UsersPasskeyCredentialCollection.create(options);
    challenges = await UsersPasskeyChallengeCollection.create(options);
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
    outsiderId = await addUser('out@example.com', otherTenantId);

    sessionService = await SessionService.create(options);
    service = await make();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (existsSync(dbPath)) rmSync(dbPath, { force: true });
  });

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  describe('constructor', () => {
    const build = (extra: Record<string, unknown>) => () =>
      new PasskeyCredentialService({
        ...options,
        relyingParty: { origin: ORIGIN, rpName: 'Acme' },
        ...extra,
      } as PasskeyCredentialServiceOptions);

    it('requires a relying party', () => {
      expect(() => new PasskeyCredentialService(options as never)).toThrow(
        /relyingParty/,
      );
    });

    it.each([
      ['a relative origin', { origin: '/login' }],
      ['an http origin on a real host', { origin: 'http://app.example.com' }],
      ['an origin with a path', { origin: 'https://app.example.com/login' }],
      ['an origin with a query', { origin: 'https://app.example.com/?a=1' }],
      ['an origin with credentials', { origin: 'https://u:p@app.example.com' }],
      ['a non-web scheme', { origin: 'ftp://app.example.com' }],
      ['no origins', { origin: [] }],
      ['an rpId unrelated to the origin', { rpId: 'other.example.org' }],
      ['an rpId that is a sibling subdomain', { rpId: 'www.example.com' }],
      ['a top-level rpId', { rpId: 'com' }],
      ['a blank rpName', { rpName: '  ' }],
      [
        'an rpId that does not cover every origin',
        {
          origin: [ORIGIN, 'https://app.other.org'],
          rpId: 'example.com',
        },
      ],
    ])('rejects %s', (_label, relyingParty) => {
      expect(
        build({
          relyingParty: { origin: ORIGIN, rpName: 'Acme', ...relyingParty },
        }),
      ).toThrow(/relyingParty/);
    });

    it('accepts https origins, a parent-domain rpId, and loopback http', () => {
      expect(
        build({
          relyingParty: {
            origin: [ORIGIN, 'https://login.example.com'],
            rpId: 'example.com',
            rpName: 'Acme',
          },
        }),
      ).not.toThrow();
      for (const origin of [
        'http://localhost:5173',
        'http://127.0.0.1:3000',
        'http://[::1]:3000',
      ]) {
        expect(
          build({ relyingParty: { origin, rpName: 'Dev' } }),
        ).not.toThrow();
      }
    });

    it.each([
      ['a short challenge secret', { challengeSecret: 'too-short' }],
      ['a zero ceremony lifetime', { challengeTtlSeconds: 0 }],
      ['a ceremony lifetime over 10 minutes', { challengeTtlSeconds: 601 }],
      ['a fresh-session window under a minute', { freshSessionSeconds: 59 }],
      ['a fresh-session window over an hour', { freshSessionSeconds: 3601 }],
      ['no passkeys allowed', { maxPasskeysPerUser: 0 }],
      ['more than 100 passkeys', { maxPasskeysPerUser: 101 }],
      ['a non-positive session ttl', { sessionTtl: 0 }],
      ['an empty freshAuthMethods', { freshAuthMethods: [] }],
      [
        'terminal as a fresh method',
        { freshAuthMethods: ['password', 'terminal'] },
      ],
      ['pin as a fresh method', { freshAuthMethods: ['pin'] }],
      ['a blank fresh method', { freshAuthMethods: ['  '] }],
    ])('rejects %s', (_label, extra) => {
      expect(build(extra)).toThrow(/PasskeyCredentialService/);
    });
  });

  // -------------------------------------------------------------------------
  // The credential object
  // -------------------------------------------------------------------------

  it('keeps passkeys and challenges off every generated surface', async () => {
    for (const name of ['UsersPasskeyCredential', 'UsersPasskeyChallenge']) {
      const registered = ObjectRegistry.getClassInPackage(
        '@happyvertical/smrt-users',
        name,
      ) as { config: Record<string, unknown> };
      expect(registered.config).toMatchObject({
        sensitive: true,
        api: false,
        mcp: false,
        cli: false,
      });
    }
    expect(isChangeFeedSensitiveTable('users_passkey_credentials')).toBe(true);
    expect(isChangeFeedSensitiveTable('users_passkey_challenges')).toBe(true);
    const catalog = await new PermissionCatalogService(options).getCatalog();
    const slugs = catalog.permissions.map((permission) => permission.slug);
    expect(slugs).toContain(DEFAULT_PASSKEY_MANAGE_PERMISSION);
    expect(slugs.filter((slug) => slug.startsWith('users_passkey_'))).toEqual(
      [],
    );
  });

  // -------------------------------------------------------------------------
  // Registration and the happy path
  // -------------------------------------------------------------------------

  it('registers a passkey and signs in with it: a first-class passkey session', async () => {
    const authenticator = newAuthenticator();
    const actor = await actorFor(personId);
    const begun = await service.beginRegistration({ actor });
    expect(begun.options).toMatchObject({
      rp: { id: RP_ID, name: 'Acme' },
      user: { name: 'pat@example.com' },
      attestation: 'none',
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
      },
    });
    const { passkey } = await service.finishRegistration({
      actor,
      ceremonyId: begun.ceremonyId,
      response: authenticator.register(begun.options),
      name: '  MacBook  ',
      ipAddress: IP,
    });
    expect(passkey).toMatchObject({
      name: 'MacBook',
      backedUp: false,
      deviceType: 'singleDevice',
      lastUsedAt: null,
      transports: ['internal'],
    });
    expect(Object.keys(passkey).sort()).toEqual([
      'backedUp',
      'createdAt',
      'deviceType',
      'id',
      'lastUsedAt',
      'name',
      'transports',
    ]);
    const stored = await passkeys.findByCredentialId(authenticator.id);
    expect(stored?.userId).toBe(personId);
    expect(stored?.createdBy).toBe('self');
    audit.length = 0;

    const result = await signIn(authenticator);
    expect(result).toMatchObject({
      userId: personId,
      tenantId,
      authMethod: PASSKEY_LOGIN_KIND,
    });
    const context = await sessionService.loadSessionContext(result.sessionId);
    expect(context?.user.id).toBe(personId);
    expect(context?.tenantId).toBe(tenantId);
    expect(context?.authMethod).toBe('passkey');
    expect(context?.parent).toBeNull();
    const session = await sessions.findValidSession(result.sessionId);
    expect(session?.getData('passkeyCredentialId')).toBe(stored?.id);
    const after = await passkeys.findByCredentialId(authenticator.id);
    expect(after?.signCount).toBe(1);
    expect(after?.lastUsedAt).toBeInstanceOf(Date);
    expect(audit.map((entry) => entry.outcome)).toEqual(['succeeded']);
    expect(audit[0]?.kind).toBe('passkey');
  });

  it('defaults an empty name to "Passkey"', async () => {
    const { passkey } = await register(
      newAuthenticator(),
      await actorFor(personId),
      '   ',
    );
    expect(passkey.name).toBe('Passkey');
  });

  it.each([
    ['too long', 'x'.repeat(65)],
    ['containing control characters', 'bad\u0000name'],
  ])('refuses a name %s', async (_label, name) => {
    await expect(
      register(newAuthenticator(), await actorFor(personId), name),
    ).rejects.toBeInstanceOf(PasskeyRegistrationError);
    expect(await passkeys.countByUserId(personId)).toBe(0);
  });

  it('accepts names the base object cannot slug', async () => {
    const actor = await actorFor(personId);
    for (const name of ['日本語のパスキー', '🔑', '!!!']) {
      const { passkey } = await register(newAuthenticator(), actor, name);
      expect(passkey.name).toBe(name);
    }
    // Two people may pick the same name.
    await register(newAuthenticator(), await actorFor(adminId), '🔑');
    expect(await passkeys.countByUserId(personId)).toBe(3);
  });

  it('counts a 64 character name in code points', async () => {
    const name = '🔑'.repeat(64);
    const { passkey } = await register(
      newAuthenticator(),
      await actorFor(personId),
      name,
    );
    expect(passkey.name).toBe(name);
  });

  it('refuses a registration whose user verification flag is missing', async () => {
    const actor = await actorFor(personId);
    const begun = await service.beginRegistration({ actor });
    await expect(
      service.finishRegistration({
        actor,
        ceremonyId: begun.ceremonyId,
        response: newAuthenticator().register(begun.options, {
          userVerified: false,
        }),
      }),
    ).rejects.toBeInstanceOf(PasskeyRegistrationError);
    expect(await passkeys.countByUserId(personId)).toBe(0);
  });

  it.each([
    ['origin', { origin: 'https://evil.example.com' }],
    ['rpId', { rpId: 'evil.example.com' }],
  ])('refuses a registration with the wrong %s', async (_label, knobs) => {
    const actor = await actorFor(personId);
    const begun = await service.beginRegistration({ actor });
    await expect(
      service.finishRegistration({
        actor,
        ceremonyId: begun.ceremonyId,
        response: newAuthenticator().register(begun.options, knobs),
      }),
    ).rejects.toBeInstanceOf(PasskeyRegistrationError);
    expect(await passkeys.countByUserId(personId)).toBe(0);
  });

  it('refuses a registration ceremony that was begun by another session or person', async () => {
    const actor = await actorFor(personId);
    const begun = await service.beginRegistration({ actor });
    const sameUserOtherSession = await actorFor(personId);
    await expect(
      service.finishRegistration({
        actor: sameUserOtherSession,
        ceremonyId: begun.ceremonyId,
        response: newAuthenticator().register(begun.options),
      }),
    ).rejects.toBeInstanceOf(PasskeyRegistrationError);

    const second = await service.beginRegistration({ actor });
    const otherPerson = await actorFor(adminId);
    await expect(
      service.finishRegistration({
        actor: otherPerson,
        ceremonyId: second.ceremonyId,
        response: newAuthenticator().register(second.options),
      }),
    ).rejects.toBeInstanceOf(PasskeyRegistrationError);
    expect(await passkeys.countByUserId(personId)).toBe(0);
    expect(await passkeys.countByUserId(adminId)).toBe(0);
  });

  it('never puts the raw session id in a ceremony id', async () => {
    const actor = await actorFor(personId);
    const begun = await service.beginRegistration({ actor });
    const payload = Buffer.from(
      begun.ceremonyId.split('.')[0] as string,
      'base64url',
    ).toString('utf8');
    expect(payload).not.toContain(actor.sessionId);
    expect(JSON.parse(payload)).toMatchObject({
      v: 1,
      purpose: 'registration',
      userId: personId,
    });
  });

  it("lists the person's existing passkeys in excludeCredentials", async () => {
    const first = newAuthenticator();
    const actor = await actorFor(personId);
    await register(first, actor);
    const begun = await service.beginRegistration({ actor });
    expect(begun.options.excludeCredentials?.map((c) => c.id)).toEqual([
      first.id,
    ]);
  });

  it('refuses registration past the passkey limit, and a duplicate credential', async () => {
    const limited = await make({ maxPasskeysPerUser: 2 });
    const actor = await actorFor(personId);
    const first = newAuthenticator();
    await register(first, actor, 'one', limited);
    await register(newAuthenticator(), actor, 'two', limited);
    await expect(limited.beginRegistration({ actor })).rejects.toBeInstanceOf(
      PasskeyRegistrationError,
    );
    expect(await passkeys.countByUserId(personId)).toBe(2);

    // The same authenticator again (a client that ignores excludeCredentials).
    const roomy = await make();
    const other = await actorFor(adminId);
    await expect(register(first, other, 'dup', roomy)).rejects.toThrow(
      /already registered/,
    );
    expect(await passkeys.countByUserId(adminId)).toBe(0);
  });

  describe('registration needs a fresh, first-class, unrestricted session', () => {
    it('refuses a stale session with a re-authentication error', async () => {
      const stale = await actorFor(personId, { ageSeconds: 16 * 60 });
      await expect(
        service.beginRegistration({ actor: stale }),
      ).rejects.toBeInstanceOf(PasskeyReauthenticationRequiredError);
      const fresh = await actorFor(personId, { ageSeconds: 5 * 60 });
      await expect(
        service.beginRegistration({ actor: fresh }),
      ).resolves.toBeTruthy();
    });

    it('decides on the stored session row, not the caller-built context', async () => {
      const stale = await actorFor(personId, { ageSeconds: 60 * 60 });
      // A forged context claiming nothing about age cannot help: age is read
      // from the row. A context for a session that does not exist is refused.
      await expect(
        service.beginRegistration({ actor: { ...stale } }),
      ).rejects.toBeInstanceOf(PasskeyReauthenticationRequiredError);
      await expect(
        service.beginRegistration({
          actor: { ...stale, sessionId: crypto.randomUUID() },
        }),
      ).rejects.toBeInstanceOf(PasskeyCredentialForbiddenError);
      // A session belonging to someone else is not the actor's.
      const adminSession = await actorFor(adminId);
      await expect(
        service.beginRegistration({
          actor: { ...stale, sessionId: adminSession.sessionId },
        }),
      ).rejects.toBeInstanceOf(PasskeyCredentialForbiddenError);
    });

    it('honours freshSessionSeconds', async () => {
      const strict = await make({ freshSessionSeconds: 60 });
      const actor = await actorFor(personId, { ageSeconds: 120 });
      await expect(strict.beginRegistration({ actor })).rejects.toBeInstanceOf(
        PasskeyReauthenticationRequiredError,
      );
    });

    it('refuses a PIN or layered session', async () => {
      const device = await actorFor(adminId, { authMethod: 'terminal' });
      const layered = await actorFor(personId, {
        authMethod: 'pin',
        parentSessionId: device.sessionId,
      });
      expect(layered.parent).not.toBeNull();
      await expect(
        service.beginRegistration({ actor: layered }),
      ).rejects.toBeInstanceOf(PasskeyCredentialForbiddenError);
      // Whatever the caller-built context claims, the stored row decides.
      await expect(
        service.beginRegistration({ actor: { ...layered, parent: null } }),
      ).rejects.toBeInstanceOf(PasskeyCredentialForbiddenError);
      await expect(
        service.beginRegistration({
          actor: { ...layered, parent: null, authMethod: 'password' },
        }),
      ).rejects.toBeInstanceOf(PasskeyCredentialForbiddenError);
    });

    it('refuses a session with a permission ceiling', async () => {
      const restricted = await actorFor(personId, {
        data: { permissionCeiling: [] },
      });
      await expect(
        service.beginRegistration({ actor: restricted }),
      ).rejects.toBeInstanceOf(PasskeyCredentialForbiddenError);
    });

    describe('only interactive sign-in methods count as fresh', () => {
      it('refuses a fresh terminal session minted by approval from a stale stolen session', async () => {
        const terminal = await TerminalAuthService.create({
          ...options,
          requestTtlSeconds: 60,
          sessionTtlSeconds: 3600,
        });
        // A stolen cookie, a week old: not fresh.
        const stolen = await actorFor(personId, { ageSeconds: 7 * 86400 });
        await expect(
          service.beginRegistration({ actor: stolen }),
        ).rejects.toBeInstanceOf(PasskeyReauthenticationRequiredError);

        // The thief approves a device code from it, mints a brand new
        // first-class terminal session whose created_at is now...
        const started = await terminal.createRequest('https://example.com');
        const approved = await terminal.approveRequest({
          userCode: started.userCode,
          user: { id: personId, email: 'pat@example.com' },
          tenantId,
        });
        const laundered = (await sessionService.loadSessionContext(
          approved.sessionId as string,
        )) as SessionContext;
        expect(laundered.authMethod).toBe('terminal');
        expect(laundered.parent).toBeNull();
        expect(
          (
            await sessions.findValidSession(laundered.sessionId)
          )?.getAuthenticatedAt(),
        ).toBeInstanceOf(Date);

        // ...but terminal is not an interactive sign-in: registration and
        // self-removal are refused all the same.
        await expect(
          service.beginRegistration({ actor: laundered }),
        ).rejects.toBeInstanceOf(PasskeyReauthenticationRequiredError);
        const { passkey } = await register(
          newAuthenticator(),
          await actorFor(personId),
        );
        await expect(
          service.removePasskey({ actor: laundered, passkeyId: passkey.id }),
        ).rejects.toBeInstanceOf(PasskeyReauthenticationRequiredError);
        expect(await passkeys.countByUserId(personId)).toBe(1);
      });

      it('decides on the stored method, not the caller-built context', async () => {
        const terminal = await actorFor(personId, { authMethod: 'terminal' });
        await expect(
          service.beginRegistration({
            actor: { ...terminal, authMethod: 'password' },
          }),
        ).rejects.toBeInstanceOf(PasskeyReauthenticationRequiredError);
      });

      it.each([
        ['an unknown method', 'api-key'],
        ['a null method', null],
      ])('refuses %s', async (_label, method) => {
        const actor = await actorFor(personId, { authMethod: 'password' });
        await sessions.db.query(
          `UPDATE ${sessions.tableName} SET auth_method = ? WHERE id = ?`,
          method,
          actor.sessionId,
        );
        await expect(
          service.beginRegistration({ actor }),
        ).rejects.toBeInstanceOf(PasskeyReauthenticationRequiredError);
      });

      it.each([
        'password',
        'passkey',
        'oidc',
        'magic-link',
      ])('accepts %s by default', async (method) => {
        const actor = await actorFor(personId, { authMethod: method });
        await expect(
          service.beginRegistration({ actor }),
        ).resolves.toBeTruthy();
      });

      it('honours a narrower freshAuthMethods', async () => {
        const strict = await make({ freshAuthMethods: ['passkey'] });
        await expect(
          strict.beginRegistration({
            actor: await actorFor(personId, { authMethod: 'password' }),
          }),
        ).rejects.toBeInstanceOf(PasskeyReauthenticationRequiredError);
        await expect(
          strict.beginRegistration({
            actor: await actorFor(personId, { authMethod: 'passkey' }),
          }),
        ).resolves.toBeTruthy();
      });
    });

    describe('tenant-switch rotation does not launder session age', () => {
      it('keeps a stale session stale after it switches tenant', async () => {
        await addMember(personId, otherTenantId);
        const stale = await actorFor(personId, { ageSeconds: 7 * 86400 });
        const switched = await sessionService.switchTenant(
          stale.sessionId,
          otherTenantId,
        );
        expect(switched.rotated).toBe(true);
        const rotated = (await sessionService.loadSessionContext(
          switched.sessionId as string,
        )) as SessionContext;
        // The replacement row is brand new, yet it is not fresh.
        await expect(
          service.beginRegistration({ actor: rotated }),
        ).rejects.toBeInstanceOf(PasskeyReauthenticationRequiredError);
        // Rotating again changes nothing.
        const again = await sessionService.switchTenant(
          switched.sessionId as string,
          tenantId,
        );
        const twice = (await sessionService.loadSessionContext(
          again.sessionId as string,
        )) as SessionContext;
        await expect(
          service.beginRegistration({ actor: twice }),
        ).rejects.toBeInstanceOf(PasskeyReauthenticationRequiredError);
        const { passkey } = await register(
          newAuthenticator(),
          await actorFor(personId),
        );
        await expect(
          service.removePasskey({ actor: twice, passkeyId: passkey.id }),
        ).rejects.toBeInstanceOf(PasskeyReauthenticationRequiredError);
      });

      it('keeps a fresh session fresh after it switches tenant', async () => {
        await addMember(personId, otherTenantId);
        const fresh = await actorFor(personId, { ageSeconds: 60 });
        const switched = await sessionService.switchTenant(
          fresh.sessionId,
          otherTenantId,
        );
        const rotated = (await sessionService.loadSessionContext(
          switched.sessionId as string,
        )) as SessionContext;
        await expect(
          service.beginRegistration({ actor: rotated }),
        ).resolves.toBeTruthy();
      });

      it('cannot be written through setSessionData', async () => {
        const stale = await actorFor(personId, { ageSeconds: 7 * 86400 });
        expect(
          await sessionService.setSessionData(
            stale.sessionId,
            'authenticatedAt',
            new Date().toISOString(),
          ),
        ).toBe(false);
        await expect(
          service.beginRegistration({ actor: stale }),
        ).rejects.toBeInstanceOf(PasskeyReauthenticationRequiredError);
        expect(
          await sessionService.setSessionData(
            stale.sessionId,
            'passkeyCredentialId',
            crypto.randomUUID(),
          ),
        ).toBe(false);
        expect(
          (await sessions.findValidSession(stale.sessionId))?.getData(
            'passkeyCredentialId',
          ),
        ).toBeUndefined();
        // Other keys still work.
        expect(
          await sessionService.setSessionData(stale.sessionId, 'note', 'x'),
        ).toBe(true);
      });

      it.each([
        ['not a date', 'yesterday-ish'],
        ['not a string', 12345],
        ['in the future', new Date(Date.now() + 86_400_000).toISOString()],
      ])('refuses a malformed stamp (%s)', async (_label, stamp) => {
        const actor = await actorFor(personId, {
          data: { authenticatedAt: stamp },
        });
        await expect(
          service.beginRegistration({ actor }),
        ).rejects.toBeInstanceOf(PasskeyReauthenticationRequiredError);
      });

      it('trusts a valid recent stamp over an old row', async () => {
        const actor = await actorFor(personId, {
          data: { authenticatedAt: new Date().toISOString() },
          ageSeconds: 7 * 86400,
        });
        await expect(
          service.beginRegistration({ actor }),
        ).resolves.toBeTruthy();
      });
    });

    it('refuses an inactive person', async () => {
      const actor = await actorFor(personId);
      const user = await users.get(personId);
      if (!user) throw new Error('missing user');
      user.status = UserStatus.SUSPENDED;
      await user.save();
      await expect(service.beginRegistration({ actor })).rejects.toBeInstanceOf(
        PasskeyCredentialForbiddenError,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Ceremony state
  // -------------------------------------------------------------------------

  describe('ceremonies', () => {
    it('writes nothing when a sign-in is begun', async () => {
      await service.beginAuthentication();
      await service.beginAuthentication();
      expect((await challenges.list({ limit: 10 })).length).toBe(0);
      expect(audit).toEqual([]);
    });

    it('issues usernameless options that require user verification', async () => {
      const begun = await service.beginAuthentication();
      expect(begun.options).toMatchObject({
        rpId: RP_ID,
        userVerification: 'required',
      });
      expect(begun.options.allowCredentials ?? []).toEqual([]);
      expect(begun.ceremonyId.length).toBeLessThan(4096);
    });

    it('refuses a replayed ceremony, even for a fresh valid assertion', async () => {
      const authenticator = await enrolled();
      const begun = await service.beginAuthentication();
      const before = (await challenges.list({ limit: 10 })).length;
      const response = authenticator.assert(begun.options);
      const ok = await service.finishAuthentication({
        ceremonyId: begun.ceremonyId,
        response,
        tenantId,
        ipAddress: IP,
      });
      expect(ok.userId).toBe(personId);
      // The same ceremony with a brand new (counter-advancing) assertion.
      await expect(
        service.finishAuthentication({
          ceremonyId: begun.ceremonyId,
          response: authenticator.assert(begun.options),
          tenantId,
          ipAddress: IP,
        }),
      ).rejects.toBeInstanceOf(PasskeyCredentialError);
      expect((await challenges.list({ limit: 10 })).length).toBe(before + 1);
      expect(failures()).toHaveLength(1);
    });

    it('lets exactly one of several simultaneous uses of one ceremony through', async () => {
      const authenticator = await enrolled();
      const begun = await service.beginAuthentication();
      const attempts = await Promise.allSettled(
        [1, 2, 3].map(() =>
          service.finishAuthentication({
            ceremonyId: begun.ceremonyId,
            response: authenticator.assert(begun.options, { counter: 50 }),
            tenantId,
            ipAddress: IP,
          }),
        ),
      );
      const rejected = attempts.filter((a) => a.status === 'rejected');
      // Three attempts exhaust a 3 budget; every loser is a refusal or a rate limit.
      expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
      for (const loser of rejected) {
        expect(
          loser.reason instanceof PasskeyCredentialError ||
            loser.reason instanceof LoginRateLimitError,
        ).toBe(true);
      }
    });

    it('refuses an expired ceremony', async () => {
      const authenticator = await enrolled();
      const begun = await service.beginAuthentication();
      const response = authenticator.assert(begun.options);
      const realNow = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(realNow + 301 * 1000);
      await expect(
        service.finishAuthentication({
          ceremonyId: begun.ceremonyId,
          response,
          tenantId,
          ipAddress: IP,
        }),
      ).rejects.toBeInstanceOf(PasskeyCredentialError);
    });

    it('refuses a tampered ceremony id', async () => {
      const authenticator = await enrolled();
      const lenient = await make({
        limiter: { maxAttempts: 50, windowSeconds: 60, audit: false },
      });
      const begun = await lenient.beginAuthentication();
      const [payloadB64, mac] = begun.ceremonyId.split('.') as [string, string];
      const payload = JSON.parse(
        Buffer.from(payloadB64, 'base64url').toString('utf8'),
      );
      const forgedPayload = Buffer.from(
        JSON.stringify({ ...payload, exp: payload.exp + 3_600_000 }),
      ).toString('base64url');
      const response = authenticator.assert(begun.options);
      const cases = [
        `${forgedPayload}.${mac}`,
        `${payloadB64}.${mac.slice(0, -2)}AA`,
        `${payloadB64}`,
        `${payloadB64}.${mac}.extra`,
        '',
        'not a ceremony',
        `${'A'.repeat(5000)}.${mac}`,
        `${payloadB64}.`,
      ];
      for (const [index, ceremonyId] of cases.entries()) {
        await expect(
          lenient.finishAuthentication({
            ceremonyId,
            response,
            tenantId,
            // One address each: this loop is not about the limiter.
            ipAddress: `203.0.113.${index + 10}`,
          }),
        ).rejects.toBeInstanceOf(PasskeyCredentialError);
      }
      // None of them consumed anything, so the real ceremony still works.
      const ok = await lenient.finishAuthentication({
        ceremonyId: begun.ceremonyId,
        response,
        tenantId,
        ipAddress: IP,
      });
      expect(ok.userId).toBe(personId);
    });

    it('rejects a non-string ceremony id without throwing a TypeError', async () => {
      const authenticator = await enrolled();
      const begun = await service.beginAuthentication();
      await expect(
        service.finishAuthentication({
          ceremonyId: { not: 'a string' } as never,
          response: authenticator.assert(begun.options),
          ipAddress: IP,
        }),
      ).rejects.toBeInstanceOf(PasskeyCredentialError);
    });

    it('refuses a ceremony signed with another secret or issued for registration', async () => {
      const authenticator = await enrolled();
      const foreign = await make({
        challengeSecret: 'another-secret-with-at-least-32-chars!!',
      });
      const begunElsewhere = await foreign.beginAuthentication();
      await expect(
        service.finishAuthentication({
          ceremonyId: begunElsewhere.ceremonyId,
          response: authenticator.assert(begunElsewhere.options),
          tenantId,
          ipAddress: IP,
        }),
      ).rejects.toBeInstanceOf(PasskeyCredentialError);

      // A registration ceremony (validly signed) is not a sign-in ceremony.
      const actor = await actorFor(personId);
      const registration = await service.beginRegistration({ actor });
      await expect(
        service.finishAuthentication({
          ceremonyId: registration.ceremonyId,
          response: authenticator.assert(registration.options as never),
          tenantId,
          ipAddress: IP,
        }),
      ).rejects.toBeInstanceOf(PasskeyCredentialError);
      // ...and a sign-in ceremony is not a registration ceremony.
      const signInCeremony = await service.beginAuthentication();
      await expect(
        service.finishRegistration({
          actor,
          ceremonyId: signInCeremony.ceremonyId,
          response: newAuthenticator().register({
            challenge: signInCeremony.options.challenge,
            user: { id: 'x' },
          }),
        }),
      ).rejects.toBeInstanceOf(PasskeyRegistrationError);
    });

    it('verifies on another instance that shares the secret (multi-process)', async () => {
      const authenticator = await enrolled();
      const other = await make();
      const begun = await service.beginAuthentication();
      const ok = await other.finishAuthentication({
        ceremonyId: begun.ceremonyId,
        response: authenticator.assert(begun.options),
        tenantId,
        ipAddress: IP,
      });
      expect(ok.userId).toBe(personId);
    });

    it('uses a per-instance secret when none is configured', async () => {
      const a = await make({ challengeSecret: undefined });
      const b = await make({ challengeSecret: undefined });
      const authenticator = await enrolled();
      const begun = await a.beginAuthentication();
      await expect(
        b.finishAuthentication({
          ceremonyId: begun.ceremonyId,
          response: authenticator.assert(begun.options),
          tenantId,
          ipAddress: IP,
        }),
      ).rejects.toBeInstanceOf(PasskeyCredentialError);
    });
  });

  // -------------------------------------------------------------------------
  // Sign-in refusals
  // -------------------------------------------------------------------------

  describe('sign-in refusals', () => {
    it.each([
      ['user verification missing', { userVerified: false }],
      ['user presence missing', { userPresent: false }],
      ['the wrong origin', { origin: 'https://evil.example.com' }],
      ['the wrong rpId', { rpId: 'evil.example.com' }],
      ['a corrupted signature', { badSignature: true }],
      [
        'a different challenge',
        { challenge: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
      ],
    ])('refuses an assertion with %s', async (_label, assertion) => {
      const authenticator = await enrolled();
      await expect(signIn(authenticator, { assertion })).rejects.toBeInstanceOf(
        PasskeyCredentialError,
      );
      expect(failures()).toHaveLength(1);
      expect(await passkeySessionIds(personId)).toEqual([]);
      // The counter did not advance: a refused assertion records nothing.
      expect(
        (await passkeys.findByCredentialId(authenticator.id))?.signCount,
      ).toBe(0);
    });

    it('refuses an unknown credential id exactly like a wrong one, through the limiter', async () => {
      await enrolled();
      const stranger = newAuthenticator();
      stranger.userHandle = Buffer.from(personId).toString('base64url');
      await expect(signIn(stranger)).rejects.toBeInstanceOf(
        PasskeyCredentialError,
      );
      expect(failures()).toHaveLength(1);
      expect(audit.some((entry) => entry.subjectKeyHash)).toBe(true);
      // The error is the same class and message as any other refusal.
      await expect(signIn(stranger)).rejects.toMatchObject({
        message: 'Invalid credentials.',
        name: 'PasskeyCredentialError',
      });
    });

    it('rate limits repeated failures by source', async () => {
      await enrolled();
      for (let attempt = 0; attempt < 3; attempt++) {
        await expect(signIn(newAuthenticator())).rejects.toBeInstanceOf(
          PasskeyCredentialError,
        );
      }
      await expect(signIn(newAuthenticator())).rejects.toBeInstanceOf(
        LoginRateLimitError,
      );
      // The locked source is refused even for a genuine passkey.
      const real = newAuthenticator();
      await register(real, await actorFor(adminId));
      await expect(signIn(real)).rejects.toBeInstanceOf(LoginRateLimitError);
      // Another source is unaffected.
      const ok = await signIn(real, { ipAddress: '203.0.113.50' });
      expect(ok.userId).toBe(adminId);
    });

    it('rate limits repeated failures against one credential id from many sources', async () => {
      const authenticator = await enrolled();
      for (let attempt = 0; attempt < 3; attempt++) {
        await expect(
          signIn(authenticator, {
            ipAddress: `203.0.113.${attempt + 1}`,
            assertion: { userVerified: false },
          }),
        ).rejects.toBeInstanceOf(PasskeyCredentialError);
      }
      await expect(
        signIn(authenticator, { ipAddress: '203.0.113.99' }),
      ).rejects.toBeInstanceOf(LoginRateLimitError);
    });

    it('reserves before any other work: a malformed body is still a counted attempt', async () => {
      await expect(
        service.finishAuthentication({
          ceremonyId: 'x',
          response: 'not even an object',
          ipAddress: IP,
        }),
      ).rejects.toBeInstanceOf(PasskeyCredentialError);
      expect(failures()).toHaveLength(1);
      // No id and no source budget to key on: refused without a reservation.
      await expect(
        service.finishAuthentication({ ceremonyId: 'x', response: null }),
      ).rejects.toBeInstanceOf(PasskeyCredentialError);
    });

    it('refuses a counter that did not advance, and says why in the audit event', async () => {
      const authenticator = await enrolled();
      await signIn(authenticator, { assertion: { counter: 5 } });
      audit.length = 0;
      await expect(
        signIn(authenticator, { assertion: { counter: 5 } }),
      ).rejects.toBeInstanceOf(PasskeyCredentialError);
      await expect(
        signIn(authenticator, { assertion: { counter: 3 } }),
      ).rejects.toBeInstanceOf(PasskeyCredentialError);
      expect(failures()).toHaveLength(2);
      expect(failures()[0]?.metadata).toMatchObject({ reason: 'counter' });
      expect(
        (await passkeys.findByCredentialId(authenticator.id))?.signCount,
      ).toBe(5);
      // A later, advancing assertion still works.
      await expect(
        signIn(authenticator, {
          assertion: { counter: 6 },
          ipAddress: '203.0.113.5',
        }),
      ).resolves.toMatchObject({ userId: personId });
    });

    it('accepts an authenticator that never counts (always zero)', async () => {
      const authenticator = await enrolled();
      await expect(
        signIn(authenticator, { assertion: { counter: 0 } }),
      ).resolves.toMatchObject({ userId: personId });
      await expect(
        signIn(authenticator, { assertion: { counter: 0 } }),
      ).resolves.toMatchObject({ userId: personId });
    });

    it('refuses a user handle that is not the credential owner', async () => {
      const authenticator = await enrolled();
      await expect(
        signIn(authenticator, {
          assertion: { userHandle: Buffer.from(adminId).toString('base64url') },
        }),
      ).rejects.toBeInstanceOf(PasskeyCredentialError);
      // An absent handle is allowed; the right one is allowed.
      await expect(
        signIn(authenticator, { assertion: { userHandle: null } }),
      ).resolves.toMatchObject({ userId: personId });
      await expect(
        signIn(authenticator, {
          assertion: {
            userHandle: Buffer.from(personId).toString('base64url'),
          },
        }),
      ).resolves.toMatchObject({ userId: personId });
    });

    it('refuses an inactive person', async () => {
      const authenticator = await enrolled();
      const user = await users.get(personId);
      if (!user) throw new Error('missing user');
      user.status = UserStatus.SUSPENDED;
      await user.save();
      await expect(signIn(authenticator)).rejects.toBeInstanceOf(
        PasskeyCredentialError,
      );
      expect(await passkeySessionIds(personId)).toEqual([]);
    });

    it('requires an active membership in the requested tenant', async () => {
      const authenticator = await enrolled();
      await expect(
        signIn(authenticator, { tenantId: otherTenantId }),
      ).rejects.toBeInstanceOf(PasskeyCredentialError);
      const membership = await addMember(personId, otherTenantId);
      await expect(
        signIn(authenticator, { tenantId: otherTenantId }),
      ).resolves.toMatchObject({ tenantId: otherTenantId });
      membership.status = MembershipStatus.SUSPENDED;
      await membership.save();
      await expect(
        signIn(authenticator, { tenantId: otherTenantId }),
      ).rejects.toBeInstanceOf(PasskeyCredentialError);
    });

    it('signs in tenantless, and resolves a unique active membership only after verification', async () => {
      const authenticator = await enrolled();
      const tenantless = await signIn(authenticator, { tenantId: null });
      expect(tenantless.tenantId).toBeNull();
      const unique = await signIn(authenticator, {
        tenantId: 'unique-active-membership',
      });
      expect(unique.tenantId).toBe(tenantId);
      // Ambiguity (two memberships) is a refusal, not an unscoped session.
      await addMember(personId, otherTenantId);
      await expect(
        signIn(authenticator, { tenantId: 'unique-active-membership' }),
      ).rejects.toBeInstanceOf(PasskeyCredentialError);
      // A person with no membership at all is refused too.
      const loner = await addUser('loner@example.com', null);
      const lonerKey = newAuthenticator();
      await register(lonerKey, await actorFor(loner, { tenant: null }));
      await expect(
        signIn(lonerKey, { tenantId: 'unique-active-membership' }),
      ).rejects.toBeInstanceOf(PasskeyCredentialError);
    });

    it('revokes the session the client presented before signing in', async () => {
      const authenticator = await enrolled();
      const planted = await sessionService.createSession(personId, tenantId, {
        authMethod: 'password',
      });
      const result = await signIn(authenticator, { replaceSessionId: planted });
      expect(await sessions.findValidSession(planted)).toBeNull();
      expect(await sessions.findValidSession(result.sessionId)).not.toBeNull();
    });

    it('keeps the presented session when the sign-in is refused', async () => {
      const authenticator = await enrolled();
      const planted = await sessionService.createSession(personId, tenantId, {
        authMethod: 'password',
      });
      await expect(
        signIn(authenticator, {
          replaceSessionId: planted,
          assertion: { userVerified: false },
        }),
      ).rejects.toBeInstanceOf(PasskeyCredentialError);
      expect(await sessions.findValidSession(planted)).not.toBeNull();
    });

    it('refuses, and leaves no session, when the passkey is removed between verification and mint', async () => {
      const authenticator = await enrolled();
      const internal = service as unknown as {
        sessionService: SessionService;
      };
      const original = internal.sessionService.createSession.bind(
        internal.sessionService,
      );
      vi.spyOn(internal.sessionService, 'createSession').mockImplementation(
        async (...args) => {
          const row = await passkeys.findByCredentialId(authenticator.id);
          await passkeys.deleteOwned(row?.id as string, personId);
          return original(...args);
        },
      );
      await expect(signIn(authenticator)).rejects.toBeInstanceOf(
        PasskeyCredentialError,
      );
      expect(await passkeySessionIds(personId)).toEqual([]);
      expect(failures()).toHaveLength(1);
      expect(failures()[0]?.metadata).toMatchObject({ reason: 'superseded' });
    });

    it('refuses the loser of a concurrent assertion on the same credential, leaving no session', async () => {
      const authenticator = await enrolled();
      const first = await service.beginAuthentication();
      const second = await service.beginAuthentication();
      const a = authenticator.assert(first.options, { counter: 9 });
      const b = authenticator.assert(second.options, { counter: 9 });
      const results = await Promise.allSettled([
        service.finishAuthentication({
          ceremonyId: first.ceremonyId,
          response: a,
          tenantId,
          ipAddress: '203.0.113.1',
        }),
        service.finishAuthentication({
          ceremonyId: second.ceremonyId,
          response: b,
          tenantId,
          ipAddress: '203.0.113.2',
        }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await passkeySessionIds(personId)).toHaveLength(1);
    });

    it('releases the reservation (no failure) when infrastructure fails', async () => {
      const authenticator = await enrolled();
      vi.spyOn(
        (service as unknown as { users: UserCollection }).users,
        'get',
      ).mockRejectedValue(new Error('database unavailable'));
      await expect(signIn(authenticator)).rejects.toThrow(
        'database unavailable',
      );
      expect(failures()).toHaveLength(0);
      expect(audit.map((entry) => entry.outcome)).not.toContain('failed');
    });
  });

  // -------------------------------------------------------------------------
  // Management
  // -------------------------------------------------------------------------

  describe('listing and renaming', () => {
    it("lists the person's own passkeys without key material or credential ids", async () => {
      const authenticator = newAuthenticator();
      const actor = await actorFor(personId);
      await register(authenticator, actor, 'Laptop');
      await register(newAuthenticator(), actor, 'Phone');
      const list = await service.listPasskeys({ actor });
      expect(list.map((p) => p.name)).toEqual(['Laptop', 'Phone']);
      const serialized = JSON.stringify(list);
      expect(serialized).not.toContain(authenticator.id);
      expect(serialized).not.toMatch(/publicKey|credentialId/i);
      // Listing does not need a fresh session.
      const stale = await actorFor(personId, { ageSeconds: 7200 });
      expect(await service.listPasskeys({ actor: stale })).toHaveLength(2);
    });

    it('lets an administrator list a person in their tenant, not a foreign one', async () => {
      await register(newAuthenticator(), await actorFor(personId), 'Laptop');
      await register(
        newAuthenticator(),
        await actorFor(outsiderId, { tenant: otherTenantId }),
        'Away',
      );
      const admin = await adminActor();
      expect(
        (await service.listPasskeys({ actor: admin, userId: personId })).map(
          (p) => p.name,
        ),
      ).toEqual(['Laptop']);
      await expect(
        service.listPasskeys({ actor: admin, userId: outsiderId }),
      ).rejects.toBeInstanceOf(PasskeyCredentialForbiddenError);
      // Without the permission, another person's list is forbidden.
      await expect(
        service.listPasskeys({
          actor: await actorFor(adminId),
          userId: personId,
        }),
      ).rejects.toBeInstanceOf(PasskeyCredentialForbiddenError);
      // A person in two tenants is out of reach of a single-tenant admin.
      await addMember(personId, otherTenantId);
      await expect(
        service.listPasskeys({ actor: admin, userId: personId }),
      ).rejects.toBeInstanceOf(PasskeyCredentialForbiddenError);
    });

    it('refuses a session with a permission ceiling for self list and rename, but not the admin list path', async () => {
      const actor = await actorFor(personId);
      const { passkey } = await register(newAuthenticator(), actor, 'Laptop');
      const restricted = await actorFor(personId, {
        data: { permissionCeiling: [] },
      });
      await expect(
        service.listPasskeys({ actor: restricted }),
      ).rejects.toBeInstanceOf(PasskeyCredentialForbiddenError);
      await expect(
        service.renamePasskey({
          actor: restricted,
          passkeyId: passkey.id,
          name: 'Hijacked',
        }),
      ).rejects.toBeInstanceOf(PasskeyCredentialForbiddenError);
      // Decided on the stored row: a context that hides the ceiling is no help.
      await expect(
        service.listPasskeys({
          actor: { ...restricted, permissionCeiling: null },
        }),
      ).rejects.toBeInstanceOf(PasskeyCredentialForbiddenError);
      expect((await passkeys.get(passkey.id))?.name).toBe('Laptop');
      // An administrator listing someone else is unchanged.
      const admin = await adminActor();
      expect(
        await service.listPasskeys({ actor: admin, userId: personId }),
      ).toHaveLength(1);
    });

    it('refuses self list and rename for a context whose stored session is gone', async () => {
      const actor = await actorFor(personId);
      await sessionService.destroySession(actor.sessionId);
      await expect(service.listPasskeys({ actor })).rejects.toBeInstanceOf(
        PasskeyCredentialForbiddenError,
      );
    });

    it('refuses layered sessions', async () => {
      const device = await actorFor(adminId, { authMethod: 'terminal' });
      const layered = await actorFor(personId, {
        authMethod: 'pin',
        parentSessionId: device.sessionId,
      });
      await expect(
        service.listPasskeys({ actor: layered }),
      ).rejects.toBeInstanceOf(PasskeyCredentialForbiddenError);
    });

    it("renames only the person's own passkey", async () => {
      const actor = await actorFor(personId);
      const { passkey } = await register(newAuthenticator(), actor, 'Laptop');
      const renamed = await service.renamePasskey({
        actor,
        passkeyId: passkey.id,
        name: ' Work laptop ',
      });
      expect(renamed.passkey.name).toBe('Work laptop');
      expect((await passkeys.get(passkey.id))?.name).toBe('Work laptop');
      await expect(
        service.renamePasskey({
          actor: await adminActor(),
          passkeyId: passkey.id,
          name: 'Hijacked',
        }),
      ).rejects.toBeInstanceOf(PasskeyCredentialForbiddenError);
      await expect(
        service.renamePasskey({ actor, passkeyId: passkey.id, name: '   ' }),
      ).rejects.toBeInstanceOf(PasskeyRegistrationError);
      await expect(
        service.renamePasskey({ actor, passkeyId: 'nope', name: 'x' }),
      ).rejects.toBeInstanceOf(PasskeyCredentialForbiddenError);
    });
  });

  describe('removal', () => {
    it('lets a person remove their own passkey, ending the right sessions', async () => {
      const a = newAuthenticator();
      const b = newAuthenticator();
      const setup = await actorFor(personId);
      const { passkey: passkeyA } = await register(a, setup, 'A');
      const { passkey: passkeyB } = await register(b, setup, 'B');
      const sessionA1 = (await signIn(a, { ipAddress: '203.0.113.1' }))
        .sessionId;
      const sessionA2 = (await signIn(a, { ipAddress: '203.0.113.2' }))
        .sessionId;
      const sessionB = (await signIn(b, { ipAddress: '203.0.113.3' }))
        .sessionId;
      const password = await actorFor(personId);

      // Removing A from a password session ends every passkey session of the
      // person (the actor's own is not one), and the password session stays.
      const result = await service.removePasskey({
        actor: password,
        passkeyId: passkeyA.id,
        ipAddress: IP,
      });
      expect(result.endedCurrentSession).toBe(false);
      expect(result.revokedSessions).toBeGreaterThanOrEqual(3);
      for (const id of [sessionA1, sessionA2, sessionB]) {
        expect(await sessions.findValidSession(id)).toBeNull();
      }
      expect(
        await sessions.findValidSession(password.sessionId),
      ).not.toBeNull();
      expect(await passkeys.get(passkeyA.id)).toBeNull();
      expect(await passkeys.get(passkeyB.id)).not.toBeNull();
    });

    it('ends the current session only when it was signed in with the removed passkey', async () => {
      const a = newAuthenticator();
      const b = newAuthenticator();
      const setup = await actorFor(personId);
      const { passkey: passkeyA } = await register(a, setup, 'A');
      const { passkey: passkeyB } = await register(b, setup, 'B');

      // Signed in with A, removing B: the current session survives.
      const viaA = await signIn(a, { ipAddress: '203.0.113.1' });
      const actorViaA = (await sessionService.loadSessionContext(
        viaA.sessionId,
      )) as SessionContext;
      const keep = await service.removePasskey({
        actor: actorViaA,
        passkeyId: passkeyB.id,
      });
      expect(keep.endedCurrentSession).toBe(false);
      expect(await sessions.findValidSession(viaA.sessionId)).not.toBeNull();

      // Signed in with A, removing A: the current session ends too.
      const end = await service.removePasskey({
        actor: actorViaA,
        passkeyId: passkeyA.id,
      });
      expect(end.endedCurrentSession).toBe(true);
      expect(end.revokedSessions).toBeGreaterThanOrEqual(1);
      expect(await sessions.findValidSession(viaA.sessionId)).toBeNull();
      expect(await passkeys.countByUserId(personId)).toBe(0);
    });

    it("needs a fresh session to remove one's own passkey", async () => {
      const { passkey } = await register(
        newAuthenticator(),
        await actorFor(personId),
      );
      await expect(
        service.removePasskey({
          actor: await actorFor(personId, { ageSeconds: 3600 }),
          passkeyId: passkey.id,
        }),
      ).rejects.toBeInstanceOf(PasskeyReauthenticationRequiredError);
      expect(await passkeys.countByUserId(personId)).toBe(1);
    });

    it('refuses to remove a passkey that belongs to someone else without authority', async () => {
      const { passkey } = await register(
        newAuthenticator(),
        await actorFor(personId),
      );
      await expect(
        service.removePasskey({
          actor: await actorFor(adminId),
          passkeyId: passkey.id,
        }),
      ).rejects.toBeInstanceOf(PasskeyCredentialForbiddenError);
      await expect(
        service.removePasskey({
          actor: await actorFor(adminId),
          passkeyId: crypto.randomUUID(),
        }),
      ).rejects.toBeInstanceOf(PasskeyCredentialForbiddenError);
      expect(await passkeys.countByUserId(personId)).toBe(1);
    });

    it("lets an administrator remove a tenant member's passkey and ends all their passkey sessions", async () => {
      const a = newAuthenticator();
      const { passkey } = await register(a, await actorFor(personId));
      const signedIn = await signIn(a);
      const result = await service.removePasskey({
        actor: await adminActor(),
        passkeyId: passkey.id,
      });
      expect(result.endedCurrentSession).toBe(false);
      expect(result.revokedSessions).toBeGreaterThanOrEqual(1);
      expect(await sessions.findValidSession(signedIn.sessionId)).toBeNull();
      expect(await passkeys.countByUserId(personId)).toBe(0);
      await expect(
        signIn(a, { ipAddress: '203.0.113.7' }),
      ).rejects.toBeInstanceOf(PasskeyCredentialError);
    });

    it('confines an administrator to a single tenant', async () => {
      const away = await register(
        newAuthenticator(),
        await actorFor(outsiderId, { tenant: otherTenantId }),
      );
      await expect(
        service.removePasskey({
          actor: await adminActor(),
          passkeyId: away.passkey.id,
        }),
      ).rejects.toBeInstanceOf(PasskeyCredentialForbiddenError);
      // Shared across tenants: out of reach of both single-tenant admins.
      await addMember(outsiderId, tenantId);
      await expect(
        service.removePasskey({
          actor: await adminActor(),
          passkeyId: away.passkey.id,
        }),
      ).rejects.toBeInstanceOf(PasskeyCredentialForbiddenError);
      expect(await passkeys.countByUserId(outsiderId)).toBe(1);
    });

    it('refuses an administrator in a layered session', async () => {
      const { passkey } = await register(
        newAuthenticator(),
        await actorFor(personId),
      );
      const device = await actorFor(adminId, { authMethod: 'terminal' });
      const layered = await actorFor(adminId, {
        authMethod: 'pin',
        parentSessionId: device.sessionId,
        permissions: [DEFAULT_PASSKEY_MANAGE_PERMISSION],
      });
      await expect(
        service.removePasskey({ actor: layered, passkeyId: passkey.id }),
      ).rejects.toBeInstanceOf(PasskeyCredentialForbiddenError);
    });

    it('removeAllPasskeys is administrative recovery and never self-service', async () => {
      const setup = await actorFor(personId);
      const a = newAuthenticator();
      await register(a, setup);
      await register(newAuthenticator(), setup);
      const signedIn = await signIn(a);
      const keep = await actorFor(personId);

      await expect(
        service.removeAllPasskeys({ actor: setup, userId: personId }),
      ).rejects.toBeInstanceOf(PasskeyCredentialForbiddenError);
      const adminSelf = await adminActor();
      await expect(
        service.removeAllPasskeys({ actor: adminSelf, userId: adminId }),
      ).rejects.toBeInstanceOf(PasskeyCredentialForbiddenError);
      await expect(
        service.removeAllPasskeys({
          actor: adminSelf,
          userId: outsiderId,
        }),
      ).rejects.toBeInstanceOf(PasskeyCredentialForbiddenError);

      const result = await service.removeAllPasskeys({
        actor: adminSelf,
        userId: personId,
        ipAddress: IP,
      });
      expect(result.removed).toBe(2);
      expect(result.revokedSessions).toBeGreaterThanOrEqual(1);
      expect(await passkeys.countByUserId(personId)).toBe(0);
      expect(await sessions.findValidSession(signedIn.sessionId)).toBeNull();
      // Their other credentials' sessions are untouched, and they can enrol again.
      expect(await sessions.findValidSession(keep.sessionId)).not.toBeNull();
      await expect(
        register(newAuthenticator(), await actorFor(personId)),
      ).resolves.toBeTruthy();
    });

    it('hasPasskeys reflects what is registered', async () => {
      expect(await service.hasPasskeys(personId)).toBe(false);
      await register(newAuthenticator(), await actorFor(personId));
      expect(await service.hasPasskeys(personId)).toBe(true);
      expect(await service.hasPasskeys('not-a-uuid')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Audit
  // -------------------------------------------------------------------------

  it('records management events without key material', async () => {
    const authenticator = newAuthenticator();
    const actor = await actorFor(personId);
    const { passkey } = await register(authenticator, actor, 'Laptop');
    await service.renamePasskey({ actor, passkeyId: passkey.id, name: 'Work' });
    await service.removePasskey({
      actor,
      passkeyId: passkey.id,
      ipAddress: IP,
    });
    await service.removeAllPasskeys({
      actor: await adminActor(),
      userId: personId,
    });
    const managed = audit.filter((entry) => entry.outcome === 'managed');
    expect(managed.map((entry) => entry.metadata?.action)).toEqual([
      'register',
      'rename',
      'remove',
      'remove-all',
    ]);
    expect(managed.every((entry) => entry.kind === 'passkey')).toBe(true);
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain(authenticator.id);
    expect(serialized).not.toContain(passkey.name === 'Laptop' ? 'Work' : '');
    expect(serialized).not.toMatch(/publicKey|challenge/i);
    expect(managed[3]?.metadata).toMatchObject({
      actorId: adminId,
      self: false,
    });
  });

  describe('operational behaviour', () => {
    it('logs one warning, with no secret material, when challengeSecret is unset', async () => {
      const warn = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      try {
        await make({ challengeSecret: undefined });
        const output = [...warn.mock.calls, ...log.mock.calls]
          .flat()
          .map(String)
          .join('\n');
        expect(output).toMatch(/challengeSecret/);
        expect(output).not.toContain(SECRET);
      } finally {
        warn.mockRestore();
        log.mockRestore();
      }
    });

    it('settles the lease before revoking the presented session, and keeps the new session if that revocation fails', async () => {
      const authenticator = await enrolled();
      const planted = await sessionService.createSession(personId, tenantId, {
        authMethod: 'password',
      });
      const internal = service as unknown as { sessionService: SessionService };
      const order: string[] = [];
      const original = internal.sessionService.destroySession.bind(
        internal.sessionService,
      );
      vi.spyOn(internal.sessionService, 'destroySession').mockImplementation(
        async (id: string) => {
          order.push(`destroy:${id === planted ? 'planted' : 'other'}`);
          if (id === planted) throw new Error('boom');
          return original(id);
        },
      );
      const result = await signIn(authenticator, { replaceSessionId: planted });
      expect(audit.map((entry) => entry.outcome)).toEqual(['succeeded']);
      expect(order).toEqual(['destroy:planted']);
      expect(await sessions.findValidSession(result.sessionId)).not.toBeNull();
    });
  });
});
