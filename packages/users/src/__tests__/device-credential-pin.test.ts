/**
 * DeviceCredentialService + PIN (#3276) and the layered-session rules in
 * SessionService that it relies on.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MembershipCollection } from '../collections/MembershipCollection.js';
import { UsersPinCredentialCollection } from '../collections/PinCredentialCollection.js';
import { RoleCollection } from '../collections/RoleCollection.js';
import { SessionCollection } from '../collections/SessionCollection.js';
import { TenantCollection } from '../collections/TenantCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import { UsersPinCredential } from '../models/PinCredential.js';
import {
  DEFAULT_PIN_MANAGE_PERMISSION,
  DeviceCredentialError,
  DeviceCredentialForbiddenError,
  DeviceCredentialPolicyError,
  DeviceCredentialService,
  PIN_LOGIN_KIND,
} from '../services/DeviceCredentialService.js';
import { LoginRateLimitError } from '../services/LoginAttemptLimiter.js';
import {
  type SessionContext,
  SessionService,
} from '../services/SessionService.js';

describe('DeviceCredentialService (PIN on an enrolled device)', () => {
  let dbPath: string;
  let options: { db: { type: 'sqlite'; url: string } };
  let users: UserCollection;
  let sessions: SessionCollection;
  let sessionService: SessionService;
  let service: DeviceCredentialService;
  let tenantId: string;
  let otherTenantId: string;
  let deviceUserId: string;
  let personId: string;
  let adminId: string;
  let deviceToken: string;
  let activeDevices: Set<string>;

  /** An administrator's first-class (browser) session context. */
  const adminActor = (): SessionContext => ({
    user: { id: adminId } as never,
    membership: null,
    permissions: [DEFAULT_PIN_MANAGE_PERMISSION],
    tenantId,
    sessionId: 'admin-browser-session',
    authMethod: 'oidc',
    parent: null,
  });

  beforeEach(async () => {
    dbPath = join(
      tmpdir(),
      `smrt-device-pin-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
    );
    options = { db: { type: 'sqlite', url: dbPath } };
    users = await UserCollection.create(options);
    sessions = await SessionCollection.create(options);
    const tenants = await TenantCollection.create(options);
    const roles = await RoleCollection.create(options);
    const memberships = await MembershipCollection.create(options);

    const tenant = await tenants.create({ name: 'Shop Floor' });
    await tenant.save();
    tenantId = tenant.id as string;
    const otherTenant = await tenants.create({ name: 'Elsewhere' });
    await otherTenant.save();
    otherTenantId = otherTenant.id as string;
    const role = await roles.create({ name: 'Operator' });
    await role.save();

    const device = await users.create({ email: 'tablet-1@devices.example' });
    await device.save();
    deviceUserId = device.id as string;
    const person = await users.create({ email: 'pat@example.com' });
    await person.save();
    personId = person.id as string;
    const admin = await users.create({ email: 'admin@example.com' });
    await admin.save();
    adminId = admin.id as string;

    for (const userId of [deviceUserId, personId, adminId]) {
      const membership = await memberships.create({
        userId,
        tenantId,
        roleId: role.id as string,
      });
      await membership.save();
    }

    // The device's enrolled bearer session, as the terminal grant mints it.
    const deviceSession = await sessions.createSession({
      userId: deviceUserId,
      tenantId,
      ttl: 3600,
      authMethod: 'terminal',
    });
    deviceToken = deviceSession.id as string;
    activeDevices = new Set([deviceUserId]);

    sessionService = await SessionService.create(options);
    service = await DeviceCredentialService.create({
      ...options,
      personSessionTtlSeconds: 600,
      pin: { pepper: 'test-pepper', scrypt: { N: 2 ** 10 } },
      limiter: { maxAttempts: 3, windowSeconds: 60, audit: false },
      assertEnrolledDevice: async (device) =>
        activeDevices.has(device.user.id as string),
    });
    await service.setPin({
      actor: adminActor(),
      userId: personId,
      pin: '2580',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (existsSync(dbPath)) rmSync(dbPath, { force: true });
  });

  it('stores the credential in its own sensitive table, hashed with scrypt', async () => {
    expect(new UsersPinCredential().tableName).toBe('users_pin_credentials');
    const credentials = await UsersPinCredentialCollection.create(options);
    const stored = await credentials.findByUserId(personId);
    expect(stored?.pinHash.startsWith('scrypt$')).toBe(true);
    expect(stored?.pinHash).not.toContain('2580');
    expect(stored?.rotatedBy).toBe(adminId);
  });

  it('signs a person in on the device and layers the session on the device session', async () => {
    const result = await service.signInWithPin({
      deviceToken,
      userId: personId,
      pin: '2580',
      ipAddress: '10.0.0.5',
    });
    expect(result.userId).toBe(personId);
    expect(result.tenantId).toBe(tenantId);
    expect(result.authMethod).toBe(PIN_LOGIN_KIND);
    expect(result.mustReset).toBe(false);

    const context = await sessionService.loadSessionContext(result.sessionId);
    expect(context?.user.id).toBe(personId);
    expect(context?.authMethod).toBe('pin');
    expect(context?.parent).toEqual({
      sessionId: deviceToken,
      userId: deviceUserId,
      tenantId,
      authMethod: 'terminal',
    });
    // The device session itself is a first-class session.
    const device = await sessionService.loadSessionContext(deviceToken);
    expect(device?.parent).toBeNull();
    expect(device?.authMethod).toBe('terminal');
  });

  it('refuses a wrong PIN with the same error as an unknown user', async () => {
    await expect(
      service.signInWithPin({ deviceToken, userId: personId, pin: '0000' }),
    ).rejects.toBeInstanceOf(DeviceCredentialError);
    await expect(
      service.signInWithPin({
        deviceToken,
        userId: 'no-such-user',
        pin: '2580',
      }),
    ).rejects.toBeInstanceOf(DeviceCredentialError);
    expect(await sessions.findByUser(personId)).toHaveLength(0);
  });

  it('refuses any bearer that is not an enrolled device session', async () => {
    const browser = await sessions.createSession({
      userId: adminId,
      tenantId,
      authMethod: 'oidc',
    });
    const mobile = await sessions.createSession({
      userId: adminId,
      tenantId,
      authMethod: 'mobile',
    });
    const legacy = await sessions.createSession({ userId: adminId, tenantId });
    for (const token of [browser.id, mobile.id, legacy.id, 'garbage', '']) {
      await expect(
        service.signInWithPin({
          deviceToken: token as string,
          userId: personId,
          pin: '2580',
        }),
      ).rejects.toBeInstanceOf(DeviceCredentialError);
    }
    // ...including another person's layered session on the device.
    const first = await service.signInWithPin({
      deviceToken,
      userId: personId,
      pin: '2580',
    });
    await expect(
      service.signInWithPin({
        deviceToken: first.sessionId,
        userId: personId,
        pin: '2580',
      }),
    ).rejects.toBeInstanceOf(DeviceCredentialError);
  });

  it('refuses a device the host no longer considers enrolled', async () => {
    activeDevices.clear();
    await expect(
      service.signInWithPin({ deviceToken, userId: personId, pin: '2580' }),
    ).rejects.toBeInstanceOf(DeviceCredentialError);
  });

  it('never widens tenant scope: the person must belong to the device tenant', async () => {
    const otherDevice = await sessions.createSession({
      userId: deviceUserId,
      tenantId: otherTenantId,
      authMethod: 'terminal',
    });
    await expect(
      service.signInWithPin({
        deviceToken: otherDevice.id as string,
        userId: personId,
        pin: '2580',
      }),
    ).rejects.toBeInstanceOf(DeviceCredentialError);
  });

  it('locks the person out after repeated wrong PINs, then refuses even the right one', async () => {
    for (let i = 0; i < 3; i++) {
      await expect(
        service.signInWithPin({ deviceToken, userId: personId, pin: '1111' }),
      ).rejects.toBeInstanceOf(DeviceCredentialError);
    }
    await expect(
      service.signInWithPin({ deviceToken, userId: personId, pin: '2580' }),
    ).rejects.toBeInstanceOf(LoginRateLimitError);
  });

  it('locks a device out when several people fail on it', async () => {
    for (let i = 0; i < 3; i++) {
      await expect(
        service.signInWithPin({
          deviceToken,
          userId: `guess-${i}`,
          pin: '1111',
        }),
      ).rejects.toBeInstanceOf(DeviceCredentialError);
    }
    try {
      await service.signInWithPin({
        deviceToken,
        userId: personId,
        pin: '2580',
      });
      throw new Error('expected a rate limit');
    } catch (error) {
      expect(error).toBeInstanceOf(LoginRateLimitError);
      expect((error as LoginRateLimitError).retryAfterSeconds).toBeGreaterThan(
        0,
      );
    }
  });

  it('invalidates the person session as soon as the device session is revoked', async () => {
    const result = await service.signInWithPin({
      deviceToken,
      userId: personId,
      pin: '2580',
    });
    expect(
      await sessionService.loadSessionContext(result.sessionId),
    ).not.toBeNull();
    await sessionService.destroySession(deviceToken);
    expect(
      await sessionService.loadSessionContext(result.sessionId),
    ).toBeNull();
    // Children are tidied up, not merely orphaned.
    const stored = await sessions.get(result.sessionId);
    expect(stored?.status).toBe('revoked');
  });

  it('never rewrites the device session’s own expiry', async () => {
    const before = await sessions.get(deviceToken);
    const expiresBefore = new Date(before?.expiresAt as Date).getTime();
    await expect(
      service.signInWithPin({ deviceToken, userId: personId, pin: '1111' }),
    ).rejects.toBeInstanceOf(DeviceCredentialError);
    await service.signInWithPin({ deviceToken, userId: personId, pin: '2580' });
    const after = await sessions.get(deviceToken);
    // The device was enrolled with a one-hour TTL; the person TTL is ten
    // minutes. Neither a failed nor a successful PIN attempt may move it.
    expect(new Date(after?.expiresAt as Date).getTime()).toBe(expiresBefore);
  });

  it('signs out only the person, leaving the device session live', async () => {
    const result = await service.signInWithPin({
      deviceToken,
      userId: personId,
      pin: '2580',
    });
    expect(await service.signOut(result.sessionId)).toBe(true);
    expect(
      await sessionService.loadSessionContext(result.sessionId),
    ).toBeNull();
    expect(await sessionService.loadSessionContext(deviceToken)).not.toBeNull();
    // Signing out with the device token through this API is a no-op.
    expect(await service.signOut(deviceToken)).toBe(false);
    expect(await sessionService.loadSessionContext(deviceToken)).not.toBeNull();
  });

  it('keeps a layered session inside the device tenant on tenant switch', async () => {
    const memberships = await MembershipCollection.create(options);
    const roles = await RoleCollection.create(options);
    const role = await roles.create({ name: 'Elsewhere role' });
    await role.save();
    const membership = await memberships.create({
      userId: personId,
      tenantId: otherTenantId,
      roleId: role.id as string,
    });
    await membership.save();

    const result = await service.signInWithPin({
      deviceToken,
      userId: personId,
      pin: '2580',
    });
    const switched = await sessionService.switchTenant(
      result.sessionId,
      otherTenantId,
    );
    expect(switched.switched).toBe(false);
    expect(
      await sessionService.loadSessionContext(result.sessionId),
    ).not.toBeNull();
  });

  it('enforces PIN policy', async () => {
    for (const pin of ['12', '123456789', 'abcd', '0000', '1234', '9876']) {
      await expect(
        service.setPin({ actor: adminActor(), userId: personId, pin }),
      ).rejects.toBeInstanceOf(DeviceCredentialPolicyError);
    }
  });

  it('lets a person change their own PIN from a PIN session only with the current PIN', async () => {
    const signedIn = await service.signInWithPin({
      deviceToken,
      userId: personId,
      pin: '2580',
    });
    const actor = (await sessionService.loadSessionContext(
      signedIn.sessionId,
    )) as SessionContext;

    await expect(
      service.setPin({ actor, userId: personId, pin: '1357' }),
    ).rejects.toBeInstanceOf(DeviceCredentialForbiddenError);
    await expect(
      service.setPin({
        actor,
        userId: personId,
        pin: '1357',
        currentPin: '9999',
      }),
    ).rejects.toBeInstanceOf(DeviceCredentialError);
    await service.setPin({
      actor,
      userId: personId,
      pin: '1357',
      currentPin: '2580',
    });
    await expect(
      service.signInWithPin({ deviceToken, userId: personId, pin: '2580' }),
    ).rejects.toBeInstanceOf(DeviceCredentialError);
    const again = await service.signInWithPin({
      deviceToken,
      userId: personId,
      pin: '1357',
    });
    expect(again.userId).toBe(personId);
  });

  it('never lets a PIN session administer PINs, whatever permissions it holds', async () => {
    const signedIn = await service.signInWithPin({
      deviceToken,
      userId: personId,
      pin: '2580',
    });
    const actor = {
      ...((await sessionService.loadSessionContext(
        signedIn.sessionId,
      )) as SessionContext),
      permissions: [DEFAULT_PIN_MANAGE_PERMISSION],
    };
    await expect(
      service.setPin({ actor, userId: adminId, pin: '1357' }),
    ).rejects.toBeInstanceOf(DeviceCredentialForbiddenError);
    await expect(
      service.resetPin({ actor, userId: adminId, pin: '1357' }),
    ).rejects.toBeInstanceOf(DeviceCredentialForbiddenError);
    await expect(
      service.clearPin({ actor, userId: personId }),
    ).rejects.toBeInstanceOf(DeviceCredentialForbiddenError);
  });

  it('requires the manage permission to touch someone else’s PIN', async () => {
    const actor = { ...adminActor(), permissions: [] };
    await expect(
      service.setPin({ actor, userId: personId, pin: '1357' }),
    ).rejects.toBeInstanceOf(DeviceCredentialForbiddenError);
  });

  it('admin reset forces a new PIN and revokes live PIN sessions', async () => {
    const live = await service.signInWithPin({
      deviceToken,
      userId: personId,
      pin: '2580',
    });
    const { revokedSessions } = await service.resetPin({
      actor: adminActor(),
      userId: personId,
      pin: '8642',
    });
    expect(revokedSessions).toBe(1);
    expect(await sessionService.loadSessionContext(live.sessionId)).toBeNull();
    expect(await sessionService.loadSessionContext(deviceToken)).not.toBeNull();

    const next = await service.signInWithPin({
      deviceToken,
      userId: personId,
      pin: '8642',
    });
    expect(next.mustReset).toBe(true);
    await service.setPin({
      actor: (await sessionService.loadSessionContext(
        next.sessionId,
      )) as SessionContext,
      userId: personId,
      pin: '7531',
      currentPin: '8642',
    });
    const after = await service.signInWithPin({
      deviceToken,
      userId: personId,
      pin: '7531',
    });
    expect(after.mustReset).toBe(false);
  });

  it('clearing a PIN removes the credential and revokes PIN sessions', async () => {
    const live = await service.signInWithPin({
      deviceToken,
      userId: personId,
      pin: '2580',
    });
    await service.clearPin({ actor: adminActor(), userId: personId });
    expect(await service.hasPin(personId)).toBe(false);
    expect(await sessionService.loadSessionContext(live.sessionId)).toBeNull();
    await expect(
      service.signInWithPin({ deviceToken, userId: personId, pin: '2580' }),
    ).rejects.toBeInstanceOf(DeviceCredentialError);
  });
});
