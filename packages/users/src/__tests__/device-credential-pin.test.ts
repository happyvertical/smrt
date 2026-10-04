/**
 * DeviceCredentialService + PIN (#3276) and the layered-session rules in
 * SessionService that it relies on.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MembershipCollection } from '../collections/MembershipCollection.js';
import { PermissionCollection } from '../collections/PermissionCollection.js';
import { UsersPinCredentialCollection } from '../collections/PinCredentialCollection.js';
import { RoleCollection } from '../collections/RoleCollection.js';
import { RolePermissionCollection } from '../collections/RolePermissionCollection.js';
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
  type DeviceCredentialServiceOptions,
  PIN_LOGIN_KIND,
} from '../services/DeviceCredentialService.js';
import { LoginRateLimitError } from '../services/LoginAttemptLimiter.js';
import {
  assertOperationPermission,
  OperationPermissionError,
} from '../services/OperationPermissionService.js';
import { withSessionPermissionContext } from '../services/SessionPermissionContext.js';
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
      personIdleSeconds: 600,
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
    vi.useRealTimers();
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
    await expect(
      service.signInWithPin({
        deviceToken,
        userId: crypto.randomUUID(),
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
    // Signing out with the device token through this API is a no-op: it
    // neither ends the device session nor rewrites its expiry (one hour
    // here, against a ten-minute person idle timeout). Same for a browser
    // session presented to it.
    const browser = await sessions.createSession({
      userId: adminId,
      tenantId,
      ttl: 3600,
      authMethod: 'oidc',
    });
    for (const token of [deviceToken, browser.id as string]) {
      const before = await sessions.get(token);
      expect(await service.signOut(token)).toBe(false);
      const after = await sessions.get(token);
      expect(after?.status).toBe('active');
      expect(new Date(after?.expiresAt as Date).getTime()).toBe(
        new Date(before?.expiresAt as Date).getTime(),
      );
    }
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

  describe('person authority, device ceiling, and switching people (#3276 amendment)', () => {
    let welderId: string;
    let foremanId: string;

    const makeService = (
      extra: Partial<DeviceCredentialServiceOptions> = {},
    ): Promise<DeviceCredentialService> =>
      DeviceCredentialService.create({
        ...options,
        personIdleSeconds: 600,
        pin: { pepper: 'test-pepper', scrypt: { N: 2 ** 10 } },
        limiter: { maxAttempts: 3, windowSeconds: 60, audit: false },
        assertEnrolledDevice: async (device) =>
          activeDevices.has(device.user.id as string),
        ...extra,
      });

    const signIn = (svc: DeviceCredentialService, userId: string) =>
      svc.signInWithPin({ deviceToken, userId, pin: '2580' });

    const permissionsOf = async (sessionId: string): Promise<string[]> =>
      [
        ...((await sessionService.loadSessionContext(sessionId))?.permissions ??
          []),
      ].sort();

    beforeEach(async () => {
      const roles = await RoleCollection.create(options);
      const permissions = await PermissionCollection.create(options);
      const rolePermissions = await RolePermissionCollection.create(options);
      const memberships = await MembershipCollection.create(options);

      const permissionIds: Record<string, string> = {};
      for (const slug of [
        'jobs.read',
        'jobs.update',
        'jobs.approve',
        'devices.heartbeat',
      ]) {
        const permission = await permissions.create({ slug, name: slug });
        await permission.save();
        permissionIds[slug] = permission.id as string;
      }
      const grant = async (roleId: string, slugs: string[]) => {
        for (const slug of slugs) {
          await rolePermissions.addPermission(roleId, permissionIds[slug]);
        }
      };

      // The device account's own role: what the tablet itself may do.
      const deviceMembership = await memberships.findByUserAndTenant(
        deviceUserId,
        tenantId,
      );
      await grant(deviceMembership?.roleId as string, ['devices.heartbeat']);

      const welderRole = await roles.create({ name: 'Welder' });
      await welderRole.save();
      await grant(welderRole.id as string, ['jobs.read', 'jobs.update']);
      const foremanRole = await roles.create({ name: 'Foreman' });
      await foremanRole.save();
      await grant(foremanRole.id as string, [
        'jobs.read',
        'jobs.update',
        'jobs.approve',
      ]);

      const welder = await users.create({ email: 'welder@example.com' });
      await welder.save();
      welderId = welder.id as string;
      const foreman = await users.create({ email: 'foreman@example.com' });
      await foreman.save();
      foremanId = foreman.id as string;
      for (const [userId, roleId] of [
        [welderId, welderRole.id],
        [foremanId, foremanRole.id],
      ] as const) {
        const membership = await memberships.create({
          userId,
          tenantId,
          roleId: roleId as string,
        });
        await membership.save();
        await service.setPin({ actor: adminActor(), userId, pin: '2580' });
      }
    });

    it('gives each person their own authority, never the device account’s', async () => {
      const device = await permissionsOf(deviceToken);
      expect(device).toEqual(['devices.heartbeat']);

      const welder = await signIn(service, welderId);
      const welderPermissions = await permissionsOf(welder.sessionId);
      const foreman = await signIn(service, foremanId);
      const foremanPermissions = await permissionsOf(foreman.sessionId);

      expect(welderPermissions).toEqual(['jobs.read', 'jobs.update']);
      expect(foremanPermissions).toEqual([
        'jobs.approve',
        'jobs.read',
        'jobs.update',
      ]);
      expect(welderPermissions).not.toEqual(foremanPermissions);
      expect(welderPermissions).not.toEqual(device);
      expect(foremanPermissions).not.toEqual(device);
      // Both identities are on the resolved context.
      const context = await sessionService.loadSessionContext(
        foreman.sessionId,
      );
      expect(context?.user.id).toBe(foremanId);
      expect(context?.parent?.userId).toBe(deviceUserId);
    });

    it('intersects the person’s permissions with the device ceiling', async () => {
      const deviceCeiling = vi.fn(async () => [
        'jobs.read',
        'jobs.approve',
        'never.granted',
      ]);
      const svc = await makeService({ deviceCeiling });

      const foreman = await signIn(svc, foremanId);
      expect(deviceCeiling).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: deviceToken }),
      );
      expect(await permissionsOf(foreman.sessionId)).toEqual([
        'jobs.approve',
        'jobs.read',
      ]);
      const context = await sessionService.loadSessionContext(
        foreman.sessionId,
      );
      expect(context?.permissionCeiling).toEqual([
        'jobs.read',
        'jobs.approve',
        'never.granted',
      ]);

      // A ceiling only removes: it never grants what the person lacks.
      const welder = await signIn(svc, welderId);
      expect(await permissionsOf(welder.sessionId)).toEqual(['jobs.read']);
    });

    it('treats an empty ceiling as no permissions at all', async () => {
      const svc = await makeService({ deviceCeiling: async () => [] });
      const foreman = await signIn(svc, foremanId);
      const context = await sessionService.loadSessionContext(
        foreman.sessionId,
      );
      expect(context?.user.id).toBe(foremanId);
      expect(context?.permissions).toEqual([]);
      expect(context?.permissionCeiling).toEqual([]);
    });

    it('leaves permissions untouched without a ceiling', async () => {
      const svc = await makeService({ deviceCeiling: async () => null });
      const viaNullCeiling = await signIn(svc, foremanId);
      const context = await sessionService.loadSessionContext(
        viaNullCeiling.sessionId,
      );
      expect(context?.permissionCeiling).toBeNull();
      expect([...(context?.permissions ?? [])].sort()).toEqual([
        'jobs.approve',
        'jobs.read',
        'jobs.update',
      ]);
      const stored = await sessions.get(viaNullCeiling.sessionId);
      expect(stored?.data).not.toHaveProperty('permissionCeiling');

      const viaDefault = await signIn(service, foremanId);
      expect(await permissionsOf(viaDefault.sessionId)).toEqual([
        'jobs.approve',
        'jobs.read',
        'jobs.update',
      ]);
    });

    it('snapshots the ceiling at sign-in: a change applies at the next sign-in', async () => {
      let ceiling = ['jobs.read'];
      const svc = await makeService({
        deviceCeiling: async () => ceiling,
        singleOccupant: false,
      });
      const before = await signIn(svc, foremanId);
      ceiling = ['jobs.read', 'jobs.update'];
      expect(await permissionsOf(before.sessionId)).toEqual(['jobs.read']);
      const after = await signIn(svc, foremanId);
      expect(await permissionsOf(after.sessionId)).toEqual([
        'jobs.read',
        'jobs.update',
      ]);
    });

    it('refuses the sign-in without spending the budget when the ceiling hook fails', async () => {
      const svc = await makeService({
        deviceCeiling: async () => {
          throw new Error('policy store unavailable');
        },
      });
      for (let i = 0; i < 4; i++) {
        await expect(signIn(svc, foremanId)).rejects.toThrow(
          'policy store unavailable',
        );
      }
      expect(await sessions.findByUser(foremanId)).toHaveLength(0);
      const malformed = await makeService({
        deviceCeiling: (async () => 'jobs.read') as never,
      });
      await expect(signIn(malformed, foremanId)).rejects.toThrow(
        /array of permission slugs/u,
      );
      expect(await sessions.findByUser(foremanId)).toHaveLength(0);
    });

    it('suppresses super-admin bypass and system context under a ceiling', async () => {
      const svc = await makeService({
        deviceCeiling: async () => ['jobs.read'],
      });
      const ceilinged = await signIn(svc, foremanId);
      const underCeiling = await withSessionPermissionContext(
        {
          ...options,
          sessionId: ceilinged.sessionId,
          superAdminBypass: true,
          systemContext: true,
        },
        async (context) => ({
          superAdminBypass: context.superAdminBypass,
          systemContext: context.systemContext,
          permissions: context.permissions,
        }),
      );
      expect(underCeiling).toEqual({
        superAdminBypass: false,
        systemContext: false,
        permissions: ['jobs.read'],
      });

      // Without a ceiling the host's request is honoured as before.
      const plain = await signIn(service, foremanId);
      const unceilinged = await withSessionPermissionContext(
        { ...options, sessionId: plain.sessionId, superAdminBypass: true },
        async (context) => context.superAdminBypass,
      );
      expect(unceilinged).toBe(true);
    });

    it('ends the previous person’s session when the next one signs in', async () => {
      const welder = await signIn(service, welderId);
      expect(
        await sessionService.loadSessionContext(welder.sessionId),
      ).not.toBeNull();

      const foreman = await signIn(service, foremanId);
      expect(
        await sessionService.loadSessionContext(welder.sessionId),
      ).toBeNull();
      expect((await sessions.get(welder.sessionId))?.status).toBe('revoked');
      expect(
        (await sessionService.loadSessionContext(foreman.sessionId))?.user.id,
      ).toBe(foremanId);
      // The device session is untouched by the hand-over.
      expect(
        await sessionService.loadSessionContext(deviceToken),
      ).not.toBeNull();
      expect(await sessions.findChildren(deviceToken)).toHaveLength(1);
    });

    it('does not sign the current person out when the next sign-in fails', async () => {
      const welder = await signIn(service, welderId);
      await expect(
        service.signInWithPin({ deviceToken, userId: foremanId, pin: '1111' }),
      ).rejects.toBeInstanceOf(DeviceCredentialError);
      expect(
        await sessionService.loadSessionContext(welder.sessionId),
      ).not.toBeNull();
    });

    it('keeps several people signed in when singleOccupant is off', async () => {
      const svc = await makeService({ singleOccupant: false });
      const welder = await signIn(svc, welderId);
      const foreman = await signIn(svc, foremanId);
      expect(
        await sessionService.loadSessionContext(welder.sessionId),
      ).not.toBeNull();
      expect(
        await sessionService.loadSessionContext(foreman.sessionId),
      ).not.toBeNull();
    });

    it('slides the idle expiry on activity, whichever service resolves the session', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-03T12:00:00Z'));
      const signedIn = await signIn(service, welderId);
      expect(signedIn.expiresAt).toBe('2026-10-03T12:10:00.000Z');
      expect(signedIn.absoluteExpiresAt).toBeNull();

      // `sessionService` is a host-style service: 7-day TTL, no autoExtend.
      // The person session still slides by its own ten-minute idle timeout.
      vi.advanceTimersByTime(500_000);
      expect(
        await sessionService.loadSessionContext(signedIn.sessionId),
      ).not.toBeNull();
      vi.advanceTimersByTime(500_000); // 1000s after sign-in, 500s idle
      expect(
        await sessionService.loadSessionContext(signedIn.sessionId),
      ).not.toBeNull();
      const stored = await sessions.get(signedIn.sessionId);
      expect(new Date(stored?.expiresAt as Date).toISOString()).toBe(
        '2026-10-03T12:26:40.000Z',
      );

      vi.advanceTimersByTime(601_000); // idle for longer than the timeout
      expect(
        await sessionService.loadSessionContext(signedIn.sessionId),
      ).toBeNull();
      // The device session outlives the person's idle expiry.
      expect(
        await sessionService.loadSessionContext(deviceToken),
      ).not.toBeNull();
    });

    it('honours the absolute cap even with continuous activity', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-03T12:00:00Z'));
      const svc = await makeService({ personMaxSeconds: 1200 });
      const signedIn = await signIn(svc, welderId);
      expect(signedIn.expiresAt).toBe('2026-10-03T12:10:00.000Z');
      expect(signedIn.absoluteExpiresAt).toBe('2026-10-03T12:20:00.000Z');

      for (let i = 0; i < 2; i++) {
        vi.advanceTimersByTime(500_000);
        expect(
          await sessionService.loadSessionContext(signedIn.sessionId),
        ).not.toBeNull();
      }
      // Activity never pushes expiry past the cap.
      const stored = await sessions.get(signedIn.sessionId);
      expect(new Date(stored?.expiresAt as Date).toISOString()).toBe(
        '2026-10-03T12:20:00.000Z',
      );

      vi.advanceTimersByTime(201_000); // 1201s: active 201s ago, past the cap
      expect(
        await sessionService.loadSessionContext(signedIn.sessionId),
      ).toBeNull();
      expect(await svc.loadPersonSession(signedIn.sessionId)).toBeNull();
    });

    it('caps the first expiry when the absolute cap is shorter than the idle timeout', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-03T12:00:00Z'));
      const svc = await makeService({ personMaxSeconds: 300 });
      const signedIn = await signIn(svc, welderId);
      expect(signedIn.expiresAt).toBe('2026-10-03T12:05:00.000Z');
      vi.advanceTimersByTime(301_000);
      expect(
        await sessionService.loadSessionContext(signedIn.sessionId),
      ).toBeNull();
    });

    it('holds a temporary-PIN session to no authority until the PIN is changed', async () => {
      await service.resetPin({
        actor: adminActor(),
        userId: foremanId,
        pin: '8642',
      });
      const temporary = await service.signInWithPin({
        deviceToken,
        userId: foremanId,
        pin: '8642',
      });
      expect(temporary.mustReset).toBe(true);
      const restricted = (await sessionService.loadSessionContext(
        temporary.sessionId,
      )) as SessionContext;
      // The client cannot ignore the flag: the session has nothing to use.
      expect(restricted.permissions).toEqual([]);
      expect(restricted.permissionCeiling).toEqual([]);
      const bypass = await withSessionPermissionContext(
        { ...options, sessionId: temporary.sessionId, superAdminBypass: true },
        async (context) => context.superAdminBypass,
      );
      expect(bypass).toBe(false);

      await service.setPin({
        actor: restricted,
        userId: foremanId,
        pin: '7531',
        currentPin: '8642',
      });
      // Changing the PIN ends the restricted session...
      expect(
        await sessionService.loadSessionContext(temporary.sessionId),
      ).toBeNull();
      // ...and the next sign-in carries the person's own authority.
      const signedIn = await service.signInWithPin({
        deviceToken,
        userId: foremanId,
        pin: '7531',
      });
      expect(signedIn.mustReset).toBe(false);
      expect(await permissionsOf(signedIn.sessionId)).toEqual([
        'jobs.approve',
        'jobs.read',
        'jobs.update',
      ]);
    });

    it('fails a malformed stored ceiling closed instead of salvaging its valid slugs', async () => {
      const signedIn = await signIn(service, foremanId);
      for (const malformed of [['jobs.read', 42], 'jobs.read', { a: 1 }]) {
        await sessions.setSessionData(
          signedIn.sessionId,
          'permissionCeiling',
          malformed,
        );
        const context = await sessionService.loadSessionContext(
          signedIn.sessionId,
        );
        expect(context?.permissions).toEqual([]);
        expect(context?.permissionCeiling).toEqual([]);
      }
    });

    it('refuses a layered session minted outside its parent’s tenant', async () => {
      const memberships = await MembershipCollection.create(options);
      const welderHere = await memberships.findByUserAndTenant(
        welderId,
        tenantId,
      );
      const elsewhere = await memberships.create({
        userId: welderId,
        tenantId: otherTenantId,
        roleId: welderHere?.roleId as string,
      });
      await elsewhere.save();

      // The public mint API accepts both fields; the load must not.
      const crossTenant = await sessionService.createSession(
        welderId,
        otherTenantId,
        { authMethod: 'pin', parentSessionId: deviceToken },
      );
      expect(await sessionService.loadSessionContext(crossTenant)).toBeNull();

      const sameTenant = await sessionService.createSession(
        welderId,
        tenantId,
        { authMethod: 'pin', parentSessionId: deviceToken },
      );
      expect(
        (await sessionService.loadSessionContext(sameTenant))?.tenantId,
      ).toBe(tenantId);
    });

    it('keeps the raw subject out of self-service audit metadata', async () => {
      const record = vi.fn(async () => undefined);
      const svc = await makeService({
        limiter: { maxAttempts: 3, windowSeconds: 60, audit: { record } },
      });
      const signedIn = await signIn(svc, welderId);
      const actor = (await sessionService.loadSessionContext(
        signedIn.sessionId,
      )) as SessionContext;
      await svc.setPin({
        actor,
        userId: welderId,
        pin: '1357',
        currentPin: '2580',
      });
      const selfBrowser = { ...adminActor(), user: { id: welderId } as never };
      await svc.clearPin({ actor: selfBrowser, userId: welderId });
      await svc.setPin({ actor: adminActor(), userId: welderId, pin: '2468' });

      const managed = record.mock.calls
        .map(([entry]) => entry as { outcome: string; metadata?: object })
        .filter((entry) => entry.outcome === 'managed');
      expect(managed.map((entry) => entry.metadata)).toEqual([
        { action: 'set', self: true },
        { action: 'clear', self: true, revokedSessions: 1 },
        { action: 'set', self: false, actorId: adminId },
      ]);
      expect(JSON.stringify(record.mock.calls)).not.toContain(welderId);
    });

    it('never reveals the device bearer through a person session’s public serialization', async () => {
      const signedIn = await signIn(service, welderId);
      const stored = await sessions.get(signedIn.sessionId);
      expect(stored?.parentSessionId).toBe(deviceToken);
      expect(JSON.stringify(stored?.toPublicJSON())).not.toContain(deviceToken);
    });

    it('enforces the ceiling in the standard operation guard, not only in context.permissions', async () => {
      const catalog = {
        permissions: ['jobs.read', 'jobs.approve'].map((slug) => ({ slug })),
      } as never;
      const guard = (sessionId: string, action: string) =>
        withSessionPermissionContext({ ...options, sessionId }, () =>
          assertOperationPermission({
            ...options,
            catalog,
            collection: 'jobs',
            action,
          }),
        );

      const svc = await makeService({
        deviceCeiling: async () => ['jobs.read'],
        singleOccupant: false,
      });
      const ceilinged = await signIn(svc, foremanId);
      expect((await guard(ceilinged.sessionId, 'read')).allowed).toBe(true);
      // The foreman's role grants jobs.approve; the device does not.
      await expect(
        guard(ceilinged.sessionId, 'approve'),
      ).rejects.toBeInstanceOf(OperationPermissionError);
      // Naming the same principal explicitly does not step around it.
      await expect(
        withSessionPermissionContext(
          { ...options, sessionId: ceilinged.sessionId },
          () =>
            assertOperationPermission({
              ...options,
              catalog,
              collection: 'jobs',
              action: 'approve',
              userId: foremanId,
              tenantId,
            }),
        ),
      ).rejects.toBeInstanceOf(OperationPermissionError);

      // Nor does guarding a resource in another tenant, where the person
      // holds the permission through their own role.
      const memberships = await MembershipCollection.create(options);
      const here = await memberships.findByUserAndTenant(foremanId, tenantId);
      const elsewhere = await memberships.create({
        userId: foremanId,
        tenantId: otherTenantId,
        roleId: here?.roleId as string,
      });
      await elsewhere.save();
      await expect(
        withSessionPermissionContext(
          { ...options, sessionId: ceilinged.sessionId },
          () =>
            assertOperationPermission({
              ...options,
              catalog,
              collection: 'jobs',
              action: 'approve',
              tenantId: otherTenantId,
            }),
        ),
      ).rejects.toBeInstanceOf(OperationPermissionError);

      const plain = await signIn(
        await makeService({ singleOccupant: false }),
        foremanId,
      );
      expect((await guard(plain.sessionId, 'approve')).allowed).toBe(true);
    });

    it('limits PIN administration to people in the administrator’s own tenant', async () => {
      const outsider = await users.create({ email: 'outsider@example.com' });
      await outsider.save();
      const outsiderId = outsider.id as string;
      const memberships = await MembershipCollection.create(options);
      const here = await memberships.findByUserAndTenant(welderId, tenantId);
      const elsewhere = await memberships.create({
        userId: outsiderId,
        tenantId: otherTenantId,
        roleId: here?.roleId as string,
      });
      await elsewhere.save();
      const otherAdmin = { ...adminActor(), tenantId: otherTenantId };
      await service.setPin({
        actor: otherAdmin,
        userId: outsiderId,
        pin: '2580',
      });

      // A tenant-A admin holding users.pin.manage has no say over a
      // tenant-B-only user, an unknown user, or a malformed id.
      for (const userId of [outsiderId, crypto.randomUUID(), 'not-a-uuid']) {
        await expect(
          service.setPin({ actor: adminActor(), userId, pin: '1357' }),
        ).rejects.toBeInstanceOf(DeviceCredentialForbiddenError);
        await expect(
          service.resetPin({ actor: adminActor(), userId, pin: '1357' }),
        ).rejects.toBeInstanceOf(DeviceCredentialForbiddenError);
        await expect(
          service.clearPin({ actor: adminActor(), userId }),
        ).rejects.toBeInstanceOf(DeviceCredentialForbiddenError);
      }
      expect(await service.hasPin(outsiderId)).toBe(true);

      // The PIN is one per person across tenants, so someone who also
      // belongs to another tenant is out of a single tenant's admin reach:
      // otherwise this admin could set a PIN and use it on that tenant's
      // devices, or sign the person out there.
      const shared = await memberships.create({
        userId: welderId,
        tenantId: otherTenantId,
        roleId: here?.roleId as string,
      });
      await shared.save();
      const live = await signIn(service, welderId);
      await expect(
        service.setPin({ actor: adminActor(), userId: welderId, pin: '1357' }),
      ).rejects.toBeInstanceOf(DeviceCredentialForbiddenError);
      await expect(
        service.resetPin({
          actor: adminActor(),
          userId: welderId,
          pin: '1357',
        }),
      ).rejects.toBeInstanceOf(DeviceCredentialForbiddenError);
      await expect(
        service.clearPin({ actor: adminActor(), userId: welderId }),
      ).rejects.toBeInstanceOf(DeviceCredentialForbiddenError);
      expect(
        await sessionService.loadSessionContext(live.sessionId),
      ).not.toBeNull();
      // An administrator with no tenant context administers nobody.
      await expect(
        service.resetPin({
          actor: { ...adminActor(), tenantId: null },
          userId: welderId,
          pin: '1357',
        }),
      ).rejects.toBeInstanceOf(DeviceCredentialForbiddenError);
    });

    it.each([
      'reset',
      'clear',
    ] as const)('does not let an in-flight sign-in survive a concurrent PIN %s', async (operation) => {
      // The ceiling hook runs after the PIN verified and before the mint:
      // complete the rotation (write + revocation sweep) inside that gap.
      let svc: DeviceCredentialService;
      svc = await makeService({
        deviceCeiling: async () => {
          if (operation === 'reset') {
            await svc.resetPin({
              actor: adminActor(),
              userId: welderId,
              pin: '8642',
            });
          } else {
            await svc.clearPin({ actor: adminActor(), userId: welderId });
          }
          return null;
        },
      });
      await expect(signIn(svc, welderId)).rejects.toBeInstanceOf(
        DeviceCredentialError,
      );
      expect(await sessions.findByUser(welderId)).toHaveLength(0);
    });

    it('revokes every session under restrictive caller list bounds', async () => {
      const bounded = { defaultListLimit: 1, maxListLimit: 1 };
      const multi = await makeService({ ...bounded, singleOccupant: false });
      const first = await signIn(multi, welderId);
      const second = await signIn(multi, welderId);
      const third = await signIn(multi, foremanId);
      expect(
        (
          await multi.resetPin({
            actor: adminActor(),
            userId: welderId,
            pin: '8642',
          })
        ).revokedSessions,
      ).toBe(2);
      for (const { sessionId } of [first, second]) {
        expect(await sessionService.loadSessionContext(sessionId)).toBeNull();
      }

      // Hand-over ends every previous occupant, not just one page of them.
      const fourth = await signIn(multi, foremanId);
      const single = await makeService(bounded);
      const next = await signIn(single, foremanId);
      for (const { sessionId } of [third, fourth]) {
        expect(await sessionService.loadSessionContext(sessionId)).toBeNull();
      }
      expect(
        await sessionService.loadSessionContext(next.sessionId),
      ).not.toBeNull();
    });

    it('ends a person session once the host no longer considers the device enrolled', async () => {
      const signedIn = await signIn(service, welderId);
      expect(
        (await service.loadPersonSession(signedIn.sessionId))?.user.id,
      ).toBe(welderId);
      const before = await sessions.get(signedIn.sessionId);

      // Un-enrol in the host registry only; the device bearer is not revoked.
      activeDevices.clear();
      expect(await service.loadPersonSession(signedIn.sessionId)).toBeNull();
      const after = await sessions.get(signedIn.sessionId);
      expect(after?.status).toBe('revoked');
      expect(new Date(after?.expiresAt as Date).getTime()).toBe(
        new Date(before?.expiresAt as Date).getTime(),
      );
      activeDevices.add(deviceUserId);

      // A hook that throws (a registry outage) refuses the request but is
      // not un-enrolment: nothing is revoked, and the session works again.
      let outage = true;
      const flaky = await makeService({
        assertEnrolledDevice: async (device) => {
          if (outage) throw new Error('device registry unavailable');
          return activeDevices.has(device.user.id as string);
        },
      });
      outage = false;
      const survivor = await signIn(flaky, foremanId);
      outage = true;
      expect(await flaky.loadPersonSession(survivor.sessionId)).toBeNull();
      expect((await sessions.get(survivor.sessionId))?.status).toBe('active');
      outage = false;
      expect((await flaky.loadPersonSession(survivor.sessionId))?.user.id).toBe(
        foremanId,
      );

      // Not a person session at all: refused without touching anything.
      expect(await service.loadPersonSession(deviceToken)).toBeNull();
      expect(
        await sessionService.loadSessionContext(deviceToken),
      ).not.toBeNull();
    });

    it('ends sessions minted under the old PIN whenever the PIN changes', async () => {
      const multi = await makeService({ singleOccupant: false });
      const stale = await signIn(multi, welderId);
      const current = await signIn(multi, welderId);
      const actor = (await sessionService.loadSessionContext(
        current.sessionId,
      )) as SessionContext;

      // A person changing their own PIN keeps the session they did it from.
      await multi.setPin({
        actor,
        userId: welderId,
        pin: '1357',
        currentPin: '2580',
      });
      expect(
        await sessionService.loadSessionContext(stale.sessionId),
      ).toBeNull();
      expect(
        await sessionService.loadSessionContext(current.sessionId),
      ).not.toBeNull();

      // An administrator's change ends them all.
      await multi.setPin({
        actor: adminActor(),
        userId: welderId,
        pin: '2468',
      });
      expect(
        await sessionService.loadSessionContext(current.sessionId),
      ).toBeNull();
    });

    it('rejects non-positive idle and absolute lifetimes', () => {
      for (const extra of [
        { personIdleSeconds: 0 },
        { personMaxSeconds: -1 },
        { personIdleSeconds: Number.NaN },
      ]) {
        expect(
          () =>
            new DeviceCredentialService({
              ...options,
              assertEnrolledDevice: async () => true,
              ...extra,
            }),
        ).toThrow(/must be a positive number/u);
      }
    });
  });
});
