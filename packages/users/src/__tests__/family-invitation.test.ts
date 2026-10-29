import { randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  backfillProfileEmailKeys,
  Person,
  ProfileCollection,
  ProfileRelationship,
  ProfileRelationshipCollection,
  ProfileRelationshipTypeCollection,
  ProfileTypeCollection,
} from '@happyvertical/smrt-profiles';
import { withSystemContext, withTenant } from '@happyvertical/smrt-tenancy';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MembershipCollection } from '../collections/MembershipCollection.js';
import { RoleCollection } from '../collections/RoleCollection.js';
import { SessionCollection } from '../collections/SessionCollection.js';
import { TenantCollection } from '../collections/TenantCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import { backfillUserEmailKeys } from '../migrations/backfillUserEmailKeys.js';
import { LoginAttemptLimiter } from '../services/LoginAttemptLimiter.js';
import type { MailboxAuthenticationDelivery } from '../services/MailboxAuthenticationService.js';
import { PasswordCredentialService } from '../services/PasswordCredentialService.js';
import { SessionService } from '../services/SessionService.js';
import {
  TenantInvitationService,
  type TenantInvitationServiceOptions,
} from '../services/TenantInvitationService.js';
import { MembershipStatus, UserStatus } from '../types/index.js';

const secret = 'family-invitation-test-independent-proof-secret';
type Mail = Parameters<MailboxAuthenticationDelivery>[0];
describe('family invitation exact role and preserved identity', () => {
  let db: DatabaseInterface;
  let admin: DatabaseInterface | undefined;
  let schema: string | undefined;
  let tenantId: string;
  let sourceId: string;
  let roleId: string;
  let userId: string;
  let profileId: string;
  let limiter: LoginAttemptLimiter;
  const email = 'guardian@example.com';
  beforeEach(async () => {
    if (process.env.TEST_DB_ADAPTER === 'postgres') {
      if (!process.env.DATABASE_URL)
        throw new Error('Explicit isolated DATABASE_URL required');
      admin = await getDatabase({
        type: 'postgres',
        url: process.env.DATABASE_URL,
        dbid: randomUUID(),
      });
      schema = `family_invite_${randomUUID().replaceAll('-', '')}`;
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const url = new URL(process.env.DATABASE_URL);
      url.searchParams.set('options', `-c search_path=${schema},public`);
      db = await getDatabase({
        type: 'postgres',
        url: url.toString(),
        dbid: randomUUID(),
      });
      await getTestDatabase({ db });
    } else db = await getTestDatabase();
    const tenants = await TenantCollection.create({ db });
    tenantId = (
      await tenants.create({ name: 'Destination', slug: randomUUID() })
    ).id as string;
    sourceId = (
      await tenants.create({ name: 'Original family', slug: randomUUID() })
    ).id as string;
    const roles = await RoleCollection.create({ db });
    await roles.seedSystemRoles({ seedPermissions: false });
    roleId = (
      await roles.create({ tenantId, slug: 'guardian', name: 'Guardian' })
    ).id as string;
    const sourceRole = await roles.create({
      tenantId: sourceId,
      slug: 'guardian',
      name: 'Guardian',
    });
    const types = await ProfileTypeCollection.create({ db });
    const personType = await withSystemContext(() =>
      types.getOrCreateGlobalBySlug('person', { name: 'Person' }),
    );
    const person = new Person({
      db,
      tenantId: sourceId,
      typeId: personType.id as string,
      slug: randomUUID(),
      email,
      name: 'Guardian',
    });
    await person.initialize();
    await person.save();
    profileId = person.id as string;
    const users = await UserCollection.create({ db });
    userId = (
      await users.create({ profileId, email, status: UserStatus.ACTIVE })
    ).id as string;
    await (await MembershipCollection.create({ db })).create({
      userId,
      tenantId: sourceId,
      roleId: sourceRole.id as string,
      status: MembershipStatus.ACTIVE,
    });
    await ProfileCollection.create({ db });
    await ProfileRelationshipCollection.create({ db });
    await ProfileRelationshipTypeCollection.create({ db });
    await backfillProfileEmailKeys(db);
    await backfillUserEmailKeys(db);
    limiter = await LoginAttemptLimiter.create({
      db,
      keyPepper: secret,
      // This lifecycle scenario intentionally makes more than five invalid-proof requests.
      maxAttempts: 20,
      audit: false,
    });
  });
  afterEach(async () => {
    await db.close?.();
    if (admin && schema)
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.close?.();
    admin = undefined;
    schema = undefined;
  });
  async function tx<T>(
    fn: (
      service: TenantInvitationService,
      executor: DatabaseInterface,
    ) => Promise<T>,
    policy: TenantInvitationServiceOptions['existingProfilePolicy'] = 'owned-person',
  ) {
    return db.transaction(async (executor) =>
      fn(
        await TenantInvitationService.create({
          db: executor,
          transaction: 'caller',
          secret,
          loginLimiter: limiter,
          existingProfilePolicy: policy,
        }),
        executor,
      ),
    );
  }
  const prepare = () =>
    tx((service) => service.prepare({ tenantId, email, roleId }));
  async function grant() {
    const prepared = await prepare();
    const issued = await tx((service) =>
      service.issue({ membershipId: prepared.membershipId }),
    );
    return { ...prepared, token: issued.token };
  }
  async function mail(grant: { membershipId: string; token: string }) {
    let result: Mail | undefined;
    await tx((service) =>
      service.requestMailboxAuthentication({
        ...grant,
        sourceKey: 'trusted-test-client',
        deliver: async (value) => {
          result = value;
        },
      }),
    );
    if (!result) throw new Error('No mailbox delivery');
    return result;
  }
  async function actor<T>(
    fn: () => Promise<T>,
    id = userId,
    family = tenantId,
  ) {
    return withTenant(
      { tenantId: family, userId: id, permissions: new Set() },
      fn,
    );
  }
  it('preserves existing family Person through tenant-role prepare and password-session acceptance', async () => {
    const sessions = await SessionService.create({ db });
    const initialSession = await sessions.createSession(userId, sourceId, {
      authMethod: 'magic-link',
    });
    const initialActor = await sessions.loadSessionContext(initialSession);
    if (!initialActor) throw new Error('No fixture actor');
    await (await PasswordCredentialService.create({ db })).setPassword({
      actor: initialActor,
      userId,
      password: 'Fixture-only-password-7834!',
    });
    const credentialBefore = await db.get('users_password_credentials', {
      user_id: userId,
    });
    const before = await db.get('users', { id: userId });
    const prepared = await grant();
    expect(prepared).toMatchObject({ userId, profileId, status: 'pending' });
    expect(await prepare()).toMatchObject({
      membershipId: prepared.membershipId,
      userId,
      profileId,
      status: 'pending',
    });
    const session = await (
      await SessionCollection.create({ db })
    ).createSession({ userId, tenantId: sourceId, authMethod: 'password' });
    await expect(
      tx((service) =>
        service.accept({
          membershipId: prepared.membershipId,
          token: prepared.token,
          sessionId: session.id as string,
          expectedUserId: userId,
        }),
      ),
    ).resolves.toMatchObject({ tenantId, userId, profileId, status: 'active' });
    expect(await db.get('users', { id: userId })).toEqual(before);
    expect(
      await db.get('users_password_credentials', { user_id: userId }),
    ).toEqual(credentialBefore);
    expect((await db.get('profiles', { id: profileId })).tenant_id).toBe(
      sourceId,
    );
    const users = await UserCollection.create({ db });
    await expect(
      actor(() => users.requireOwnedPersonForTenant(userId, tenantId)),
    ).resolves.toMatchObject({ id: profileId });
  });
  it('keeps global default strict and rejects foreign, missing and ambiguous role selectors', async () => {
    await expect(
      tx(
        (service) => service.prepare({ tenantId, email, roleId }),
        'canonical-global',
      ),
    ).rejects.toThrow();
    const roles = await RoleCollection.create({ db });
    const foreign = await roles.create({
      tenantId: sourceId,
      slug: 'foreign',
      name: 'Foreign',
    });
    for (const input of [
      { tenantId, email, roleId: foreign.id as string },
      { tenantId, email, roleId: randomUUID() },
      { tenantId, email, roleId, roleSlug: 'viewer' },
      { tenantId, email },
    ])
      await expect(
        tx((service) =>
          service.prepare(
            input as Parameters<TenantInvitationService['prepare']>[0],
          ),
        ),
      ).rejects.toThrow();
    await expect(
      tx((service) =>
        service.prepare({
          tenantId,
          email: 'new@example.com',
          roleSlug: 'viewer',
        }),
      ),
    ).resolves.toMatchObject({ status: 'pending' });
  });
  it('requires exact current actor and active destination before exposing preserved Person', async () => {
    const users = await UserCollection.create({ db });
    await expect(
      users.requireOwnedPersonForTenant(userId, tenantId),
    ).rejects.toThrow();
    await prepare();
    await expect(
      actor(() => users.requireOwnedPersonForTenant(userId, tenantId)),
    ).rejects.toThrow();
    const memberships = await MembershipCollection.create({ db });
    const membership = await memberships.findByUserAndTenant(userId, tenantId);
    if (!membership) throw new Error('No membership');
    membership.status = MembershipStatus.ACTIVE;
    await membership.save();
    await expect(
      actor(() => users.requireOwnedPersonForTenant(userId, tenantId)),
    ).resolves.toMatchObject({ id: profileId });
    await expect(
      actor(
        () => users.requireOwnedPersonForTenant(userId, tenantId),
        randomUUID(),
      ),
    ).rejects.toThrow();
    await expect(
      actor(() => users.requireOwnedPersonForTenant(userId, sourceId)),
    ).rejects.toThrow();
    await expect(
      withSystemContext(() =>
        users.requireOwnedPersonForTenant(userId, tenantId),
      ),
    ).rejects.toThrow();
  });
  it('refuses changed email, suspended identity, missing source membership and pending non-global identity', async () => {
    const users = await UserCollection.create({ db });
    const user = await users.get(userId);
    if (!user) throw new Error('No User');
    for (const status of [UserStatus.SUSPENDED, UserStatus.PENDING]) {
      user.status = status;
      await user.save();
      await expect(prepare()).rejects.toThrow();
    }
    user.status = UserStatus.ACTIVE;
    await user.save();
    const profiles = await ProfileCollection.create({ db });
    const person = await withSystemContext(() => profiles.get(profileId));
    if (!person) throw new Error('No Person');
    person.email = 'mismatch@example.com';
    await withSystemContext(() => person.save());
    await expect(prepare()).rejects.toThrow();
    person.email = email;
    await withSystemContext(() => person.save());
    const membership = await (
      await MembershipCollection.create({ db })
    ).findByUserAndTenant(userId, sourceId);
    if (!membership) throw new Error('No source membership');
    membership.status = MembershipStatus.INACTIVE;
    await membership.save();
    await expect(prepare()).rejects.toThrow();
  });
  it('rolls back mailbox proof consumption, activation and host relationship writes together', async () => {
    const invitation = await grant();
    const proof = await mail(invitation);
    const type = await (
      await ProfileRelationshipTypeCollection.create({ db })
    ).getOrCreateBySlug('guardian', { name: 'Guardian' });
    const complete = (fail: boolean) =>
      tx(async (service, executor) => {
        const result = await service.authenticateMailbox({
          membershipId: invitation.membershipId,
          invitationToken: invitation.token,
          token: proof.token,
        });
        const relationship = new ProfileRelationship({
          db: executor,
          tenantId,
          fromProfileId: profileId,
          toProfileId: profileId,
          typeId: type.id as string,
        });
        await relationship.initialize();
        await relationship.save();
        await relationship.addTerm(new Date());
        if (fail) throw new Error('Host edge failure');
        return result;
      });
    await expect(complete(true)).rejects.toThrow('Host edge failure');
    expect(
      (await db.get('memberships', { id: invitation.membershipId })).status,
    ).toBe(MembershipStatus.PENDING);
    expect(
      (await db.query('SELECT id FROM profile_relationships')).rows,
    ).toHaveLength(0);
    await expect(complete(false)).resolves.toMatchObject({
      userId,
      profileId,
      tenantId,
    });
    expect(
      (await db.query('SELECT id FROM profile_relationships')).rows,
    ).toHaveLength(1);
    await expect(complete(false)).rejects.toThrow();
  });
  it('does not extend OIDC reconciliation to family-owned Persons', async () => {
    const invitation = await grant();
    await expect(
      tx(async (service, executor) =>
        service.authorizeOidcOwner(
          {
            db: executor,
            claims: {
              iss: 'https://issuer.example',
              sub: 'person',
              email,
              email_verified: true,
            },
            provider: 'test',
            users: await UserCollection.create({ db: executor }),
          },
          { membershipId: invitation.membershipId, token: invitation.token },
        ),
      ),
    ).rejects.toThrow();
    const proof = await mail(invitation);
    await expect(
      tx((service) =>
        service.authenticateMailbox({
          membershipId: invitation.membershipId,
          invitationToken: invitation.token,
          token: proof.token,
        }),
      ),
    ).resolves.toMatchObject({ userId });
  });
  it('preserves an active role and refuses a conflicting pending role or malformed selector/policy', async () => {
    const prepared = await prepare();
    const otherRole = await (await RoleCollection.create({ db })).create({
      tenantId,
      slug: 'other',
      name: 'Other',
    });
    await expect(
      tx((service) =>
        service.prepare({ tenantId, email, roleId: otherRole.id as string }),
      ),
    ).rejects.toThrow('role conflicts');
    await expect(
      tx((service) => service.prepare({ tenantId, email, roleId: 'invalid' })),
    ).rejects.toThrow('Invalid tenant invitation input');
    await expect(
      TenantInvitationService.create({
        db,
        transaction: 'caller',
        existingProfilePolicy:
          'unknown' as TenantInvitationServiceOptions['existingProfilePolicy'],
      }),
    ).rejects.toThrow('Invalid invitation existing profile policy');
    const membership = await (await MembershipCollection.create({ db })).get(
      prepared.membershipId,
    );
    if (!membership) throw new Error('Missing membership');
    membership.status = MembershipStatus.ACTIVE;
    await membership.save();
    await expect(
      tx((service) =>
        service.prepare({ tenantId, email, roleId: otherRole.id as string }),
      ),
    ).resolves.toMatchObject({
      status: 'active',
      membershipId: prepared.membershipId,
    });
    expect(
      (await db.get('memberships', { id: prepared.membershipId })).role_id,
    ).toBe(roleId);
  });
  it('rejects a non-Person discriminator and a profile binding changed after issue', async () => {
    const invitation = await grant();
    const proof = await mail(invitation);
    await db.query(
      'UPDATE profiles SET _meta_type = ? WHERE id = ?',
      '@happyvertical/smrt-profiles:Organization',
      profileId,
    );
    await expect(prepare()).rejects.toThrow();
    await expect(mail(invitation)).rejects.toThrow();
    await db.query(
      'UPDATE profiles SET _meta_type = ? WHERE id = ?',
      '@happyvertical/smrt-profiles:Person',
      profileId,
    );
    const types = await ProfileTypeCollection.create({ db });
    const type = await withSystemContext(() =>
      types.getOrCreateGlobalBySlug('person', { name: 'Person' }),
    );
    const replacement = new Person({
      db,
      tenantId: sourceId,
      email,
      name: 'Replacement',
      slug: randomUUID(),
      typeId: type.id as string,
    });
    await replacement.initialize();
    await replacement.save();
    const user = await (await UserCollection.create({ db })).get(userId);
    if (!user) throw new Error('No User');
    user.profileId = replacement.id as string;
    await user.save();
    await expect(
      tx((service) =>
        service.authenticateMailbox({
          membershipId: invitation.membershipId,
          invitationToken: invitation.token,
          token: proof.token,
        }),
      ),
    ).rejects.toThrow();
  });
  it('reissue and cancellation permanently invalidate old grants and independent mailbox proofs', async () => {
    const old = await grant();
    const oldMail = await mail(old);
    const replacement = await tx((service) =>
      service.issue({ membershipId: old.membershipId }),
    );
    await expect(mail(old)).rejects.toThrow();
    await expect(
      tx((service) =>
        service.authenticateMailbox({
          membershipId: old.membershipId,
          invitationToken: old.token,
          token: oldMail.token,
        }),
      ),
    ).rejects.toThrow();
    const replacementMail = await mail(replacement);
    await tx((service) => service.revoke({ membershipId: old.membershipId }));
    expect((await db.get('memberships', { id: old.membershipId })).status).toBe(
      MembershipStatus.INACTIVE,
    );
    await expect(
      tx((service) => service.issue({ membershipId: old.membershipId })),
    ).rejects.toThrow();
    const prepared = await prepare();
    expect(prepared.membershipId).toBe(old.membershipId);
    expect(prepared.status).toBe('pending');
    await expect(mail(old)).rejects.toThrow();
    await expect(mail(replacement)).rejects.toThrow();
    await expect(
      tx((service) =>
        service.authenticateMailbox({
          membershipId: old.membershipId,
          invitationToken: replacement.token,
          token: replacementMail.token,
        }),
      ),
    ).rejects.toThrow();
    const fresh = await tx((service) =>
      service.issue({ membershipId: old.membershipId }),
    );
    const proof = await mail(fresh);
    await tx((service) =>
      service.authenticateMailbox({
        membershipId: old.membershipId,
        invitationToken: fresh.token,
        token: proof.token,
      }),
    );
    await expect(
      tx((service) => service.revoke({ membershipId: old.membershipId })),
    ).rejects.toThrow('Only pending');
    expect((await db.get('memberships', { id: old.membershipId })).status).toBe(
      MembershipStatus.ACTIVE,
    );
  });
  it('can cancel pending access even after its invitee is suspended', async () => {
    const invitation = await grant();
    const user = await (await UserCollection.create({ db })).get(userId);
    if (!user) throw new Error('No user');
    user.status = UserStatus.SUSPENDED;
    await user.save();
    await tx((service) =>
      service.revoke({ membershipId: invitation.membershipId }),
    );
    user.status = UserStatus.ACTIVE;
    await user.save();
    await prepare();
    await expect(mail(invitation)).rejects.toThrow();
  });
  it('fails closed on malformed generation and cannot reprepare arbitrary inactive memberships', async () => {
    const invitation = await grant();
    const memberships = await MembershipCollection.create({ db });
    const membership = await memberships.get(invitation.membershipId);
    if (!membership) throw new Error('No membership');
    await membership.remember({
      scope: 'smrt/tenant-invitation',
      key: 'generation',
      value: { generation: 'bad', revoked: false },
    });
    await expect(prepare()).rejects.toThrow('state is unavailable');
    await expect(
      tx((service) => service.issue({ membershipId: invitation.membershipId })),
    ).rejects.toThrow('state is unavailable');
    await membership.forget({
      scope: 'smrt/tenant-invitation',
      key: 'generation',
    });
    membership.status = MembershipStatus.INACTIVE;
    await membership.save();
    await expect(prepare()).rejects.toThrow('membership is unavailable');
  });
  it('revoke and reissue failures roll back without burning valid access', async () => {
    const invitation = await grant();
    const proof = await mail(invitation);
    await expect(
      tx(async (service) => {
        await service.revoke({ membershipId: invitation.membershipId });
        throw new Error('host cancel rollback');
      }),
    ).rejects.toThrow('host cancel rollback');
    await expect(
      tx(async (service) => {
        await service.issue({ membershipId: invitation.membershipId });
        throw new Error('host resend rollback');
      }),
    ).rejects.toThrow('host resend rollback');
    await expect(
      tx((service) =>
        service.authenticateMailbox({
          membershipId: invitation.membershipId,
          invitationToken: invitation.token,
          token: proof.token,
        }),
      ),
    ).resolves.toMatchObject({ status: 'active' });
  });
  it.skipIf(process.env.TEST_DB_ADAPTER !== 'postgres')(
    'serializes acceptance racing cancellation without reviving a revoked proof',
    async () => {
      const invitation = await grant();
      const proof = await mail(invitation);
      const results = await Promise.allSettled([
        tx((service) =>
          service.authenticateMailbox({
            membershipId: invitation.membershipId,
            invitationToken: invitation.token,
            token: proof.token,
          }),
        ),
        tx((service) =>
          service.revoke({ membershipId: invitation.membershipId }),
        ),
      ]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      const membership = await db.get('memberships', {
        id: invitation.membershipId,
      });
      if (membership.status === MembershipStatus.INACTIVE) {
        await prepare();
        await expect(mail(invitation)).rejects.toThrow();
      } else expect(membership.status).toBe(MembershipStatus.ACTIVE);
    },
  );
  it.skipIf(process.env.TEST_DB_ADAPTER !== 'postgres')(
    'serializes concurrent exact-family mailbox completions',
    async () => {
      const invitation = await grant();
      const proof = await mail(invitation);
      const complete = () =>
        tx((service) =>
          service.authenticateMailbox({
            membershipId: invitation.membershipId,
            invitationToken: invitation.token,
            token: proof.token,
          }),
        );
      const results = await Promise.allSettled([complete(), complete()]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === 'rejected'),
      ).toHaveLength(1);
    },
  );
});
