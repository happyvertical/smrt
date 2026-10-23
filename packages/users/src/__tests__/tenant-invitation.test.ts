import { randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  backfillProfileEmailKeys,
  Person,
  ProfileCollection,
  ProfileTypeCollection,
} from '@happyvertical/smrt-profiles';
import { withSystemContext } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MembershipCollection } from '../collections/MembershipCollection.js';
import { RoleCollection } from '../collections/RoleCollection.js';
import { SessionCollection } from '../collections/SessionCollection.js';
import { TenantCollection } from '../collections/TenantCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import { backfillUserEmailKeys } from '../migrations/backfillUserEmailKeys.js';
import { TenantInvitationService } from '../services/TenantInvitationService.js';
import { MembershipStatus, UserStatus } from '../types/index.js';

describe('TenantInvitationService', () => {
  let db: DatabaseInterface;
  let tenantId: string;
  beforeEach(async () => {
    db = await getTestDatabase();
    const tenants = await TenantCollection.create({ db });
    await UserCollection.create({ db });
    await MembershipCollection.create({ db });
    await ProfileCollection.create({ db });
    const roles = await RoleCollection.create({ db });
    await roles.seedSystemRoles({ seedPermissions: false });
    tenantId = (
      await tenants.create({ name: 'Invitation target', slug: randomUUID() })
    ).id as string;
    await backfillProfileEmailKeys(db);
    await backfillUserEmailKeys(db);
  });
  afterEach(async () => {
    await db.close?.();
  });
  const input = () => ({
    tenantId,
    email: 'Prospect@Example.com',
    roleSlug: 'viewer',
  });
  async function prepare(overrides = {}) {
    return await db.transaction(async (tx) =>
      (
        await TenantInvitationService.create({ db: tx, transaction: 'caller' })
      ).prepare({ ...input(), ...overrides }),
    );
  }

  it('creates pending identity/membership, replays normalized email, and never creates login authority', async () => {
    const first = await prepare();
    expect(first.status).toBe('pending');
    expect(await prepare({ email: ' prospect@example.com ' })).toEqual(first);
    const users = await UserCollection.create({ db });
    expect(await users.get({ id: first.userId })).toMatchObject({
      status: UserStatus.PENDING,
      email: 'prospect@example.com',
      profileId: first.profileId,
    });
    const memberships = await MembershipCollection.create({ db });
    expect(await memberships.get({ id: first.membershipId })).toMatchObject({
      status: MembershipStatus.PENDING,
    });
    expect(
      (await db.query('SELECT id FROM oidc_identities')).rows,
    ).toHaveLength(0);
    expect((await db.query('SELECT id FROM sessions')).rows).toHaveLength(0);
  });

  it('preserves an existing active membership and identity; refuses inactive identity/membership', async () => {
    const first = await prepare();
    const users = await UserCollection.create({ db });
    const user = await users.get({ id: first.userId });
    if (!user) throw new Error('Fixture User is missing');
    user.status = UserStatus.ACTIVE;
    await user.save();
    const memberships = await MembershipCollection.create({ db });
    const membership = await memberships.get({ id: first.membershipId });
    if (!membership) throw new Error('Fixture Membership is missing');
    membership.status = MembershipStatus.ACTIVE;
    await membership.save();
    expect(await prepare()).toEqual({ ...first, status: 'active' });
    membership.status = MembershipStatus.INACTIVE;
    await membership.save();
    await expect(prepare()).rejects.toThrow('membership is unavailable');
    membership.status = MembershipStatus.PENDING;
    await membership.save();
    user.status = UserStatus.SUSPENDED;
    await user.save();
    await expect(prepare()).rejects.toThrow('user is unavailable');
  });

  it('refuses unowned same-email profiles without binding them', async () => {
    const types = await ProfileTypeCollection.create({ db });
    const type = await withSystemContext(() =>
      types.getOrCreateGlobalBySlug('person', { name: 'Person' }),
    );
    const person = new Person({
      db,
      tenantId: null,
      typeId: type.id as string,
      slug: randomUUID(),
      name: 'Existing unverified prospect',
      email: 'prospect@example.com',
    });
    await person.initialize();
    await person.save();
    await expect(prepare()).rejects.toThrow('explicit identity reconciliation');
    const users = await UserCollection.create({ db });
    expect(
      await users.list({ where: { email: 'prospect@example.com' } }),
    ).toHaveLength(0);
  });

  it('rolls back all newly prepared records with the host transaction', async () => {
    await expect(
      db.transaction(async (tx) => {
        const service = await TenantInvitationService.create({
          db: tx,
          transaction: 'caller',
        });
        await service.prepare(input());
        throw new Error('host rollback');
      }),
    ).rejects.toThrow('host rollback');
    const users = await UserCollection.create({ db });
    expect(
      await users.list({ where: { email: 'prospect@example.com' } }),
    ).toHaveLength(0);
    const profiles = await ProfileCollection.create({ db });
    expect(
      await profiles.findUniqueGlobalPersonByEmail('prospect@example.com'),
    ).toBeNull();
    expect((await prepare()).status).toBe('pending');
  });

  async function signed<T>(
    fn: (service: TenantInvitationService) => Promise<T>,
    tokenExpiry?: number,
  ) {
    return await db.transaction(async (tx) =>
      fn(
        await TenantInvitationService.create({
          db: tx,
          transaction: 'caller',
          secret: 'test-invitation-signing-secret',
          tokenExpiry,
        }),
      ),
    );
  }

  async function independentSession(userId: string, authMethod = 'oidc') {
    const users = await UserCollection.create({ db });
    const user = await users.get({ id: userId });
    if (!user) throw new Error('Missing fixture User');
    user.status = UserStatus.ACTIVE;
    await user.save();
    const sessions = await SessionCollection.create({ db });
    return (await sessions.createSession({ userId, authMethod })).id as string;
  }

  it('never lets a grant issuer impersonate an invitee or activate a pending identity', async () => {
    const invitee = await prepare();
    const issuer = await prepare({ email: 'issuer@example.com' });
    const sessionId = await independentSession(issuer.userId);
    const proof = await signed((service) =>
      service.issue({ membershipId: invitee.membershipId }),
    );
    for (const identity of ['', sessionId]) {
      await expect(
        signed((service) =>
          service.accept({
            membershipId: invitee.membershipId,
            token: proof.token,
            sessionId: identity,
          }),
        ),
      ).rejects.toMatchObject({ name: 'TenantInvitationError', status: 403 });
    }
    const users = await UserCollection.create({ db });
    expect(
      await users.get({ id: invitee.userId }, { cache: false }),
    ).toMatchObject({ status: UserStatus.PENDING });
    expect((await db.query('SELECT id FROM sessions')).rows).toHaveLength(1);
    const inviteeSession = await independentSession(invitee.userId);
    await expect(
      signed((service) =>
        service.accept({
          membershipId: invitee.membershipId,
          token: proof.token,
          sessionId,
        }),
      ),
    ).rejects.toMatchObject({ name: 'TenantInvitationError' });
    await signed((service) =>
      service.accept({
        membershipId: invitee.membershipId,
        token: proof.token,
        sessionId: inviteeSession,
      }),
    );
    expect((await db.query('SELECT id FROM sessions')).rows).toHaveLength(2);
  });

  it('requires protocol-verified exact OIDC email before activating pending identity', async () => {
    const first = await prepare();
    const proof = await signed((service) =>
      service.issue({ membershipId: first.membershipId }),
    );
    const users = await UserCollection.create({ db });
    const claims = {
      iss: 'https://idp.example.com',
      sub: 'verified-client',
      email: 'prospect@example.com',
      email_verified: true,
    };
    for (const invalid of [
      { ...claims, email_verified: undefined },
      { ...claims, email_verified: false },
      { ...claims, email: 'wrong@example.com' },
    ]) {
      await expect(
        db.transaction(async (tx) => {
          const service = await TenantInvitationService.create({
            db: tx,
            transaction: 'caller',
            secret: 'test-invitation-signing-secret',
          });
          return service.authorizeOidcOwner(
            { db: tx, claims: invalid, provider: 'test', users },
            { membershipId: first.membershipId, token: proof.token },
          );
        }),
      ).rejects.toMatchObject({ name: 'TenantInvitationError' });
    }
    const result = await users.getOrCreateFromOidc(claims, 'test', {
      authorizeProfileOwner: async (context) =>
        (
          await TenantInvitationService.create({
            db: context.db,
            transaction: 'caller',
            secret: 'test-invitation-signing-secret',
          })
        ).authorizeOidcOwner(context, {
          membershipId: first.membershipId,
          token: proof.token,
        }),
    });
    expect(result.user.id).toBe(first.userId);
    expect(result.user.status).toBe(UserStatus.ACTIVE);
    const memberships = await MembershipCollection.create({ db });
    expect(
      await memberships.get({ id: first.membershipId }, { cache: false }),
    ).toMatchObject({ status: MembershipStatus.ACTIVE });
    expect((await db.query('SELECT id FROM sessions')).rows).toHaveLength(0);
  });

  it.each([
    'terminal',
    'pin',
    'unknown',
  ])('refuses %s sessions even for the exact identity', async (authMethod) => {
    const first = await prepare();
    const sessionId = await independentSession(first.userId, authMethod);
    const proof = await signed((service) =>
      service.issue({ membershipId: first.membershipId }),
    );
    await expect(
      signed((service) =>
        service.accept({
          membershipId: first.membershipId,
          token: proof.token,
          sessionId,
        }),
      ),
    ).rejects.toMatchObject({ name: 'TenantInvitationError' });
  });

  it('refuses layered sessions and preserves their parent authority', async () => {
    const first = await prepare();
    const parentId = await independentSession(first.userId);
    const sessions = await SessionCollection.create({ db });
    const child = await sessions.createSession({
      userId: first.userId,
      authMethod: 'oidc',
      parentSessionId: parentId,
    });
    const proof = await signed((service) =>
      service.issue({ membershipId: first.membershipId }),
    );
    await expect(
      signed((service) =>
        service.accept({
          membershipId: first.membershipId,
          token: proof.token,
          sessionId: child.id as string,
        }),
      ),
    ).rejects.toMatchObject({ name: 'TenantInvitationError' });
    await signed((service) =>
      service.accept({
        membershipId: first.membershipId,
        token: proof.token,
        sessionId: parentId,
      }),
    );
  });

  it('refuses a permission-ceiling session without consuming the grant', async () => {
    const first = await prepare();
    const sessionId = await independentSession(first.userId);
    const sessions = await SessionCollection.create({ db });
    const session = await sessions.get({ id: sessionId });
    if (!session) throw new Error('Missing fixture Session');
    session.data = { permissionCeiling: [] };
    await session.save();
    const proof = await signed((service) =>
      service.issue({ membershipId: first.membershipId }),
    );
    await expect(
      signed((service) =>
        service.accept({
          membershipId: first.membershipId,
          token: proof.token,
          sessionId,
        }),
      ),
    ).rejects.toMatchObject({ name: 'TenantInvitationError' });
    session.data = {};
    await session.save();
    await signed((service) =>
      service.accept({
        membershipId: first.membershipId,
        token: proof.token,
        sessionId,
      }),
    );
  });

  it('rolls back OIDC identity activation and proof consumption with caller failure', async () => {
    const first = await prepare();
    const proof = await signed((service) =>
      service.issue({ membershipId: first.membershipId }),
    );
    const claims = {
      iss: 'https://idp.example.com',
      sub: 'rollback-client',
      email: 'prospect@example.com',
      email_verified: true,
    };
    await expect(
      db.transaction(async (tx) => {
        const users = await UserCollection.create({ db: tx });
        const service = await TenantInvitationService.create({
          db: tx,
          transaction: 'caller',
          secret: 'test-invitation-signing-secret',
        });
        await service.authorizeOidcOwner(
          { db: tx, claims, provider: 'test', users },
          { membershipId: first.membershipId, token: proof.token },
        );
        throw new Error('OIDC caller rollback');
      }),
    ).rejects.toThrow('OIDC caller rollback');
    const users = await UserCollection.create({ db });
    expect(
      await users.get({ id: first.userId }, { cache: false }),
    ).toMatchObject({ status: UserStatus.PENDING });
    await users.getOrCreateFromOidc(claims, 'test', {
      authorizeProfileOwner: async (context) =>
        (
          await TenantInvitationService.create({
            db: context.db,
            transaction: 'caller',
            secret: 'test-invitation-signing-secret',
          })
        ).authorizeOidcOwner(context, {
          membershipId: first.membershipId,
          token: proof.token,
        }),
    });
  });

  it('accepts one exact child membership through signed proof and refuses replay or another membership', async () => {
    const first = await prepare();
    const sessionId = await independentSession(first.userId);
    const second = await prepare({ email: 'other@example.com' });
    const proof = await signed((service) =>
      service.issue({ membershipId: first.membershipId }),
    );
    await expect(
      signed((service) =>
        service.accept({
          sessionId,
          membershipId: second.membershipId,
          token: proof.token,
        }),
      ),
    ).rejects.toMatchObject({ name: 'TenantInvitationError' });
    await expect(
      signed((service) =>
        service.accept({
          sessionId,
          membershipId: first.membershipId,
          token: proof.token,
          expectedUserId: randomUUID(),
        }),
      ),
    ).rejects.toMatchObject({ name: 'TenantInvitationError' });
    const accepted = await signed((service) =>
      service.accept({
        sessionId,
        membershipId: first.membershipId,
        token: proof.token,
        expectedUserId: first.userId,
      }),
    );
    expect(accepted).toEqual({ ...first, tenantId, status: 'active' });
    await expect(
      signed((service) =>
        service.accept({
          sessionId,
          membershipId: first.membershipId,
          token: proof.token,
        }),
      ),
    ).rejects.toMatchObject({ name: 'MagicLinkError' });
    const users = await UserCollection.create({ db });
    const memberships = await MembershipCollection.create({ db });
    expect(
      await users.get({ id: first.userId }, { cache: false }),
    ).toMatchObject({ status: UserStatus.ACTIVE });
    expect(
      await memberships.get({ id: second.membershipId }, { cache: false }),
    ).toMatchObject({ status: MembershipStatus.PENDING });
    expect(
      await users.get({ id: second.userId }, { cache: false }),
    ).toMatchObject({ status: UserStatus.PENDING });
  });

  it('rolls back nonce consumption and activation together when the host fails', async () => {
    const first = await prepare();
    const sessionId = await independentSession(first.userId);
    const proof = await signed((service) =>
      service.issue({ membershipId: first.membershipId }),
    );
    await expect(
      signed(async (service) => {
        await service.accept({
          sessionId,
          membershipId: first.membershipId,
          token: proof.token,
        });
        throw new Error('host failed after proof');
      }),
    ).rejects.toThrow('host failed after proof');
    const users = await UserCollection.create({ db });
    const memberships = await MembershipCollection.create({ db });
    expect(
      await users.get({ id: first.userId }, { cache: false }),
    ).toMatchObject({ status: UserStatus.ACTIVE });
    expect(
      await memberships.get({ id: first.membershipId }, { cache: false }),
    ).toMatchObject({ status: MembershipStatus.PENDING });
    expect(
      (
        await signed((service) =>
          service.accept({
            sessionId,
            membershipId: first.membershipId,
            token: proof.token,
          }),
        )
      ).status,
    ).toBe('active');
  });

  it('denies suspended identity and changed role binding without consuming valid proof', async () => {
    const first = await prepare();
    const sessionId = await independentSession(first.userId);
    const proof = await signed((service) =>
      service.issue({ membershipId: first.membershipId }),
    );
    const users = await UserCollection.create({ db });
    const user = await users.get({ id: first.userId });
    if (!user) throw new Error('Fixture User is missing');
    user.status = UserStatus.SUSPENDED;
    await user.save();
    await expect(
      signed((service) =>
        service.accept({
          sessionId,
          membershipId: first.membershipId,
          token: proof.token,
        }),
      ),
    ).rejects.toMatchObject({ name: 'TenantInvitationError' });
    user.status = UserStatus.ACTIVE;
    await user.save();
    const memberships = await MembershipCollection.create({ db });
    const membership = await memberships.get({ id: first.membershipId });
    if (!membership) throw new Error('Fixture Membership is missing');
    const originalRoleId = membership.roleId;
    const roles = await RoleCollection.create({ db });
    const adminRole = await roles.findSystemRoleBySlug('admin');
    if (!adminRole?.id) throw new Error('Fixture admin role is missing');
    membership.roleId = adminRole.id;
    await membership.save();
    await expect(
      signed((service) =>
        service.accept({
          sessionId,
          membershipId: first.membershipId,
          token: proof.token,
        }),
      ),
    ).rejects.toMatchObject({ name: 'MagicLinkError' });
    membership.roleId = originalRoleId;
    await membership.save();
    expect(
      (
        await signed((service) =>
          service.accept({
            sessionId,
            membershipId: first.membershipId,
            token: proof.token,
          }),
        )
      ).status,
    ).toBe('active');
  });

  it('rejects expired and malformed proof with no access change', async () => {
    const first = await prepare();
    const sessionId = await independentSession(first.userId);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const proof = await signed(
        (service) => service.issue({ membershipId: first.membershipId }),
        1,
      );
      vi.setSystemTime(Date.now() + 2000);
      await expect(
        signed((service) =>
          service.accept({
            sessionId,
            membershipId: first.membershipId,
            token: proof.token,
          }),
        ),
      ).rejects.toMatchObject({ name: 'MagicLinkError' });
      await expect(
        signed((service) =>
          service.accept({
            sessionId,
            membershipId: first.membershipId,
            token: 'malformed-proof',
          }),
        ),
      ).rejects.toMatchObject({ name: 'MagicLinkError' });
    } finally {
      vi.useRealTimers();
    }
    const memberships = await MembershipCollection.create({ db });
    expect(
      await memberships.get({ id: first.membershipId }, { cache: false }),
    ).toMatchObject({ status: MembershipStatus.PENDING });
  });

  it('refuses unknown tenant/role, malformed email and changed pending role', async () => {
    await expect(prepare({ tenantId: randomUUID() })).rejects.toThrow(
      'tenant is unavailable',
    );
    await expect(prepare({ roleSlug: 'unknown' })).rejects.toThrow(
      'role is unavailable',
    );
    await expect(prepare({ email: 'invalid' })).rejects.toThrow('Invalid');
    await prepare();
    await expect(prepare({ roleSlug: 'admin' })).rejects.toThrow(
      'role conflicts',
    );
  });
});
