/** Source-bound mailbox proof before identity or host destination creation. */
import { createHash } from 'node:crypto';
import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { normalizeIdentityEmail } from '@happyvertical/smrt-profiles';
import { withSystemContext } from '@happyvertical/smrt-tenancy';
import { UserCollection } from '../collections/UserCollection.js';
import { isValidEmail, normalizeEmail } from '../models/User.js';
import { UserStatus } from '../types/index.js';
import { provisionCanonicalMailboxIdentity } from './canonical-mailbox-identity.js';
import type { LoginAttemptLimiter } from './LoginAttemptLimiter.js';
import { MagicLinkError, MagicLinkService } from './MagicLinkService.js';
import {
  assertMailboxSessionCompatibility,
  type MailboxAuthenticationDelivery,
  reserveMailboxRequest,
} from './MailboxAuthenticationService.js';

/** Caller transaction, trusted signing secret and independent root request budget. */
export interface MailboxEnrollmentServiceOptions extends SmrtClassOptions {
  transaction: 'caller';
  secret: string;
  /** Required for request; independently persisted outside caller rollback. */
  loginLimiter?: LoginAttemptLimiter;
}
/** Verified canonical active global identity. No membership or session is minted. */
export interface EnrolledMailbox {
  userId: string;
  profileId: string;
  email: string;
}

/**
 * Host recomputes binding from immutable authorized source data on both calls.
 * Never accept a client-selected binding as authorization. Delivery must reject
 * on failure; delivered proof from a rolled-back request cannot authenticate.
 * Completion and all destination writes must share the caller transaction.
 */
export class MailboxEnrollmentService {
  private constructor(
    private readonly options: SmrtClassOptions,
    private readonly auth: {
      secret: string;
      loginLimiter?: LoginAttemptLimiter;
    },
  ) {}

  /** Bind an initialized caller executor; never opens a nested transaction. */
  static async create(options: MailboxEnrollmentServiceOptions) {
    if (!options.db || options.transaction !== 'caller' || !options.secret)
      throw new Error(
        'Mailbox enrollment requires a signing secret and caller-owned transaction',
      );
    return new MailboxEnrollmentService(
      {
        db: options.db,
        _reuseInitializedDb: true,
        _deferRuntimeInitialization: true,
      },
      { secret: options.secret, loginLimiter: options.loginLimiter },
    );
  }

  /** Mail a proof only; never creates a Person, User, membership or session. */
  async request(input: {
    email: string;
    binding: string;
    sourceKey: string;
    deliver: MailboxAuthenticationDelivery;
  }): Promise<{ requested: true }> {
    const subject = bindingSubject(input.binding);
    if (typeof input.deliver !== 'function')
      throw new Error('Mailbox enrollment delivery is required');
    await reserveMailboxRequest({
      subject: normalizeEmail(input.email),
      sourceKey: input.sourceKey,
      limiter: this.auth.loginLimiter,
    });
    if (!isValidEmail(input.email)) return { requested: true };
    return await withSystemContext(async () => {
      const email = normalizeIdentityEmail(input.email);
      const proof = await (await this.links()).generate(email, { subject });
      await input.deliver({ email, ...proof });
      return { requested: true };
    });
  }

  /** Verify exact source and actor, then consume and provision atomically. */
  async authenticate(input: {
    token: string;
    binding: string;
    expectedUserId?: string;
    sessionId?: string;
  }): Promise<EnrolledMailbox> {
    const subject = bindingSubject(input.binding);
    return await withSystemContext(async () => {
      const links = await this.links();
      const proof = await links.inspect(input.token);
      if (proof.subject !== subject)
        throw new MagicLinkError('Mailbox enrollment source does not match');
      const existing = await (
        await UserCollection.create(this.options)
      ).findCanonicalByEmail(proof.email);
      if (input.expectedUserId !== undefined || input.sessionId !== undefined) {
        if (!existing?.id)
          throw new MagicLinkError('Sign-in identity does not match');
        await assertMailboxSessionCompatibility(this.options, {
          userId: existing.id,
          expectedUserId: input.expectedUserId,
          sessionId: input.sessionId,
        });
      }
      // Claim first: competing consumers of this proof cannot provision identities.
      await links.verify(input.token);
      const { user, profileId } = await provisionCanonicalMailboxIdentity(
        this.options,
        {
          email: proof.email,
          status: UserStatus.ACTIVE,
          allowPending: false,
          lock: true,
          refuse: (message) => new MagicLinkError(message),
        },
      );
      if (!user.id)
        throw new MagicLinkError('Mailbox enrollment identity is unavailable');
      // Recheck actor after locking canonical identity, before host authority writes.
      await assertMailboxSessionCompatibility(this.options, {
        userId: user.id,
        expectedUserId: input.expectedUserId,
        sessionId: input.sessionId,
      });
      user.recordLogin();
      await user.save();
      return {
        userId: user.id,
        profileId,
        email: normalizeIdentityEmail(user.email),
      };
    });
  }
  private async links() {
    return await MagicLinkService.create({
      ...this.options,
      secret: this.auth.secret,
      tokenExpiry: 600,
      issuer: 'smrt:mailbox-enrollment:v1',
    });
  }
}
function bindingSubject(binding: string): string {
  if (typeof binding !== 'string' || !binding.trim())
    throw new MagicLinkError('Mailbox enrollment source binding is required');
  return createHash('sha256').update(binding).digest('hex');
}
