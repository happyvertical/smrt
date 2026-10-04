/**
 * DeviceCredentialService and the LoginAttemptLimiter lockout path on
 * PostgreSQL (#3273, #3276): native UUID references, the guarded UPSERT with
 * lockout enabled, and session `data` controls (ceiling, absolute cap)
 * round-tripping through JSON.
 */

import { randomUUID } from 'node:crypto';
import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { MembershipCollection } from '../collections/MembershipCollection.js';
import { PermissionCollection } from '../collections/PermissionCollection.js';
import { RoleCollection } from '../collections/RoleCollection.js';
import { RolePermissionCollection } from '../collections/RolePermissionCollection.js';
import { SessionCollection } from '../collections/SessionCollection.js';
import { TenantCollection } from '../collections/TenantCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import {
  DEFAULT_PIN_MANAGE_PERMISSION,
  DeviceCredentialError,
  DeviceCredentialService,
} from '../services/DeviceCredentialService.js';
import { LoginRateLimitError } from '../services/LoginAttemptLimiter.js';
import {
  type SessionContext,
  SessionService,
} from '../services/SessionService.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

describePostgres('DeviceCredentialService on PostgreSQL', () => {
  let isolated: IsolatedTestDbResult | undefined;

  afterEach(async () => {
    await isolated?.cleanup();
    isolated = undefined;
  });

  it('layers ceilinged, single-occupant person sessions on a device and locks out wrong PINs', async () => {
    isolated = await createIsolatedTestDbFromManifest({
      includeObjects: [
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
        'UsersPinCredential',
        'UsersLoginAttempt',
        'UsersLoginAuditEvent',
      ],
    });
    if (isolated.config.type !== 'postgres') {
      throw new Error('Expected a PostgreSQL test database.');
    }
    const options = { db: isolated.db };
    const users = await UserCollection.create(options);
    const tenants = await TenantCollection.create(options);
    const roles = await RoleCollection.create(options);
    const permissions = await PermissionCollection.create(options);
    const rolePermissions = await RolePermissionCollection.create(options);
    const memberships = await MembershipCollection.create(options);
    const sessions = await SessionCollection.create(options);
    const sessionService = await SessionService.create(options);

    const tenant = await tenants.create({
      id: randomUUID(),
      name: 'Device PostgreSQL',
    });
    await tenant.save();
    const tenantId = tenant.id as string;

    const role = await roles.create({ id: randomUUID(), name: 'Foreman' });
    await role.save();
    for (const slug of ['jobs.read', 'jobs.approve']) {
      const permission = await permissions.create({
        id: randomUUID(),
        slug,
        name: slug,
      });
      await permission.save();
      await rolePermissions.addPermission(
        role.id as string,
        permission.id as string,
      );
    }

    const ids: Record<'device' | 'welder' | 'foreman', string> = {
      device: randomUUID(),
      welder: randomUUID(),
      foreman: randomUUID(),
    };
    for (const [name, id] of Object.entries(ids)) {
      const user = await users.create({
        id,
        email: `${name}-${id}@devices.example`,
      });
      await user.save();
      const membership = await memberships.create({
        id: randomUUID(),
        userId: id,
        tenantId,
        roleId: role.id as string,
      });
      await membership.save();
    }

    const deviceSession = await sessions.createSession({
      userId: ids.device,
      tenantId,
      ttl: 3600,
      authMethod: 'terminal',
    });
    const deviceToken = deviceSession.id as string;

    const service = await DeviceCredentialService.create({
      ...options,
      personIdleSeconds: 600,
      personMaxSeconds: 1200,
      pin: { pepper: 'test-pepper', scrypt: { N: 2 ** 10 } },
      limiter: { maxAttempts: 6, windowSeconds: 60 },
      assertEnrolledDevice: async (device) => device.user.id === ids.device,
      deviceCeiling: async () => ['jobs.read'],
    });
    const admin = {
      user: { id: randomUUID() } as never,
      membership: null,
      permissions: [DEFAULT_PIN_MANAGE_PERMISSION],
      tenantId,
      sessionId: 'admin-browser-session',
      authMethod: 'oidc',
      parent: null,
    } satisfies SessionContext;
    for (const userId of [ids.welder, ids.foreman]) {
      await service.setPin({ actor: admin, userId, pin: '2580' });
    }

    const welder = await service.signInWithPin({
      deviceToken,
      userId: ids.welder,
      pin: '2580',
    });
    const foreman = await service.signInWithPin({
      deviceToken,
      userId: ids.foreman,
      pin: '2580',
    });

    // Hand-over: the welder's session ended, the device session did not.
    expect(
      await sessionService.loadSessionContext(welder.sessionId),
    ).toBeNull();
    const context = await sessionService.loadSessionContext(foreman.sessionId);
    expect(context?.user.id).toBe(ids.foreman);
    expect(context?.parent).toEqual({
      sessionId: deviceToken,
      userId: ids.device,
      tenantId,
      authMethod: 'terminal',
    });
    // The person's own role, capped by the device ceiling.
    expect(context?.permissions).toEqual(['jobs.read']);
    expect(context?.permissionCeiling).toEqual(['jobs.read']);
    const stored = await sessions.get(foreman.sessionId);
    expect(stored?.getAbsoluteExpiry()?.toISOString()).toBe(
      foreman.absoluteExpiresAt,
    );
    expect(stored?.getIdleSeconds()).toBe(600);

    // A malformed id never reaches the native UUID predicate: it is the same
    // credential failure as an unknown user, not a 22P02 database error.
    for (const userId of ['not-a-uuid', "'; --", randomUUID()]) {
      await expect(
        service.signInWithPin({ deviceToken, userId, pin: '2580' }),
      ).rejects.toBeInstanceOf(DeviceCredentialError);
    }

    // Lockout through the shared budget, with lockout enabled: the three
    // refusals above and these three exhaust the device's budget of six.
    for (let i = 0; i < 3; i++) {
      await expect(
        service.signInWithPin({
          deviceToken,
          userId: ids.welder,
          pin: '1111',
        }),
      ).rejects.toBeInstanceOf(DeviceCredentialError);
    }
    await expect(
      service.signInWithPin({ deviceToken, userId: ids.welder, pin: '2580' }),
    ).rejects.toBeInstanceOf(LoginRateLimitError);
    // A refused sign-in never signs the current person out.
    expect(
      await sessionService.loadSessionContext(foreman.sessionId),
    ).not.toBeNull();
  });
});
