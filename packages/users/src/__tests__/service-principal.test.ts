/**
 * Non-login service principals (#5245): creation, idempotency, permanent
 * retirement, tenant binding, and session refusal on every smrt-users path.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  AGENT_PROFILE_TYPE_SLUG,
  ProfileCollection,
  ProfileTypeCollection,
} from '@happyvertical/smrt-profiles';
import { withSystemContext } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UsersCliAuthRequestCollection } from '../collections/CliAuthRequestCollection.js';
import { MembershipCollection } from '../collections/MembershipCollection.js';
import { RoleCollection } from '../collections/RoleCollection.js';
import { SessionCollection } from '../collections/SessionCollection.js';
import { TenantCollection } from '../collections/TenantCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import { ServicePrincipalError } from '../models/User.js';
import { ServicePrincipalService } from '../services/ServicePrincipalService.js';
import { withPrincipalPermissionContext } from '../services/SessionPermissionContext.js';
import { SessionService } from '../services/SessionService.js';
import {
  TenantInvitationError,
  TenantInvitationService,
} from '../services/TenantInvitationService.js';
import { MembershipStatus, SessionStatus, UserStatus } from '../types/index.js';

describe('ServicePrincipalService (#5245)', () => {
  let db: DatabaseInterface;
  let tenantId: string;
  let otherTenantId: string;

  beforeEach(async () => {
    db = await getTestDatabase();
    const tenants = await TenantCollection.create({ db });
    await UserCollection.create({ db });
    await MembershipCollection.create({ db });
    await SessionCollection.create({ db });
    await ProfileCollection.create({ db });
    await ProfileTypeCollection.create({ db });
    await UsersCliAuthRequestCollection.create({ db });
    const roles = await RoleCollection.create({ db });
    await roles.seedSystemRoles({ seedPermissions: false });
    tenantId = (await tenants.create({ name: 'Home', slug: randomUUID() }))
      .id as string;
    otherTenantId = (
      await tenants.create({ name: 'Elsewhere', slug: randomUUID() })
    ).id as string;
  });
  afterEach(async () => {
    await db.close?.();
  });

  const service = () =>
    ServicePrincipalService.create({ db, transaction: 'caller' });
  const create = async (
    overrides: Partial<{
      tenantId: string;
      key: string;
      roleSlug: string;
    }> = {},
  ) =>
    await db.transaction(async (tx) =>
      (
        await ServicePrincipalService.create({ db: tx, transaction: 'caller' })
      ).createServicePrincipal({
        tenantId,
        key: 'credential-1',
        roleSlug: 'member',
        displayName: 'Sales agent',
        ...overrides,
      }),
    );
  const sessionService = async () => {
    const sessions = new SessionService({ db });
    await sessions.initialize();
    return sessions;
  };
  /**
   * A session row for `userId` written around createSession(), as raw SQL
   * would: mint one for a throwaway person, then repoint it.
   */
  const plantSession = async (userId: string, parentSessionId?: string) => {
    const carrier = await (await UserCollection.create({ db })).create({
      email: `${randomUUID()}@example.com`,
      status: UserStatus.ACTIVE,
    });
    const session = await (
      await SessionCollection.create({ db })
    ).createSession({
      userId: carrier.id as string,
      tenantId,
      authMethod: 'oidc',
      parentSessionId: parentSessionId ?? null,
    });
    await db.query(
      'UPDATE sessions SET user_id = ? WHERE id = ?',
      userId,
      session.id,
    );
    return session.id as string;
  };
  const person = async () => {
    const users = await UserCollection.create({ db });
    const user = await users.create({
      email: `${randomUUID()}@example.com`,
      status: UserStatus.ACTIVE,
    });
    const role = await (
      await RoleCollection.create({ db })
    ).findSystemRoleBySlug('member');
    await (await MembershipCollection.create({ db })).create({
      userId: user.id,
      tenantId,
      roleId: role?.id,
      status: MembershipStatus.ACTIVE,
    });
    return user.id as string;
  };

  describe('create', () => {
    it('creates an active, login-less principal with a tenant-scoped bot profile', async () => {
      const created = await create();
      expect(created).toMatchObject({
        tenantId,
        key: 'credential-1',
        status: 'active',
        retiredAt: null,
        created: true,
      });
      const user = await (await UserCollection.create({ db })).get({
        id: created.userId,
      });
      expect(user).toMatchObject({
        email: '',
        emailKey: null,
        username: null,
        usernameKey: null,
        status: UserStatus.ACTIVE,
        principalKind: 'service',
        servicePrincipalTenantId: tenantId,
        servicePrincipalKey: 'credential-1',
      });
      expect(user?.isServicePrincipal()).toBe(true);
      expect(user?.canHoldSession()).toBe(false);
      const profile = await withSystemContext(async () =>
        (await ProfileCollection.create({ db })).get({ id: created.profileId }),
      );
      expect(profile).toMatchObject({ tenantId, name: 'Sales agent' });
      expect(await profile?.getTypeSlug()).toBe(AGENT_PROFILE_TYPE_SLUG);
      const membership = await (await MembershipCollection.create({ db })).get({
        id: created.membershipId,
      });
      expect(membership).toMatchObject({
        userId: created.userId,
        tenantId,
        status: MembershipStatus.ACTIVE,
      });
      expect((await db.query('SELECT id FROM sessions')).rows).toHaveLength(0);
    });

    it('is idempotent per (tenant, key) and keys are tenant-local', async () => {
      const first = await create();
      const replay = await create();
      expect(replay).toEqual({ ...first, created: false });
      const second = await create({ key: 'credential-2' });
      expect(second.userId).not.toBe(first.userId);
      const elsewhere = await create({ tenantId: otherTenantId });
      expect(elsewhere.userId).not.toBe(first.userId);
      expect(elsewhere.tenantId).toBe(otherTenantId);
      await expect(create({ roleSlug: 'viewer' })).rejects.toThrow(
        'different role',
      );
    });

    it('refuses malformed input, unknown tenants and foreign roles', async () => {
      await expect(create({ key: '' })).rejects.toBeInstanceOf(
        ServicePrincipalError,
      );
      await expect(create({ key: ' padded ' })).rejects.toThrow('key');
      await expect(create({ key: 'x'.repeat(201) })).rejects.toThrow('key');
      await expect(create({ tenantId: randomUUID() })).rejects.toThrow(
        'tenant is unavailable',
      );
      await expect(create({ roleSlug: 'no-such-role' })).rejects.toThrow(
        'role is unavailable',
      );
      const foreignRole = await (await RoleCollection.create({ db })).create({
        name: 'Foreign',
        slug: 'foreign',
        tenantId: otherTenantId,
        isSystem: false,
      });
      await expect(
        db.transaction(async (tx) =>
          (
            await ServicePrincipalService.create({
              db: tx,
              transaction: 'caller',
            })
          ).createServicePrincipal({
            tenantId,
            key: 'foreign-role',
            roleId: foreignRole.id as string,
          }),
        ),
      ).rejects.toThrow('role is unavailable');
      await expect(
        ServicePrincipalService.create({ db } as never),
      ).rejects.toThrow('caller-owned');
    });

    it('rolls back every record when the caller transaction fails', async () => {
      await expect(
        db.transaction(async (tx) => {
          await (
            await ServicePrincipalService.create({
              db: tx,
              transaction: 'caller',
            })
          ).createServicePrincipal({
            tenantId,
            key: 'rolled-back',
            roleSlug: 'member',
          });
          throw new Error('caller failed');
        }),
      ).rejects.toThrow('caller failed');
      expect(
        await (await service()).findServicePrincipal({
          tenantId,
          key: 'rolled-back',
        }),
      ).toBeNull();
      expect(
        (
          await db.query(
            "SELECT id FROM users WHERE principal_kind = 'service'",
          )
        ).rows,
      ).toHaveLength(0);
    });
  });

  it('works from inside an unprivileged request principal (the host calling context)', async () => {
    const ownerId = await person();
    await withPrincipalPermissionContext(
      { db, userId: ownerId, tenantId },
      async (context) => {
        expect(context.permissions).toEqual([]);
        const created = await create();
        const principals = await service();
        expect(
          await principals.isActiveServicePrincipal({
            tenantId,
            userId: created.userId,
          }),
        ).toBe(true);
        // The owner's own session still mints; the principal's never does.
        const sessions = await sessionService();
        await expect(
          sessions.createSession(ownerId, tenantId),
        ).resolves.toBeTypeOf('string');
        await expect(
          sessions.createSession(created.userId, tenantId),
        ).rejects.toBeInstanceOf(ServicePrincipalError);
        expect(
          await principals.retireServicePrincipal({
            tenantId,
            userId: created.userId,
          }),
        ).toMatchObject({ status: 'retired' });
      },
    );
  });

  describe('validity and tenant isolation', () => {
    it('is valid only in its own tenant, never for a person', async () => {
      const created = await create();
      const principals = await service();
      expect(
        await principals.isActiveServicePrincipal({
          tenantId,
          userId: created.userId,
        }),
      ).toBe(true);
      expect(
        await principals.isActiveServicePrincipal({
          tenantId: otherTenantId,
          userId: created.userId,
        }),
      ).toBe(false);
      // A membership added in another tenant by any other path does not make
      // the principal valid there: validity is bound to its home tenant.
      const role = await (
        await RoleCollection.create({ db })
      ).findSystemRoleBySlug('member');
      await (await MembershipCollection.create({ db })).create({
        userId: created.userId,
        tenantId: otherTenantId,
        roleId: role?.id,
        status: MembershipStatus.ACTIVE,
      });
      expect(
        await principals.isActiveServicePrincipal({
          tenantId: otherTenantId,
          userId: created.userId,
        }),
      ).toBe(false);
      expect(
        await principals.getServicePrincipal({
          tenantId: otherTenantId,
          userId: created.userId,
        }),
      ).toBeNull();
      expect(
        await principals.listServicePrincipals({ tenantId: otherTenantId }),
      ).toEqual([]);
      const personId = await person();
      expect(
        await principals.isActiveServicePrincipal({
          tenantId,
          userId: personId,
        }),
      ).toBe(false);
      expect(
        await principals.retireServicePrincipal({ tenantId, userId: personId }),
      ).toBeNull();
      const personRow = await (await UserCollection.create({ db })).get({
        id: personId,
      });
      expect(personRow?.status).toBe(UserStatus.ACTIVE);
      for (const bad of [
        { tenantId: 'nope', userId: created.userId },
        { tenantId, userId: 'nope' },
        {} as never,
      ])
        expect(await principals.isActiveServicePrincipal(bad)).toBe(false);
    });

    it('is invalid while the user or membership is inactive', async () => {
      const created = await create();
      const principals = await service();
      await db.query(
        'UPDATE memberships SET status = ? WHERE id = ?',
        MembershipStatus.INACTIVE,
        created.membershipId,
      );
      expect(
        await principals.isActiveServicePrincipal({
          tenantId,
          userId: created.userId,
        }),
      ).toBe(false);
      expect(
        (
          await principals.getServicePrincipal({
            tenantId,
            userId: created.userId,
          })
        )?.status,
      ).toBe('inactive');
    });

    it('lists the tenant principals, retired only on request', async () => {
      const one = await create();
      const two = await create({ key: 'credential-2' });
      await create({ tenantId: otherTenantId, key: 'foreign' });
      const principals = await service();
      await principals.retireServicePrincipal({ tenantId, userId: two.userId });
      expect(
        (await principals.listServicePrincipals({ tenantId })).map(
          (record) => record.userId,
        ),
      ).toEqual([one.userId]);
      expect(
        (
          await principals.listServicePrincipals({
            tenantId,
            includeRetired: true,
          })
        )
          .map((record) => record.userId)
          .sort(),
      ).toEqual([one.userId, two.userId].sort());
    });
  });

  describe('retire', () => {
    it('is permanent: no reactivation, no key reuse, idempotent', async () => {
      const created = await create();
      const principals = await service();
      const retired = await principals.retireServicePrincipal({
        tenantId,
        userId: created.userId,
      });
      expect(retired).toMatchObject({ status: 'retired' });
      expect(retired?.retiredAt).toBeInstanceOf(Date);
      const again = await principals.retireServicePrincipal({
        tenantId,
        userId: created.userId,
      });
      expect(again?.retiredAt?.getTime()).toBe(retired?.retiredAt?.getTime());
      expect(
        await principals.retireServicePrincipal({
          tenantId: otherTenantId,
          userId: created.userId,
        }),
      ).toBeNull();

      const users = await UserCollection.create({ db });
      const user = await users.get({ id: created.userId }, { cache: false });
      expect(user?.status).toBe(UserStatus.SUSPENDED);
      const membership = await (await MembershipCollection.create({ db })).get(
        { id: created.membershipId },
        { cache: false },
      );
      expect(membership?.status).toBe(MembershipStatus.INACTIVE);

      // The model refuses any ORM save that reactivates it.
      if (!user) throw new Error('missing user');
      for (const status of [UserStatus.ACTIVE, UserStatus.PENDING]) {
        user.status = status;
        await expect(user.save()).rejects.toThrow('cannot be reactivated');
      }
      // Even a raw reactivation of both rows leaves it invalid.
      await db.query(
        'UPDATE users SET status = ? WHERE id = ?',
        UserStatus.ACTIVE,
        created.userId,
      );
      await db.query(
        'UPDATE memberships SET status = ? WHERE id = ?',
        MembershipStatus.ACTIVE,
        created.membershipId,
      );
      expect(
        await principals.isActiveServicePrincipal({
          tenantId,
          userId: created.userId,
        }),
      ).toBe(false);
      await expect(create()).rejects.toThrow('retired');
    });

    it('refuses a login identifier or a person carrying service fields', async () => {
      const created = await create();
      const users = await UserCollection.create({ db });
      const user = await users.get({ id: created.userId }, { cache: false });
      if (!user) throw new Error('missing user');
      user.email = 'agent@example.com';
      await expect(user.save()).rejects.toThrow('no email or username');
      user.email = '';
      user.username = 'agent';
      await expect(user.save()).rejects.toThrow('no email or username');
      const personRow = await users.get({ id: await person() });
      if (!personRow) throw new Error('missing person');
      personRow.servicePrincipalKey = 'smuggled';
      await expect(personRow.save()).rejects.toThrow(
        'Only a service principal',
      );
      personRow.servicePrincipalKey = null;
      personRow.principalKind = 'robot' as never;
      await expect(personRow.save()).rejects.toThrow('Unknown principal kind');
    });
  });

  describe('never resolves as a session', () => {
    it('refuses every mint: SessionService, SessionCollection, terminal approval, tenant switch target', async () => {
      const created = await create();
      const sessions = await sessionService();
      await expect(
        sessions.createSession(created.userId, tenantId, {
          authMethod: 'magic-link',
        }),
      ).rejects.toBeInstanceOf(ServicePrincipalError);
      await expect(
        (await SessionCollection.create({ db })).createSession({
          userId: created.userId,
          tenantId,
          authMethod: 'oidc',
        }),
      ).rejects.toThrow('never hold a session');
      await expect(
        (
          await UsersCliAuthRequestCollection.create({ db })
        ).approvePendingRequest({
          approvedBy: created.userId,
          sessionTtlSeconds: 60,
          tenantId,
          userCode: 'ABCD-EFGH',
          userId: created.userId,
        }),
      ).rejects.toBeInstanceOf(ServicePrincipalError);
      // A layered (PIN-style) child on a person's device session is a mint
      // too, and is refused for the principal.
      const personId = await person();
      const deviceSessionId = await sessions.createSession(personId, tenantId, {
        authMethod: 'terminal',
      });
      await expect(
        sessions.createSession(created.userId, tenantId, {
          authMethod: 'pin',
          parentSessionId: deviceSessionId,
        }),
      ).rejects.toBeInstanceOf(ServicePrincipalError);
      expect(
        (
          await db.query(
            'SELECT id FROM sessions WHERE user_id = ?',
            created.userId,
          )
        ).rows,
      ).toHaveLength(0);
    });

    it('a planted session row never validates or loads, alone or as a parent', async () => {
      const created = await create();
      const planted = await plantSession(created.userId);
      const collection = await SessionCollection.create({ db });
      expect(await collection.findValidSession(planted)).toBeNull();
      const sessions = await sessionService();
      expect(await sessions.loadSessionContext(planted)).toBeNull();
      expect(await sessions.hasPermission(planted, 'anything')).toBe(false);
      expect(
        (await sessions.switchTenant(planted, otherTenantId)).switched,
      ).toBe(false);
      // A person's layered session on a planted principal parent is dead too.
      const personId = await person();
      const child = await plantSession(personId, planted);
      expect(await sessions.loadSessionContext(child)).toBeNull();
      // Retirement revokes any planted row outright.
      await (await service()).retireServicePrincipal({
        tenantId,
        userId: created.userId,
      });
      const row = await db.query(
        'SELECT status FROM sessions WHERE id = ?',
        planted,
      );
      expect(row.rows[0]?.status).toBe(SessionStatus.REVOKED);
    });

    it('invitation issue, accept and mailbox paths refuse its membership', async () => {
      const created = await create();
      const invitations = await TenantInvitationService.create({
        db,
        transaction: 'caller',
        secret: 'x'.repeat(48),
      });
      await expect(
        invitations.issue({ membershipId: created.membershipId }),
      ).rejects.toBeInstanceOf(TenantInvitationError);
      await expect(
        invitations.accept({
          membershipId: created.membershipId,
          token: 'irrelevant',
          sessionId: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(TenantInvitationError);
      await expect(
        invitations.authenticateMailbox({
          membershipId: created.membershipId,
          invitationToken: 'irrelevant',
          token: 'irrelevant',
        }),
      ).rejects.toBeInstanceOf(TenantInvitationError);
    });

    it('people, including #5086 bot-profile agent users, still hold sessions', async () => {
      const sessions = await sessionService();
      const personId = await person();
      const personSession = await sessions.createSession(personId, tenantId);
      expect((await sessions.loadSessionContext(personSession))?.user.id).toBe(
        personId,
      );

      const types = await ProfileTypeCollection.create({ db });
      const bot = await withSystemContext(() =>
        types.getOrCreateGlobalBySlug(AGENT_PROFILE_TYPE_SLUG, {
          name: 'Bot',
        }),
      );
      const profiles = await ProfileCollection.create({ db });
      const botProfile = await withSystemContext(async () => {
        const profile = await profiles.create({
          tenantId,
          typeId: bot.id as string,
          slug: `agent-${randomUUID()}`,
          name: 'Login-capable agent',
        });
        await profile.save();
        return profile;
      });
      const agentUser = await (await UserCollection.create({ db })).create({
        email: 'agent-user@example.com',
        profileId: botProfile.id as string,
        status: UserStatus.ACTIVE,
      });
      const agentSession = await sessions.createSession(agentUser.id as string);
      expect((await sessions.loadSessionContext(agentSession))?.user.id).toBe(
        agentUser.id,
      );
    });
  });

  it('every session mint in the package funnels through SessionCollection.createSession', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== '__tests__') walk(path);
        } else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) {
          files.push(path);
        }
      }
    };
    walk(root);
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      if (/INSERT\s+INTO\s+(?:\$\{[^}]*\}|"?sessions"?)\b/i.test(source))
        if (/INSERT\s+INTO\s+"?sessions"?\b/i.test(source))
          offenders.push(`${file}: raw INSERT INTO sessions`);
      if (/new\s+Session\s*\(/.test(source) && !file.endsWith('Session.ts'))
        offenders.push(`${file}: new Session(`);
    }
    expect(offenders).toEqual([]);
    const collection = readFileSync(
      join(root, 'collections/SessionCollection.ts'),
      'utf8',
    );
    // The only generic create in the collection is the guarded mint.
    expect(collection.match(/\bthis\.create\(/g)).toHaveLength(1);
    expect(collection).toMatch(
      /async createSession\([^)]*\)[^{]*\{\s*if \(await this\.isSessionlessPrincipal\(options\.userId\)\)/,
    );
  });
});
