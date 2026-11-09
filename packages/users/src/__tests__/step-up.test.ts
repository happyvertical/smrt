/**
 * Step-up (#4841): `PasswordCredentialService.stepUp` stamps a server-side
 * recent-authentication time on the session and `requireRecentAuthentication`
 * decides on it. The stamp is not client input, is not extended by ordinary
 * session use, survives tenant-switch rotation unchanged and dies with the
 * session.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MembershipCollection } from '../collections/MembershipCollection.js';
import { RoleCollection } from '../collections/RoleCollection.js';
import { SessionCollection } from '../collections/SessionCollection.js';
import { TenantCollection } from '../collections/TenantCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import { SESSION_DATA_KEYS } from '../models/Session.js';
import {
  PasswordCredentialError,
  PasswordCredentialService,
} from '../services/PasswordCredentialService.js';
import {
  type SessionContext,
  SessionService,
} from '../services/SessionService.js';
import {
  DEFAULT_STEP_UP_MAX_AGE_SECONDS,
  isTenantOwnerSession,
  requireRecentAuthentication,
  STEP_UP_REQUIRED_CODE,
  StepUpRequiredError,
} from '../step-up.js';
import { DEFAULT_ROLES } from '../types/index.js';

const SCRYPT = { N: 2 ** 10, r: 8, p: 1 };
const PASSWORD = 'correct horse battery';

describe('step-up', () => {
  let dbPath: string;
  let options: { db: { type: 'sqlite'; url: string } };
  let sessions: SessionCollection;
  let sessionService: SessionService;
  let service: PasswordCredentialService;
  let tenantId: string;
  let otherTenantId: string;
  let ownerId: string;
  let otherId: string;

  const context = async (sessionId: string): Promise<SessionContext> => {
    const loaded = await sessionService.loadSessionContext(sessionId);
    if (!loaded) throw new Error('session did not load');
    return loaded;
  };

  /** A password sign-in session, then moved back in time. */
  const signIn = async (
    identifier = 'owner@example.com',
    tenant: string = tenantId,
  ) =>
    (
      await service.signIn({
        identifier,
        password: PASSWORD,
        tenantId: tenant,
        ipAddress: '198.51.100.1',
      })
    ).sessionId;

  const age = async (sessionId: string, seconds: number) => {
    const row = await sessions.get(sessionId);
    if (!row) throw new Error('missing session row');
    const back = new Date(Date.now() - seconds * 1000).toISOString();
    row.setData(SESSION_DATA_KEYS.authenticatedAt, back);
    if (row.data?.[SESSION_DATA_KEYS.reauthenticatedAt]) {
      row.setData(SESSION_DATA_KEYS.reauthenticatedAt, back);
    }
    await row.save();
  };

  beforeEach(async () => {
    dbPath = join(
      tmpdir(),
      `smrt-stepup-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
    );
    options = { db: { type: 'sqlite', url: dbPath } };
    const users = await UserCollection.create(options);
    sessions = await SessionCollection.create(options);
    const memberships = await MembershipCollection.create(options);
    const tenants = await TenantCollection.create(options);
    const roles = await RoleCollection.create(options);

    const tenant = await tenants.create({ name: 'Home' });
    await tenant.save();
    tenantId = tenant.id as string;
    const other = await tenants.create({ name: 'Elsewhere' });
    await other.save();
    otherTenantId = other.id as string;
    const role = await roles.create({ name: 'Staff' });
    await role.save();

    const addUser = async (email: string) => {
      const user = await users.create({ email });
      await user.save();
      for (const t of [tenantId, otherTenantId]) {
        const membership = await memberships.create({
          userId: user.id as string,
          tenantId: t,
          roleId: role.id as string,
        });
        await membership.save();
      }
      return user.id as string;
    };
    ownerId = await addUser('owner@example.com');
    otherId = await addUser('other@example.com');

    sessionService = await SessionService.create(options);
    service = await PasswordCredentialService.create({
      ...options,
      password: { scrypt: SCRYPT },
      limiter: { maxAttempts: 10, windowSeconds: 60 },
    });
    for (const id of [ownerId, otherId]) {
      await service.setPassword({
        actor: {
          user: { id } as never,
          membership: null,
          permissions: [],
          tenantId,
          sessionId: `browser-${id}`,
          authMethod: 'oidc',
          parent: null,
        },
        userId: id,
        password: PASSWORD,
      });
    }
  });

  afterEach(() => {
    if (existsSync(dbPath)) rmSync(dbPath, { force: true });
  });

  it('counts an interactive sign-in as a fresh authentication', async () => {
    const sessionId = await signIn();
    const ctx = await context(sessionId);
    expect(ctx.reauthenticatedAt).toBeInstanceOf(Date);
    expect(() => requireRecentAuthentication(ctx)).not.toThrow();
  });

  it('does not count a terminal, oidc, magic-link or device session as a fresh authentication', async () => {
    const terminal = await sessionService.createSession(ownerId, tenantId, {
      authMethod: 'terminal',
    });
    const oidc = await sessionService.createSession(ownerId, tenantId, {
      authMethod: 'oidc',
    });
    const magic = await sessionService.createSession(ownerId, tenantId, {
      authMethod: 'magic-link',
    });
    const none = await sessionService.createSession(ownerId, tenantId);
    for (const id of [terminal, oidc, magic, none]) {
      const ctx = await context(id);
      expect(ctx.reauthenticatedAt).toBeNull();
      expect(() => requireRecentAuthentication(ctx)).toThrow(
        StepUpRequiredError,
      );
    }
  });

  it('stepUp with the right password stamps the session and re-freshens a stale one', async () => {
    const sessionId = await signIn();
    await age(sessionId, 3600);
    const stale = await context(sessionId);
    expect(() => requireRecentAuthentication(stale)).toThrow(
      StepUpRequiredError,
    );

    const result = await service.stepUp({ sessionId, password: PASSWORD });
    expect(result.sessionId).toBe(sessionId);
    const fresh = await context(sessionId);
    expect(fresh.reauthenticatedAt?.toISOString()).toBe(
      result.reauthenticatedAt,
    );
    expect(() => requireRecentAuthentication(fresh)).not.toThrow();
  });

  it('a wrong password does not stamp, and every refusal is one error', async () => {
    const sessionId = await signIn();
    await age(sessionId, 3600);
    await expect(
      service.stepUp({ sessionId, password: 'not the password' }),
    ).rejects.toBeInstanceOf(PasswordCredentialError);
    await expect(
      service.stepUp({ sessionId: 'no-such-session', password: PASSWORD }),
    ).rejects.toBeInstanceOf(PasswordCredentialError);
    const ctx = await context(sessionId);
    expect(() => requireRecentAuthentication(ctx)).toThrow(StepUpRequiredError);
    const row = await sessions.get(sessionId);
    expect(row?.data?.[SESSION_DATA_KEYS.reauthenticatedAt]).toBeUndefined();
  });

  it('refuses a layered (PIN) session', async () => {
    const parent = await signIn();
    const child = await sessionService.createSession(ownerId, tenantId, {
      authMethod: 'pin',
      parentSessionId: parent,
    });
    await expect(
      service.stepUp({ sessionId: child, password: PASSWORD }),
    ).rejects.toBeInstanceOf(PasswordCredentialError);
  });

  it('is stale after maxAgeSeconds on an injectable clock, and the default is five minutes', async () => {
    expect(DEFAULT_STEP_UP_MAX_AGE_SECONDS).toBe(300);
    const sessionId = await signIn();
    const ctx = await context(sessionId);
    const at = ctx.reauthenticatedAt as Date;
    const clock = (seconds: number) => () =>
      new Date(at.getTime() + seconds * 1000);
    expect(() =>
      requireRecentAuthentication(ctx, { now: clock(299) }),
    ).not.toThrow();
    expect(() => requireRecentAuthentication(ctx, { now: clock(301) })).toThrow(
      StepUpRequiredError,
    );
    expect(() =>
      requireRecentAuthentication(ctx, { maxAgeSeconds: 60, now: clock(61) }),
    ).toThrow(StepUpRequiredError);
    expect(() =>
      requireRecentAuthentication(ctx, { maxAgeSeconds: 60, now: clock(59) }),
    ).not.toThrow();
  });

  it('fails closed on a missing, future, malformed, or unusable value', async () => {
    const sessionId = await signIn();
    const ctx = await context(sessionId);
    const at = ctx.reauthenticatedAt as Date;
    const fail = (c: Partial<SessionContext>, o = {}) =>
      expect(() =>
        requireRecentAuthentication({ ...ctx, ...c } as SessionContext, o),
      ).toThrow(StepUpRequiredError);
    fail({ reauthenticatedAt: null });
    fail({ reauthenticatedAt: undefined });
    fail({ reauthenticatedAt: new Date('nope') });
    fail({ reauthenticatedAt: new Date(at.getTime() + 3_600_000) });
    fail({}, { maxAgeSeconds: 0 });
    fail({}, { maxAgeSeconds: Number.NaN });
    fail({}, { maxAgeSeconds: 24 * 3600 });
    // A malformed stored stamp reads as null even with a fresh sign-in.
    const row = await sessions.get(sessionId);
    row?.setData(SESSION_DATA_KEYS.reauthenticatedAt, 'garbage');
    await row?.save();
    expect((await context(sessionId)).reauthenticatedAt).toBeNull();
  });

  it("rejects another session's or another user's timestamp", async () => {
    const mine = await signIn();
    const theirs = await signIn('other@example.com');
    const myCtx = await context(mine);
    const theirCtx = await context(theirs);
    expect(() =>
      requireRecentAuthentication(theirCtx, { expectedSessionId: mine }),
    ).toThrow(StepUpRequiredError);
    expect(() =>
      requireRecentAuthentication(theirCtx, { expectedUserId: ownerId }),
    ).toThrow(StepUpRequiredError);
    expect(() =>
      requireRecentAuthentication(myCtx, {
        expectedSessionId: mine,
        expectedUserId: ownerId,
      }),
    ).not.toThrow();
  });

  it('is not extendable by ordinary session refresh or use', async () => {
    const sessionId = await signIn();
    await service.stepUp({ sessionId, password: PASSWORD });
    const before = (await context(sessionId)).reauthenticatedAt;
    await new Promise((resolve) => setTimeout(resolve, 15));
    await sessionService.refreshSession(sessionId);
    await context(sessionId);
    await sessionService.setSessionData(sessionId, 'theme', 'dark');
    expect((await context(sessionId)).reauthenticatedAt).toEqual(before);
  });

  it('cannot be set through setSessionData', async () => {
    const sessionId = await signIn();
    await age(sessionId, 3600);
    expect(
      await sessionService.setSessionData(
        sessionId,
        SESSION_DATA_KEYS.reauthenticatedAt,
        new Date().toISOString(),
      ),
    ).toBe(false);
    const ctx = await context(sessionId);
    expect(() => requireRecentAuthentication(ctx)).toThrow(StepUpRequiredError);
  });

  it('carries the stamp through tenant-switch rotation without refreshing it', async () => {
    const sessionId = await signIn();
    await service.stepUp({ sessionId, password: PASSWORD });
    await age(sessionId, 3600);
    const row = await sessions.get(sessionId);
    row?.setData(
      SESSION_DATA_KEYS.reauthenticatedAt,
      row.data?.authenticatedAt,
    );
    await row?.save();
    const switched = await sessionService.switchTenant(
      sessionId,
      otherTenantId,
    );
    expect(switched.rotated).toBe(true);
    const ctx = await context(switched.sessionId as string);
    expect(() => requireRecentAuthentication(ctx)).toThrow(StepUpRequiredError);
  });

  it('dies with the session', async () => {
    const sessionId = await signIn();
    await service.stepUp({ sessionId, password: PASSWORD });
    await sessionService.destroySession(sessionId);
    expect(await sessionService.loadSessionContext(sessionId)).toBeNull();
    await expect(
      service.stepUp({ sessionId, password: PASSWORD }),
    ).rejects.toBeInstanceOf(PasswordCredentialError);
  });

  it('uses one stable, non-leaking error code', () => {
    const error = new StepUpRequiredError();
    expect(error.code).toBe(STEP_UP_REQUIRED_CODE);
    expect(error.code).toBe('step_up_required');
    expect(error.message).not.toMatch(/session|user|expired|password/i);
  });

  it('isTenantOwnerSession accepts only a first-class owner session', () => {
    const owner = DEFAULT_ROLES[0].id;
    const base = (extra: Partial<SessionContext> = {}) =>
      ({
        sessionId: 's',
        user: { id: 'u1' },
        tenantId: 't1',
        membership: {
          userId: 'u1',
          tenantId: 't1',
          roleId: owner,
          isActive: () => true,
        },
        authMethod: 'password',
        parent: null,
        permissionCeiling: null,
        tenantAuthorization: null,
        reauthenticatedAt: new Date(),
        ...extra,
      }) as unknown as SessionContext;
    expect(isTenantOwnerSession(base())).toBe(true);
    expect(isTenantOwnerSession(null)).toBe(false);
    expect(isTenantOwnerSession(undefined)).toBe(false);
    expect(isTenantOwnerSession(base({ membership: null }))).toBe(false);
    expect(
      isTenantOwnerSession(
        base({
          membership: {
            userId: 'u1',
            tenantId: 't1',
            roleId: DEFAULT_ROLES[2].id,
            isActive: () => true,
          } as never,
        }),
      ),
    ).toBe(false);
    expect(isTenantOwnerSession(base({ authMethod: 'terminal' }))).toBe(false);
    expect(isTenantOwnerSession(base({ authMethod: 'pin' }))).toBe(false);
    expect(
      isTenantOwnerSession(base({ parent: { sessionId: 'p' } as never })),
    ).toBe(false);
    expect(isTenantOwnerSession(base({ permissionCeiling: [] }))).toBe(false);
    expect(
      isTenantOwnerSession(
        base({
          tenantAuthorization: {
            membershipId: null,
            inheritedFromTenantId: 'root',
          },
        }),
      ),
    ).toBe(false);
  });
});
