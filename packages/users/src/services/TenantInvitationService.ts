/** Pending invitations with explicit, signed single-use acceptance. @packageDocumentation */
import { createHash } from 'node:crypto';
import {
  isPostgresDatabase,
  type SmrtClassOptions,
} from '@happyvertical/smrt-core';
import {
  CanonicalPersonProfileError,
  normalizeIdentityEmail,
  type Profile,
  ProfileCollection,
} from '@happyvertical/smrt-profiles';
import { withSystemContext } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { MembershipCollection } from '../collections/MembershipCollection.js';
import { RoleCollection } from '../collections/RoleCollection.js';
import { SessionCollection } from '../collections/SessionCollection.js';
import { TenantCollection } from '../collections/TenantCollection.js';
import {
  type OidcProfileOwnerAuthorizerContext,
  UserCollection,
} from '../collections/UserCollection.js';
import { isValidEmail } from '../models/User.js';
import { MembershipStatus, TenantStatus, UserStatus } from '../types/index.js';
import { provisionCanonicalMailboxIdentity } from './canonical-mailbox-identity.js';
import type { LoginAttemptLimiter } from './LoginAttemptLimiter.js';
import { MagicLinkService } from './MagicLinkService.js';
import {
  assertMailboxSessionCompatibility,
  type MailboxAuthenticationDelivery,
  reserveMailboxRequest,
} from './MailboxAuthenticationService.js';
import { SessionService } from './SessionService.js';

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
  /** Required for requestMailboxAuthentication(): supply a root-executor limiter independent of the caller transaction. Other operations may omit it. */
  loginLimiter?: LoginAttemptLimiter;
}
/** Copyable tenant grant, never identity proof; the host must not log it. */
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
 * for host-controlled delivery. accept() requires independent identity login;
 * only the protocol-verified OIDC owner callback may activate a pending User. No email or session is created.
 * Concurrent identity conflicts fail and roll back the caller transaction;
 * the host may retry the entire transaction after that rollback.
 */
export class TenantInvitationService {
  private constructor(
    private readonly options: SmrtClassOptions,
    private readonly signing: {
      secret?: string;
      tokenExpiry?: number;
      loginLimiter?: LoginAttemptLimiter;
    },
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
      {
        secret: options.secret,
        tokenExpiry: options.tokenExpiry,
        loginLimiter: options.loginLimiter,
      },
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

  /**
   * Request independent mailbox authentication, delivering only to the canonical
   * invitee. The trusted server callback must send auth mail, never expose the
   * proof to a requester/operator, and reject on transport failure. No grant is
   * consumed here, so failed delivery/retries do not burn invitation access.
   * Delivery precedes caller commit: a rolled-back challenge cannot authenticate.
   */
  async requestMailboxAuthentication(input: {
    membershipId: string;
    token: string;
    sourceKey: string;
    deliver: MailboxAuthenticationDelivery;
  }): Promise<{ expiresAt: Date }> {
    if (typeof input.deliver !== 'function')
      throw new TenantInvitationError(
        'Mailbox authentication delivery is required',
      );
    await reserveMailboxRequest({
      subject: `invitation:${input.membershipId}`,
      sourceKey: input.sourceKey,
      limiter: this.signing.loginLimiter,
    });
    return await withSystemContext(async () => {
      const records = await this.invitationRecords(input.membershipId);
      const grant = await (await this.magicLinks(records.binding)).inspect(
        input.token,
      );
      if (grant.email !== normalizeIdentityEmail(records.user.email))
        throw new TenantInvitationError(
          'Invitation identity does not match',
          403,
        );
      const proof = await (
        await this.mailboxLinks(records.binding, input.token)
      ).generate(records.user.email);
      await input.deliver({
        email: normalizeIdentityEmail(records.user.email),
        ...proof,
      });
      return { expiresAt: proof.expiresAt };
    });
  }

  /**
   * Authenticate ONLY independent proof delivered to the canonical mailbox plus
   * the exact project grant. Claim both nonces and activate atomically in the
   * caller transaction. The host may then establish a magic-link session from
   * committed returned IDs; a copied project grant alone never proves identity.
   */
  async authenticateMailbox(input: {
    membershipId: string;
    invitationToken: string;
    token: string;
    expectedUserId?: string;
    sessionId?: string;
  }): Promise<AcceptedTenantInvitation> {
    return await withSystemContext(async () => {
      const records = await this.invitationRecords(input.membershipId);
      if (
        input.expectedUserId !== undefined &&
        input.expectedUserId !== records.user.id
      )
        throw new TenantInvitationError(
          'Invitation does not belong to the signed-in user',
          403,
        );
      await assertMailboxSessionCompatibility(this.options, {
        userId: requiredId(records.user.id),
        expectedUserId: input.expectedUserId,
        sessionId: input.sessionId,
      });
      const mailbox = await (
        await this.mailboxLinks(records.binding, input.invitationToken)
      ).verify(input.token);
      if (mailbox.email !== normalizeIdentityEmail(records.user.email))
        throw new TenantInvitationError(
          'Mailbox authentication identity does not match',
          403,
        );
      await this.verifyProof(
        records.binding,
        records.user.email,
        input.invitationToken,
      );
      if (records.user.status === UserStatus.PENDING)
        records.user.status = UserStatus.ACTIVE;
      records.user.recordLogin();
      await records.user.save();
      await this.activateMembership(records.membership);
      return {
        userId: requiredId(records.user.id),
        profileId: records.profileId,
        membershipId: requiredId(records.membership.id),
        tenantId: requiredId(records.membership.tenantId),
        status: 'active',
      };
    });
  }

  private async mailboxLinks(
    binding: string,
    grant: string,
  ): Promise<MagicLinkService> {
    if (!this.signing.secret)
      throw new Error('Invitation signing secret is required');
    return await MagicLinkService.create({
      ...this.options,
      secret: this.signing.secret,
      tokenExpiry: 600,
      issuer: `smrt:tenant-mailbox:v1:${binding}:${createHash('sha256').update(grant).digest('hex')}`,
    });
  }

  /** Accept a tenant grant using an independently authenticated first-class session. */
  async accept(input: {
    membershipId: string;
    token: string;
    sessionId: string;
    expectedUserId?: string;
  }): Promise<AcceptedTenantInvitation> {
    return await withSystemContext(async () => {
      const records = await this.invitationRecords(input.membershipId);
      const sessions = await SessionCollection.create(this.options);
      const session = input.sessionId
        ? await sessions.findValidSession(input.sessionId)
        : null;
      const context = session
        ? await (await SessionService.create(this.options)).loadSessionContext(
            input.sessionId,
          )
        : null;
      if (
        !session ||
        !context ||
        records.user.status !== UserStatus.ACTIVE ||
        context.user.id !== records.user.id ||
        session.userId !== records.user.id ||
        session.parentSessionId ||
        session.getPermissionCeiling() !== null ||
        !['oidc', 'magic-link', 'password', 'passkey'].includes(
          session.authMethod ?? '',
        ) ||
        (input.expectedUserId !== undefined &&
          input.expectedUserId !== records.user.id)
      )
        throw new TenantInvitationError(
          'Independent invitation identity authentication is required',
          403,
        );
      await this.verifyProof(records.binding, records.user.email, input.token);
      await this.activateMembership(records.membership);
      return {
        userId: requiredId(records.user.id),
        profileId: records.profileId,
        membershipId: requiredId(records.membership.id),
        tenantId: requiredId(records.membership.tenantId),
        status: 'active',
      };
    });
  }

  /**
   * Authorize a pre-provisioned owner ONLY inside the canonical protocol-verified
   * OIDC callback. A tenant grant alone never proves global identity. The host
   * must not expose this trusted callback seam to arbitrary claims.
   */
  async authorizeOidcOwner(
    context: OidcProfileOwnerAuthorizerContext,
    input: {
      membershipId: string;
      token: string;
    },
  ) {
    if (
      context.db !== this.options.db ||
      context.claims.email_verified !== true
    )
      throw new TenantInvitationError(
        'Verified OIDC invitation identity is required',
        403,
      );
    return await withSystemContext(async () => {
      const records = await this.invitationRecords(input.membershipId);
      if (
        !context.claims.email ||
        normalizeIdentityEmail(context.claims.email) !==
          normalizeIdentityEmail(records.user.email)
      )
        throw new TenantInvitationError(
          'Verified OIDC invitation identity does not match',
          403,
        );
      await this.verifyProof(records.binding, records.user.email, input.token);
      if (records.user.status === UserStatus.PENDING) {
        records.user.status = UserStatus.ACTIVE;
        await records.user.save();
      }
      await this.activateMembership(records.membership);
      return {
        profile: records.profile,
        user: records.user,
        tenantId: requiredId(records.membership.tenantId),
        membershipId: requiredId(records.membership.id),
      };
    });
  }

  private async activateMembership(
    membership: import('../models/Membership.js').Membership,
  ) {
    if (membership.status === MembershipStatus.PENDING) {
      membership.status = MembershipStatus.ACTIVE;
      await membership.save();
    }
  }

  private async verifyProof(binding: string, email: string, token: string) {
    const proof = await (await this.magicLinks(binding)).verify(token);
    if (proof.email !== normalizeIdentityEmail(email))
      throw new TenantInvitationError(
        'Invitation identity does not match',
        403,
      );
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
    return { user, membership, profile, profileId, binding };
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
      const { user, profileId } = await provisionCanonicalMailboxIdentity(
        this.options,
        {
          email,
          status: UserStatus.PENDING,
          allowPending: true,
          refuse: (message) => new TenantInvitationError(message),
        },
      );
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
