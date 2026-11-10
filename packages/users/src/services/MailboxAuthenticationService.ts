/** Independent emailed mailbox authentication for existing active canonical users. */
import {
  isEmbeddedDatabase,
  isPostgresDatabase,
  type SmrtClassOptions,
} from '@happyvertical/smrt-core';
import {
  CanonicalPersonProfileError,
  normalizeIdentityEmail,
  ProfileCollection,
} from '@happyvertical/smrt-profiles';
import { withSystemContext } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { MembershipCollection } from '../collections/MembershipCollection.js';
import { SessionCollection } from '../collections/SessionCollection.js';
import { TenantCollection } from '../collections/TenantCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import { isValidEmail, normalizeEmail } from '../models/User.js';
import { MembershipStatus, TenantStatus, UserStatus } from '../types/index.js';
import {
  type LoginAttemptLimiter,
  LoginRateLimitError,
} from './LoginAttemptLimiter.js';
import { MagicLinkError, MagicLinkService } from './MagicLinkService.js';
import { SessionService } from './SessionService.js';

/** Server-only effect. Never return, log, preview, or expose the mailed proof. */
export type MailboxAuthenticationDelivery = (mail: {
  email: string;
  token: string;
  expiresAt: Date;
}) => Promise<void>;
export interface MailboxAuthenticationServiceOptions extends SmrtClassOptions {
  transaction: 'caller';
  secret: string;
  /** Required for request(): supply a root-executor limiter independent of the caller transaction. Completion-only use may omit it. */
  loginLimiter?: LoginAttemptLimiter;
}
export interface AuthenticatedMailbox {
  userId: string;
  profileId: string;
  tenantId: string;
}

/** Immutable destination selected by the trusted server before its caller transaction. */
export type MailboxAuthenticationRequestScope =
  | { purpose: 'returning'; email: string }
  | { purpose: 'invitation'; tenantId: string; email: string };
declare const mailboxReservationBrand: unique symbol;
/** Opaque one-use budget capability; never serialize, copy, or return to a browser. */
export type MailboxRequestReservation = Readonly<{
  [mailboxReservationBrand]: true;
}>;
type ReservationState = {
  scope: MailboxAuthenticationRequestScope;
  sourceKey: string;
  limiter: LoginAttemptLimiter;
  expiresAt: number;
};
const mailboxReservations = new WeakMap<object, ReservationState>();
function normalizedScope(
  scope: MailboxAuthenticationRequestScope,
): MailboxAuthenticationRequestScope {
  if (
    !scope ||
    typeof scope.email !== 'string' ||
    !['returning', 'invitation'].includes(scope.purpose)
  )
    throw new Error('Invalid mailbox request scope');
  if (scope.purpose === 'invitation') {
    if (typeof scope.tenantId !== 'string' || !scope.tenantId.trim())
      throw new Error('Invitation request tenant is required');
    return {
      purpose: 'invitation',
      tenantId: scope.tenantId,
      email: normalizeEmail(scope.email),
    };
  }
  return { purpose: 'returning', email: normalizeEmail(scope.email) };
}
function scopeKey(scope: MailboxAuthenticationRequestScope): string {
  return scope.purpose === 'invitation'
    ? JSON.stringify(['invitation', scope.tenantId, scope.email])
    : JSON.stringify(['returning', scope.email]);
}
/**
 * Reserve AND settle retained send budget before entering the caller transaction.
 * Malformed/unknown returning email deliberately consumes the same source budget.
 * This capability carries no release/refund operation and expires no later than
 * any reserved key's actual window end or thirty seconds, whichever comes first.
 */
export async function reserveMailboxAuthenticationRequest(input: {
  limiter: LoginAttemptLimiter;
  scope: MailboxAuthenticationRequestScope;
  sourceKey: string;
}): Promise<MailboxRequestReservation> {
  const scope = normalizedScope(input.scope);
  const deadline = await reserveMailboxRequest({
    limiter: input.limiter,
    subject: scopeKey(scope),
    sourceKey: input.sourceKey,
  });
  if (!Number.isFinite(deadline))
    throw new Error('Mailbox request budget deadline is unavailable');
  const reservation = Object.freeze({}) as MailboxRequestReservation;
  mailboxReservations.set(reservation, {
    scope,
    limiter: input.limiter,
    sourceKey: input.sourceKey.trim(),
    expiresAt: Math.min(Date.now() + 30_000, deadline),
  });
  return reservation;
}
/** Internal one-use claim: delete synchronously, before any request work can await. */
export function claimMailboxAuthenticationRequest(input: {
  reservation?: MailboxRequestReservation;
  limiter?: LoginAttemptLimiter;
  sourceKey: string;
  db: DatabaseInterface;
}) {
  let state: ReservationState | undefined;
  if (input.reservation !== undefined) {
    state = mailboxReservations.get(input.reservation);
    mailboxReservations.delete(input.reservation);
    if (
      !state ||
      state.limiter !== input.limiter ||
      state.sourceKey !== input.sourceKey?.trim()
    )
      throw new Error('Mailbox request reservation is unavailable');
  }
  if (!input.limiter)
    throw new Error(
      'Mailbox authentication requests require an independently supplied root-executor login limiter',
    );
  if (!state && isEmbeddedDatabase(input.db))
    throw new Error(
      'Embedded mailbox requests require a pre-transaction reservation',
    );
  const assertFresh = () => {
    if (state && Date.now() >= state.expiresAt)
      throw new Error('Mailbox request reservation has expired');
  };
  assertFresh();
  return {
    reserved: state !== undefined,
    assertFresh,
    assertScope(scope: MailboxAuthenticationRequestScope) {
      assertFresh();
      if (state && scopeKey(state.scope) !== scopeKey(normalizedScope(scope)))
        throw new Error(
          'Mailbox request reservation does not match destination',
        );
    },
  };
}

/** Canonical shared request budget; keys are hashed/peppered by LoginAttemptLimiter. */
export async function reserveMailboxRequest(input: {
  subject: string;
  sourceKey: string;
  limiter?: LoginAttemptLimiter;
}) {
  if (!input.limiter)
    throw new Error(
      'Mailbox authentication requests require an independently supplied root-executor login limiter',
    );
  if (!input.sourceKey?.trim())
    throw new Error('Mailbox authentication source key is required');
  const lease = await input.limiter.reserve({
    kind: 'mailbox-request',
    subject: `mailbox:${input.subject}`,
    source: `mailbox:${input.sourceKey.trim()}`,
    retainOnSuccess: true,
  });
  if (!lease.allowed) throw new LoginRateLimitError(lease);
  // Every request consumes budget equally, even unknown accounts or transport errors.
  await lease.succeed();
  return lease.budgetExpiresAt;
}

/** Preserve existing signed-in identity and session ceilings during mailbox login. */
export async function assertMailboxSessionCompatibility(
  options: SmrtClassOptions,
  input: {
    userId: string;
    expectedUserId?: string;
    sessionId?: string;
  },
) {
  if (
    input.expectedUserId !== undefined &&
    input.expectedUserId !== input.userId
  )
    throw new MagicLinkError('Sign-in identity does not match');
  if (input.sessionId !== undefined) {
    const sessions = await SessionCollection.create(options);
    const session = await sessions.findValidSession(input.sessionId);
    const context = session
      ? await (await SessionService.create(options)).loadSessionContext(
          input.sessionId,
        )
      : null;
    if (
      !session ||
      !context ||
      session.userId !== input.userId ||
      context.user.id !== input.userId ||
      session.parentSessionId ||
      session.getPermissionCeiling() !== null ||
      !['oidc', 'magic-link', 'password', 'passkey'].includes(
        session.authMethod ?? '',
      )
    )
      throw new MagicLinkError('Independent first-class sign-in is required');
  }
}

/**
 * Caller owns transaction and trusted email transport. No sessions are minted.
 * Request response is uniform for unknown/ineligible email; mail goes only to
 * canonical active accounts. A delivered proof can authenticate only after the
 * request transaction commits. Transport failure must reject and roll it back.
 * The host should return a uniform HTTP response and run transport off the
 * response timing path where supported; transport latency is not identity proof.
 */
export class MailboxAuthenticationService {
  private constructor(
    private readonly options: SmrtClassOptions,
    private readonly auth: {
      secret: string;
      loginLimiter?: LoginAttemptLimiter;
    },
  ) {}
  static async create(options: MailboxAuthenticationServiceOptions) {
    if (!options.db || options.transaction !== 'caller' || !options.secret)
      throw new Error(
        'Mailbox authentication requires a signing secret and caller-owned transaction',
      );
    return new MailboxAuthenticationService(
      {
        db: options.db,
        _reuseInitializedDb: true,
        _deferRuntimeInitialization: true,
      },
      { secret: options.secret, loginLimiter: options.loginLimiter },
    );
  }
  async request(input: {
    email: string;
    sourceKey: string;
    deliver: MailboxAuthenticationDelivery;
    reservation?: MailboxRequestReservation;
  }): Promise<{ requested: true }> {
    const reservation = claimMailboxAuthenticationRequest({
      reservation: input.reservation,
      limiter: this.auth.loginLimiter,
      sourceKey: input.sourceKey,
      db: this.options.db as DatabaseInterface,
    });
    reservation.assertScope({ purpose: 'returning', email: input.email });
    if (typeof input.deliver !== 'function')
      throw new Error('Mailbox authentication delivery is required');
    const started = performance.now();
    try {
      if (!reservation.reserved)
        await reserveMailboxRequest({
          subject: normalizeEmail(input.email),
          sourceKey: input.sourceKey,
          limiter: this.auth.loginLimiter,
        });
      return await withSystemContext(async () => {
        const identity = isValidEmail(input.email)
          ? await this.eligible(input.email)
          : null;
        reservation.assertFresh();
        if (identity) {
          const links = await this.links();
          reservation.assertFresh();
          const proof = await links.generate(identity.user.email, {
            subject: identity.binding,
          });
          reservation.assertFresh();
          await input.deliver({
            email: normalizeIdentityEmail(identity.user.email),
            ...proof,
          });
        }
        return { requested: true };
      });
    } finally {
      // Avoid a trivial local timing oracle; delivery latency is transport-dependent.
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, 250 - (performance.now() - started))),
      );
    }
  }
  async authenticate(input: {
    token: string;
    expectedUserId?: string;
    sessionId?: string;
  }): Promise<AuthenticatedMailbox> {
    return await withSystemContext(async () => {
      const proof = await (await this.links()).inspect(input.token);
      const identity = await this.eligible(proof.email, true);
      if (
        !identity ||
        proof.subject !== identity.binding ||
        (input.expectedUserId !== undefined &&
          input.expectedUserId !== identity.user.id)
      )
        throw new MagicLinkError('Sign-in link is unavailable');
      await assertMailboxSessionCompatibility(this.options, {
        userId: identity.user.id as string,
        expectedUserId: input.expectedUserId,
        sessionId: input.sessionId,
      });
      await (await this.links()).verify(input.token);
      identity.user.recordLogin();
      await identity.user.save();
      return {
        userId: identity.user.id as string,
        profileId: identity.user.profileId,
        tenantId: identity.tenantId,
      };
    });
  }
  private async links() {
    return await MagicLinkService.create({
      ...this.options,
      secret: this.auth.secret,
      tokenExpiry: 600,
      issuer: 'smrt:mailbox-auth:v1',
    });
  }
  private async eligible(email: string, lock = false) {
    const users = await UserCollection.create(this.options);
    let user = await users.findCanonicalByEmail(normalizeIdentityEmail(email));
    if (!user?.id || user.status !== UserStatus.ACTIVE) return null;
    const db = this.options.db as DatabaseInterface;
    if (lock && isPostgresDatabase(db)) {
      await db.query('SELECT id FROM users WHERE id = ? FOR UPDATE', user.id);
      user = await users.get({ id: user.id }, { cache: false });
      if (
        !user?.id ||
        user.status !== UserStatus.ACTIVE ||
        normalizeIdentityEmail(user.email) !== normalizeIdentityEmail(email)
      )
        return null;
    }
    const profiles = await ProfileCollection.create(this.options);
    try {
      await profiles.requireCanonicalGlobalPerson(user.profileId, user.email);
    } catch (error) {
      if (error instanceof CanonicalPersonProfileError) return null;
      throw error;
    }
    const memberships = await MembershipCollection.create(this.options);
    const tenants = await TenantCollection.create(this.options);
    const pageSize = 100;
    let afterId: string | undefined;
    for (;;) {
      const active = await memberships.list({
        where: {
          userId: user.id,
          status: MembershipStatus.ACTIVE,
          ...(afterId ? { 'id >': afterId } : {}),
        },
        orderBy: 'id ASC',
        limit: pageSize,
      });
      for (let membership of active) {
        if (lock && isPostgresDatabase(db)) {
          await db.query(
            'SELECT id FROM memberships WHERE id = ? FOR UPDATE',
            membership.id,
          );
          const current = await memberships.get(
            { id: membership.id },
            { cache: false },
          );
          if (
            !current ||
            current.userId !== user.id ||
            current.status !== MembershipStatus.ACTIVE
          )
            continue;
          membership = current;
        }
        if (!membership.tenantId) continue;
        const tenant = await tenants.get(
          { id: membership.tenantId },
          { cache: false },
        );
        if (tenant?.status === TenantStatus.ACTIVE)
          return {
            user,
            tenantId: membership.tenantId,
            binding: JSON.stringify([user.id, user.profileId]),
          };
      }
      const lastId = active.at(-1)?.id;
      if (active.length < pageSize || !lastId) return null;
      afterId = lastId;
    }
  }
}
