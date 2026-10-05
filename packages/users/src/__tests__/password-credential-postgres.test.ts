/**
 * PasswordCredentialService on PostgreSQL (#3274): native UUID references,
 * the guarded parameter-upgrade UPDATE, the lockout-enabled limiter path,
 * the must-change ceiling round-tripping through session JSON, the raw-id
 * session sweeps, and tenant confinement of administration.
 */

import { randomUUID } from 'node:crypto';
import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { MembershipCollection } from '../collections/MembershipCollection.js';
import { UsersPasswordCredentialCollection } from '../collections/PasswordCredentialCollection.js';
import { RoleCollection } from '../collections/RoleCollection.js';
import { TenantCollection } from '../collections/TenantCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import { parseScryptHash } from '../services/credential-hash.js';
import { LoginRateLimitError } from '../services/LoginAttemptLimiter.js';
import {
  DEFAULT_PASSWORD_MANAGE_PERMISSION,
  PasswordCredentialError,
  PasswordCredentialForbiddenError,
  PasswordCredentialService,
} from '../services/PasswordCredentialService.js';
import {
  type SessionContext,
  SessionService,
} from '../services/SessionService.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

describePostgres('PasswordCredentialService on PostgreSQL', () => {
  let isolated: IsolatedTestDbResult | undefined;

  afterEach(async () => {
    await isolated?.cleanup();
    isolated = undefined;
  });

  it('signs in, upgrades hashes, rotates, locks out, and confines administration', async () => {
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
        'UsersPasswordCredential',
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
    const memberships = await MembershipCollection.create(options);
    const credentials = await UsersPasswordCredentialCollection.create(options);
    const sessionService = await SessionService.create(options);

    const tenantIds: string[] = [];
    for (const name of ['Office', 'Elsewhere']) {
      const tenant = await tenants.create({ id: randomUUID(), name });
      await tenant.save();
      tenantIds.push(tenant.id as string);
    }
    const [tenantId, otherTenantId] = tenantIds;
    const role = await roles.create({ id: randomUUID(), name: 'Staff' });
    await role.save();

    const ids = {
      person: randomUUID(),
      admin: randomUUID(),
      outsider: randomUUID(),
    };
    for (const [name, id] of Object.entries(ids)) {
      const user = await users.create({ id, email: `${name}@office.example` });
      await user.save();
      const membership = await memberships.create({
        id: randomUUID(),
        userId: id,
        tenantId: name === 'outsider' ? otherTenantId : tenantId,
        roleId: role.id as string,
      });
      await membership.save();
    }
    const admin = {
      user: { id: ids.admin } as never,
      membership: null,
      permissions: [DEFAULT_PASSWORD_MANAGE_PERMISSION],
      tenantId,
      sessionId: randomUUID(),
      authMethod: 'oidc',
      parent: null,
    } satisfies SessionContext;

    // Written under weak parameters, upgraded by the next sign-in through
    // the guarded raw UPDATE.
    const weak = await PasswordCredentialService.create({
      ...options,
      password: { scrypt: { N: 2 ** 8 } },
      limiter: { audit: false },
    });
    await weak.setPassword({
      actor: admin,
      userId: ids.person,
      password: 'correct horse battery',
    });
    const service = await PasswordCredentialService.create({
      ...options,
      password: { scrypt: { N: 2 ** 10 } },
      limiter: { maxAttempts: 4, windowSeconds: 60 },
    });
    const first = await service.signIn({
      identifier: 'PERSON@office.example',
      password: 'correct horse battery',
      tenantId,
      ipAddress: '10.1.0.1',
    });
    const upgraded = await credentials.findByUserId(ids.person);
    expect(parseScryptHash(upgraded?.passwordHash as string)?.params.N).toBe(
      1024,
    );
    expect(upgraded?.version).toBe(1);
    expect(
      await credentials.replaceHashIfUnchanged(
        ids.person,
        'scrypt$stale',
        'scrypt$nope',
      ),
    ).toBe(false);

    // A change keeps the session it is made from and ends the rest.
    const second = await service.signIn({
      identifier: 'person@office.example',
      password: 'correct horse battery',
      tenantId,
    });
    const actor = await sessionService.loadSessionContext(first.sessionId);
    if (!actor) throw new Error('missing session');
    const changed = await service.changePassword({
      actor,
      currentPassword: 'correct horse battery',
      newPassword: 'a brand new secret',
    });
    expect(changed.revokedSessions).toBe(1);
    // The guarded change wrote a new generation through raw SQL.
    const rotated = await credentials.findByUserId(ids.person);
    expect(rotated?.version).toBe(2);
    expect(rotated?.mustChange).toBe(false);
    expect(rotated?.rotatedBy).toBe('self');
    expect(rotated?.rotatedAt).toBeInstanceOf(Date);
    // A write guarded on the superseded generation changes nothing.
    if (!upgraded) throw new Error('missing credential');
    expect(
      await credentials.replaceIfCurrent(upgraded, {
        passwordHash: 'scrypt$stale',
        rotatedAt: new Date(),
        rotatedBy: 'self',
      }),
    ).toBe(false);
    expect(await credentials.deleteIfCurrent(upgraded)).toBe(false);
    expect((await credentials.findByUserId(ids.person))?.passwordHash).toBe(
      rotated?.passwordHash,
    );
    expect(
      await sessionService.loadSessionContext(second.sessionId),
    ).toBeNull();
    expect(
      await sessionService.loadSessionContext(first.sessionId),
    ).not.toBeNull();

    // A reset ends every session and forces a change; the restricted
    // session's empty ceiling survives the JSON round trip.
    const reset = await service.resetPassword({
      actor: admin,
      userId: ids.person,
      password: 'temporary secret 1',
    });
    expect(reset.revokedSessions).toBe(1);
    const restricted = await service.signIn({
      identifier: 'person@office.example',
      password: 'temporary secret 1',
      tenantId,
    });
    expect(restricted.mustChange).toBe(true);
    const restrictedContext = await sessionService.loadSessionContext(
      restricted.sessionId,
    );
    expect(restrictedContext?.permissions).toEqual([]);
    expect(restrictedContext?.permissionCeiling).toEqual([]);

    // Administration stops at the admin's tenant.
    await expect(
      service.resetPassword({
        actor: admin,
        userId: ids.outsider,
        password: 'another long secret',
      }),
    ).rejects.toBeInstanceOf(PasswordCredentialForbiddenError);
    await expect(
      service.resetPassword({
        actor: admin,
        userId: 'not-a-uuid',
        password: 'another long secret',
      }),
    ).rejects.toBeInstanceOf(PasswordCredentialForbiddenError);

    // Unknown and wrong are the same failure, then the account locks.
    for (const [index, identifier] of [
      'nobody@office.example',
      'person@office.example',
      'person@office.example',
      'person@office.example',
      'person@office.example',
    ].entries()) {
      await expect(
        service.signIn({
          identifier,
          password: 'wrong horse battery',
          tenantId,
          ipAddress: `10.2.0.${index}`,
        }),
      ).rejects.toBeInstanceOf(PasswordCredentialError);
    }
    await expect(
      service.signIn({
        identifier: 'person@office.example',
        password: 'temporary secret 1',
        tenantId,
        ipAddress: '10.3.0.1',
      }),
    ).rejects.toBeInstanceOf(LoginRateLimitError);
  });
});
