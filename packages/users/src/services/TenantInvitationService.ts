/** Pending invitations with explicit, signed single-use acceptance. @packageDocumentation */
import { createHash, randomUUID } from 'node:crypto';
import {
  isPostgresDatabase,
  type SmrtClassOptions,
} from '@happyvertical/smrt-core';
import {
  CanonicalPersonProfileError,
  normalizeIdentityEmail,
  Person,
  type Profile,
  ProfileCollection,
  ProfileTypeCollection,
} from '@happyvertical/smrt-profiles';
import { withSystemContext } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { MembershipCollection } from '../collections/MembershipCollection.js';
import { RoleCollection } from '../collections/RoleCollection.js';
import { TenantCollection } from '../collections/TenantCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import { isValidEmail } from '../models/User.js';
import { MembershipStatus, TenantStatus, UserStatus } from '../types/index.js';
import { MagicLinkService } from './MagicLinkService.js';

/** Host-authorized invitation destination and least-privilege system role. */
export interface PrepareTenantInvitationInput {
  tenantId: string;
  email: string;
  roleSlug: string;
}
/** Persisted pending access; active means the exact membership already existed. */
export interface PreparedTenantInvitation {
  userId: string;
  profileId: string;
  membershipId: string;
  status: 'pending' | 'active';
}

/** Expected, safe invitation refusal; adapter/database failures remain distinct. */
export class TenantInvitationError extends Error {
  readonly status: 400 | 403;
  constructor(message: string, status: 400 | 403 = 400) {
    super(message);
    this.name = 'TenantInvitationError';
    this.status = status;
  }
}

/** Signing is required only when issuing or accepting an invitation. */
export interface TenantInvitationServiceOptions extends SmrtClassOptions {
  transaction: 'caller';
  secret?: string;
  tokenExpiry?: number;
}
/** Copyable bearer proof; the host owns secure delivery and must not log it. */
export interface IssuedTenantInvitation {
  membershipId: string;
  token: string;
  expiresAt: Date;
}
/** Accepted identity and destination; no session is minted by this service. */
export interface AcceptedTenantInvitation
  extends Omit<PreparedTenantInvitation, 'status'> {
  tenantId: string;
  status: 'active';
}

/**
 * Trusted host integration seam, never a public unauthenticated endpoint.
 * The host authorizes the destination tenant/role and owns the transaction.
 * prepare() creates pending records only. issue() returns a signed bearer proof
 * for host-controlled secure delivery; accept() consumes that exact proof before
 * activating the bound pending User/Membership. No email or session is created.
 * Concurrent identity conflicts fail and roll back the caller transaction;
 * the host may retry the entire transaction after that rollback.
 */
export class TenantInvitationService {
  private constructor(
    private readonly options: SmrtClassOptions,
    private readonly signing: { secret?: string; tokenExpiry?: number },
  ) {}

  /** Bind an already-initialized transaction executor; never nest transactions. */
  static async create(
    options: TenantInvitationServiceOptions,
  ): Promise<TenantInvitationService> {
    if (!options.db || options.transaction !== 'caller')
      throw new Error('Tenant invitation requires a caller-owned transaction');
    return new TenantInvitationService(
      {
        db: options.db,
        _reuseInitializedDb: true,
        _deferRuntimeInitialization: true,
      },
      { secret: options.secret, tokenExpiry: options.tokenExpiry },
    );
  }

  /** Host-authorized issue/reissue; never sends or logs the bearer token. */
  async issue(input: {
    membershipId: string;
  }): Promise<IssuedTenantInvitation> {
    return await withSystemContext(async () => {
      const records = await this.invitationRecords(input.membershipId);
      const links = await this.magicLinks(records.binding);
      const result = await links.generate(records.user.email);
      return { membershipId: input.membershipId, ...result };
    });
  }

  /** Verify single-use membership-bound proof and atomically accept pending access. */
  async accept(input: {
    membershipId: string;
    token: string;
    expectedUserId?: string;
  }): Promise<AcceptedTenantInvitation> {
    return await withSystemContext(async () => {
      const { user, membership, profileId, binding } =
        await this.invitationRecords(input.membershipId);
      if (
        input.expectedUserId !== undefined &&
        input.expectedUserId !== user.id
      )
        throw new TenantInvitationError(
          'Invitation does not belong to the signed-in user',
        );
      const links = await this.magicLinks(binding);
      const proof = await links.verify(input.token);
      if (proof.email !== normalizeIdentityEmail(user.email))
        throw new TenantInvitationError('Invitation identity does not match');
      if (user.status === UserStatus.PENDING) {
        user.status = UserStatus.ACTIVE;
        await user.save();
      }
      if (membership.status === MembershipStatus.PENDING) {
        membership.status = MembershipStatus.ACTIVE;
        await membership.save();
      }
      return {
        userId: requiredId(user.id),
        profileId,
        membershipId: requiredId(membership.id),
        tenantId: requiredId(membership.tenantId),
        status: 'active',
      };
    });
  }

  private async magicLinks(binding: string): Promise<MagicLinkService> {
    if (!this.signing.secret)
      throw new Error('Invitation signing secret is required');
    const tokenExpiry = this.signing.tokenExpiry ?? 86400;
    if (
      !Number.isSafeInteger(tokenExpiry) ||
      tokenExpiry < 1 ||
      tokenExpiry > 604800
    )
      throw new Error('Invitation token expiry must be 1–604800 seconds');
    return await MagicLinkService.create({
      ...this.options,
      secret: this.signing.secret,
      tokenExpiry,
      issuer: `smrt:tenant-invitation:v1:${binding}`,
    });
  }

  /** Lock existing authority before verifying it; never authorize by email match. */
  private async invitationRecords(membershipId: string) {
    if (
      typeof membershipId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        membershipId,
      )
    )
      throw new TenantInvitationError('Invitation is unavailable', 403);
    const memberships = await MembershipCollection.create(this.options);
    let membership = await memberships.get(
      { id: membershipId },
      { cache: false },
    );
    if (!membership?.userId || !membership.tenantId || !membership.roleId)
      throw new TenantInvitationError('Invitation is unavailable');
    const userId = membership.userId;
    const db = this.options.db as DatabaseInterface;
    if (isPostgresDatabase(db)) {
      await db.query('SELECT id FROM users WHERE id = ? FOR UPDATE', userId);
      await db.query(
        'SELECT id FROM memberships WHERE id = ? FOR UPDATE',
        membershipId,
      );
    }
    membership = await memberships.get({ id: membershipId }, { cache: false });
    if (
      !membership ||
      membership.userId !== userId ||
      !membership.tenantId ||
      !membership.roleId ||
      (membership.status !== MembershipStatus.PENDING &&
        membership.status !== MembershipStatus.ACTIVE)
    )
      throw new TenantInvitationError('Invitation is unavailable');
    const users = await UserCollection.create(this.options);
    const user = await users.get({ id: userId }, { cache: false });
    if (
      !user ||
      (user.status !== UserStatus.PENDING && user.status !== UserStatus.ACTIVE)
    )
      throw new TenantInvitationError('Invitation is unavailable');
    const tenants = await TenantCollection.create(this.options);
    const tenant = await tenants.get(
      { id: membership.tenantId },
      { cache: false },
    );
    if (!tenant || tenant.status !== TenantStatus.ACTIVE)
      throw new TenantInvitationError('Invitation is unavailable');
    const profiles = await ProfileCollection.create(this.options);
    let profile: Profile;
    try {
      profile = await profiles.requireCanonicalGlobalPerson(
        user.profileId,
        user.email,
      );
    } catch (error) {
      if (error instanceof CanonicalPersonProfileError)
        throw new TenantInvitationError(
          'Invitation identity is unavailable',
          403,
        );
      throw error;
    }
    if ((await users.findCanonicalByEmail(user.email))?.id !== user.id)
      throw new TenantInvitationError(
        'Invitation identity ownership is inconsistent',
      );
    const profileId = requiredId(profile.id);
    const binding = createHash('sha256')
      .update(
        JSON.stringify([
          membership.id,
          user.id,
          profileId,
          membership.tenantId,
          membership.roleId,
        ]),
      )
      .digest('hex');
    return { user, membership, profileId, binding };
  }

  /** Prepare or replay a pending membership, preserving all existing authority. */
  async prepare(
    input: PrepareTenantInvitationInput,
  ): Promise<PreparedTenantInvitation> {
    if (
      !input.tenantId?.trim() ||
      !input.roleSlug?.trim() ||
      !isValidEmail(input.email)
    )
      throw new TenantInvitationError('Invalid tenant invitation input');
    const email = normalizeIdentityEmail(input.email);
    return await withSystemContext(async () => {
      const tenants = await TenantCollection.create(this.options);
      const tenant = await tenants.get(
        { id: input.tenantId },
        { cache: false },
      );
      if (!tenant || tenant.status !== TenantStatus.ACTIVE)
        throw new TenantInvitationError('Invitation tenant is unavailable');
      const roles = await RoleCollection.create(this.options);
      const role = await roles.findSystemRoleBySlug(input.roleSlug);
      if (!role?.id)
        throw new TenantInvitationError(
          'Invitation system role is unavailable',
        );
      const users = await UserCollection.create(this.options);
      const profiles = await ProfileCollection.create(this.options);
      let user = await users.findCanonicalByEmail(email);
      let profileId: string;
      if (user) {
        if (
          user.status !== UserStatus.ACTIVE &&
          user.status !== UserStatus.PENDING
        )
          throw new TenantInvitationError('Invitation user is unavailable');
        const profile = await profiles.requireCanonicalGlobalPerson(
          user.profileId,
          email,
        );
        profileId = requiredId(profile.id);
        const owners = await users.list({ where: { profileId }, limit: 2 });
        if (owners.length !== 1 || owners[0].id !== user.id)
          throw new TenantInvitationError(
            'Invitation identity ownership is inconsistent',
          );
      } else {
        // Matching unowned Profile email is not proof of ownership.
        if (await profiles.findUniqueGlobalPersonByEmail(email))
          throw new TenantInvitationError(
            'Invitation email requires explicit identity reconciliation',
          );
        const types = await ProfileTypeCollection.create(this.options);
        const personType = await types.getOrCreateGlobalBySlug('person', {
          name: 'Person',
          description: 'Individual person profile',
        });
        const person = new Person({
          ...this.options,
          tenantId: null,
          typeId: requiredId(personType.id),
          slug: `invitation-${randomUUID()}`,
          name: email,
          email,
        });
        await person.initialize();
        await person.save();
        profileId = requiredId(person.id);
        await profiles.reserveCanonicalIdentityEmail(profileId, email);
        user = await users.create({
          email,
          profileId,
          status: UserStatus.PENDING,
        });
      }
      const userId = requiredId(user.id);
      const memberships = await MembershipCollection.create(this.options);
      const matches = await memberships.list({
        where: { userId, tenantId: input.tenantId },
        limit: 2,
      });
      if (matches.length > 1)
        throw new TenantInvitationError('Invitation membership is ambiguous');
      let membership = matches[0];
      if (membership) {
        if (
          membership.status !== MembershipStatus.ACTIVE &&
          membership.status !== MembershipStatus.PENDING
        )
          throw new TenantInvitationError(
            'Invitation membership is unavailable',
          );
        if (
          membership.status === MembershipStatus.PENDING &&
          membership.roleId !== role.id
        )
          throw new TenantInvitationError(
            'Pending invitation role conflicts with existing invitation',
          );
      } else {
        membership = await memberships.create({
          userId,
          tenantId: input.tenantId,
          roleId: role.id,
          status: MembershipStatus.PENDING,
        });
      }
      return {
        userId,
        profileId,
        membershipId: requiredId(membership.id),
        status: membership.status as 'pending' | 'active',
      };
    });
  }
}
function requiredId(id: unknown): string {
  if (typeof id !== 'string' || !id)
    throw new TenantInvitationError('Invitation record has no id');
  return id;
}
