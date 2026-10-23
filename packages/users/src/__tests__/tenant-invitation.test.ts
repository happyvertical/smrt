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

  it('accepts one exact child membership through signed proof and refuses replay or another membership', async () => {
    const first = await prepare();
    const second = await prepare({ email: 'other@example.com' });
    const proof = await signed((service) =>
      service.issue({ membershipId: first.membershipId }),
    );
    await expect(
      signed((service) =>
        service.accept({
          membershipId: second.membershipId,
          token: proof.token,
        }),
      ),
    ).rejects.toMatchObject({ name: 'MagicLinkError' });
    await expect(
      signed((service) =>
        service.accept({
          membershipId: first.membershipId,
          token: proof.token,
          expectedUserId: randomUUID(),
        }),
      ),
    ).rejects.toMatchObject({ name: 'TenantInvitationError' });
    const accepted = await signed((service) =>
      service.accept({
        membershipId: first.membershipId,
        token: proof.token,
        expectedUserId: first.userId,
      }),
    );
    expect(accepted).toEqual({ ...first, tenantId, status: 'active' });
    await expect(
      signed((service) =>
        service.accept({
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
    const proof = await signed((service) =>
      service.issue({ membershipId: first.membershipId }),
    );
    await expect(
      signed(async (service) => {
        await service.accept({
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
    ).toMatchObject({ status: UserStatus.PENDING });
    expect(
      await memberships.get({ id: first.membershipId }, { cache: false }),
    ).toMatchObject({ status: MembershipStatus.PENDING });
    expect(
      (
        await signed((service) =>
          service.accept({
            membershipId: first.membershipId,
            token: proof.token,
          }),
        )
      ).status,
    ).toBe('active');
  });

  it('denies suspended identity and changed role binding without consuming valid proof', async () => {
    const first = await prepare();
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
          membershipId: first.membershipId,
          token: proof.token,
        }),
      ),
    ).rejects.toMatchObject({ name: 'TenantInvitationError' });
    user.status = UserStatus.PENDING;
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
            membershipId: first.membershipId,
            token: proof.token,
          }),
        )
      ).status,
    ).toBe('active');
  });

  it('rejects expired and malformed proof with no access change', async () => {
    const first = await prepare();
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
            membershipId: first.membershipId,
            token: proof.token,
          }),
        ),
      ).rejects.toMatchObject({ name: 'MagicLinkError' });
      await expect(
        signed((service) =>
          service.accept({
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
