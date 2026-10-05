/**
 * PasswordCredentialService — email + password sign-in for an existing,
 * active user, and the password's lifecycle (#3274).
 *
 * ## Sign-in
 *
 * 1. Normalize the submitted identifier exactly as `User.emailKey` is.
 * 2. Reserve a login attempt: subject = that email key (what the client
 *    typed, never a resolved user), source = the client address.
 * 3. Always run one scrypt verification — against the stored hash, or a
 *    dummy hash when there is no such user or no password — so neither the
 *    response nor its timing says whether the account or credential exists.
 * 4. Require an ACTIVE user and, when a tenant is given, an ACTIVE membership
 *    in it. Never create a user.
 * 5. Mint a first-class session (`authMethod: 'password'`) through
 *    `SessionService.createSession`, then re-check that the credential that
 *    was verified is still the current one (closing the race with a
 *    concurrent change/reset, whose revocation sweep runs after its write).
 * 6. Rehash under the current scrypt policy if the stored parameters are
 *    weaker, as a compare-and-set that never overwrites a newer password.
 *
 * Every refusal other than a rate limit is one {@link PasswordCredentialError}
 * ("Invalid credentials."); a rate limit is {@link LoginRateLimitError}.
 *
 * ## Lifecycle and authority
 *
 * - `setPassword`: the person sets their own FIRST password from any
 *   first-class session, or an administrator holding `managePermission` sets
 *   one for someone else.
 * - `changePassword`: the person replaces their own, proving the current one
 *   (through the limiter, so it is no oracle). Ends every other session of
 *   theirs.
 * - `resetPassword`: an administrator replaces someone else's and, by
 *   default, flags `mustChange`. Ends every session of theirs.
 * - `clearPassword`: an administrator, or the person proving the current one.
 *
 * A layered (device PIN) session never manages passwords, and an
 * administrator may only manage people whose every active membership is in
 * the administrator's session tenant — the credential is one per person
 * across tenants, as the PIN is.
 *
 * @packageDocumentation
 */

import { randomBytes } from 'node:crypto';
import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { withSystemContext } from '@happyvertical/smrt-tenancy';
import { MembershipCollection } from '../collections/MembershipCollection.js';
import { UsersPasswordCredentialCollection } from '../collections/PasswordCredentialCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import type { UsersPasswordCredential } from '../models/PasswordCredential.js';
import {
  DEFAULT_SESSION_TTL,
  SESSION_DATA_KEYS,
  type SessionAuthMethod,
} from '../models/Session.js';
import { normalizeEmail, type User } from '../models/User.js';
import { withoutListBounds } from './authorization-read-options.js';
import {
  hashSecret,
  isValidScryptParams,
  padScryptWork,
  type ScryptParams,
  scryptHashNeedsUpgrade,
  verifySecretHash,
} from './credential-hash.js';
import {
  InvalidCredentialsError,
  LoginAttemptLimiter,
  type LoginAttemptLimiterOptions,
  LoginRateLimitError,
} from './LoginAttemptLimiter.js';
import {
  type PermissionDefinition,
  registerPermissionDefinitions,
} from './PermissionCatalogService.js';
import { type SessionContext, SessionService } from './SessionService.js';

/** Login-limiter kind and session `authMethod` for password sign-ins. */
export const PASSWORD_LOGIN_KIND = 'password';
/** Default permission required to set, reset, or clear another person's password. */
export const DEFAULT_PASSWORD_MANAGE_PERMISSION = 'users.password.manage';
/** Default minimum password length, in characters. */
export const DEFAULT_PASSWORD_MIN_LENGTH = 10;
/** Default maximum password length, in characters. */
export const DEFAULT_PASSWORD_MAX_LENGTH = 256;
/** No configuration may raise the maximum above this: it bounds hashing work. */
export const PASSWORD_MAX_LENGTH_CEILING = 1024;
/** Longest identifier accepted (RFC 5321 path limit). */
const MAX_IDENTIFIER_LENGTH = 320;

/**
 * Built-in denylist: a few of the most common passwords that pass a
 * 10-character minimum. Deliberately small — extend it through
 * `password.denylist` or `password.reject` (a breached-password check, say).
 * Compared case-insensitively.
 */
export const DEFAULT_PASSWORD_DENYLIST: readonly string[] = Object.freeze([
  '1234567890',
  '0123456789',
  '12345678910',
  '1111111111',
  '0000000000',
  'qwertyuiop',
  'password12',
  'password123',
  'password1234',
  'passw0rd123',
  'iloveyou123',
  'letmein123',
  'welcome123',
  'abc1234567',
  'abcdefghij',
  'qwerty1234',
  'qwerty12345',
  '1q2w3e4r5t',
  '1qaz2wsx3edc',
  'zaq12wsxcde',
  'changeme123',
  'administrator',
  'trustno1234',
]);

/** Catalog definition for {@link DEFAULT_PASSWORD_MANAGE_PERMISSION}. */
export const PASSWORD_PERMISSION_DEFINITIONS: PermissionDefinition[] = [
  {
    slug: DEFAULT_PASSWORD_MANAGE_PERMISSION,
    category: 'users',
    name: 'Manage passwords',
    description: "Set, reset, or clear another person's password",
  },
];

let passwordPermissionsRegistered = false;

/** Register the password management permission once when the service is used. */
export function ensurePasswordPermissionsRegistered(): void {
  if (passwordPermissionsRegistered) return;
  passwordPermissionsRegistered = true;
  registerPermissionDefinitions(PASSWORD_PERMISSION_DEFINITIONS);
}

/**
 * Every sign-in refusal that is not a rate limit: unknown identifier, no
 * password, wrong password, inactive user, no membership. One message, so
 * responses cannot enumerate accounts.
 */
export class PasswordCredentialError extends InvalidCredentialsError {
  constructor(message = 'Invalid credentials.') {
    super(message);
    this.name = 'PasswordCredentialError';
  }
}

/** Thrown by set/change/reset/clear when the actor may not manage the password. */
export class PasswordCredentialForbiddenError extends Error {
  constructor(message = 'Not permitted to manage this password.') {
    super(message);
    this.name = 'PasswordCredentialForbiddenError';
  }
}

/** Thrown by set/change/reset when the new password fails policy. */
export class PasswordPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasswordPolicyError';
  }
}

/** What a policy hook can see besides the candidate password. */
export interface PasswordPolicyContext {
  /** The person the password is for. */
  userId: string;
  /** Their normalized email, when they have one. */
  email: string | null;
}

export interface PasswordPolicyOptions {
  /** Minimum length in characters (Unicode code points, after NFKC). Default 10. */
  minLength?: number;
  /**
   * Maximum length in characters. Default 256; may not exceed
   * {@link PASSWORD_MAX_LENGTH_CEILING}. Longer input is refused before any
   * hashing work, at sign-in too.
   */
  maxLength?: number;
  /**
   * Extra passwords to refuse, added to {@link DEFAULT_PASSWORD_DENYLIST}.
   * Compared case-insensitively.
   */
  denylist?: Iterable<string>;
  /**
   * Host hook run after the built-in checks: return a message to refuse the
   * password, or null to accept it. Use it for a breached-password service
   * or shop-specific words. There are deliberately no composition rules.
   */
  reject?: (
    password: string,
    context: PasswordPolicyContext,
  ) => string | null | undefined | Promise<string | null | undefined>;
  /**
   * Server-side secret mixed into every hash. Optional; changing it
   * invalidates every stored password.
   */
  pepper?: string;
  /**
   * scrypt parameters for new hashes. Defaults: N=2^15, r=8, p=1 (32 MiB).
   * A stored hash with weaker parameters is rehashed on the next successful
   * sign-in.
   */
  scrypt?: Partial<ScryptParams>;
}

export interface PasswordCredentialServiceOptions extends SmrtClassOptions {
  /** Lifetime of a password session in seconds. Default seven days. */
  sessionTtl?: number;
  /**
   * Shared {@link LoginAttemptLimiter}. When omitted one is created from
   * `limiter` (or defaults). Supplying the host's instance keeps password,
   * PIN and terminal budgets in one table with one audit sink.
   */
  loginLimiter?: LoginAttemptLimiter;
  /** Options for the private limiter when `loginLimiter` is not supplied. */
  limiter?: Omit<LoginAttemptLimiterOptions, keyof SmrtClassOptions>;
  /** Permission slug an administrator needs to manage others' passwords. */
  managePermission?: string;
  /** Password policy. */
  password?: PasswordPolicyOptions;
}

export interface PasswordSignInInput {
  /** What the person typed as their email; normalized like `User.emailKey`. */
  identifier: string;
  password: string;
  /**
   * Tenant to sign into. When set, the person must hold an ACTIVE membership
   * in it; when null/omitted the session carries no tenant context (and so
   * no tenant permissions) until `switchSessionTenant`.
   */
  tenantId?: string | null;
  ipAddress?: string;
  userAgent?: string;
  /**
   * The session id the client presented before signing in (its old cookie),
   * if any. Revoked after a successful sign-in so a planted or previous
   * session id never survives authentication (session fixation).
   */
  replaceSessionId?: string | null;
}

export interface PasswordSignInResult {
  /** The new session id: the cookie value. Never send it to client script. */
  sessionId: string;
  userId: string;
  tenantId: string | null;
  authMethod: SessionAuthMethod;
  expiresAt: string;
  /**
   * True when an administrator reset the password: the session resolves to
   * no permissions and can only call `changePassword`, which ends it; the
   * person then signs in with the new password.
   */
  mustChange: boolean;
}

export interface SetPasswordInput {
  /** Resolved session of whoever is making the change. */
  actor: SessionContext;
  userId: string;
  password: string;
  ipAddress?: string;
}

export interface ChangePasswordInput {
  /** The person's own session; the password changed is always theirs. */
  actor: SessionContext;
  currentPassword: string;
  newPassword: string;
  ipAddress?: string;
}

export interface ResetPasswordInput {
  actor: SessionContext;
  userId: string;
  password: string;
  /** Require a change at next sign-in. Default true. */
  mustChange?: boolean;
  ipAddress?: string;
}

export interface ClearPasswordInput {
  actor: SessionContext;
  userId: string;
  /** Required when a person clears their own password. */
  currentPassword?: string;
  ipAddress?: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const DEFAULT_SCRYPT: ScryptParams = { N: 2 ** 15, r: 8, p: 1 };

/** NFKC so the same password typed on two keyboards hashes the same. */
function normalizePassword(password: string): string {
  return password.normalize('NFKC');
}

function codePointLength(value: string): number {
  let length = 0;
  for (const _ of value) length++;
  return length;
}

export class PasswordCredentialService {
  private readonly options: PasswordCredentialServiceOptions;
  private readonly sessionTtl: number;
  private readonly managePermission: string;
  private readonly policy: {
    minLength: number;
    maxLength: number;
    denylist: Set<string>;
    reject: PasswordPolicyOptions['reject'];
    pepper: string;
    scrypt: ScryptParams;
  };
  private sessionService!: SessionService;
  private memberships!: MembershipCollection;
  private users!: UserCollection;
  private credentials!: UsersPasswordCredentialCollection;
  private limiter!: LoginAttemptLimiter;
  private dummyHash!: string;

  constructor(options: PasswordCredentialServiceOptions) {
    this.options = options;
    ensurePasswordPermissionsRegistered();
    this.sessionTtl = options.sessionTtl ?? DEFAULT_SESSION_TTL;
    if (!(Number.isFinite(this.sessionTtl) && this.sessionTtl > 0)) {
      throw new Error(
        'PasswordCredentialService sessionTtl must be a positive number.',
      );
    }
    this.managePermission =
      options.managePermission ?? DEFAULT_PASSWORD_MANAGE_PERMISSION;
    const configured = options.password ?? {};
    const minLength = configured.minLength ?? DEFAULT_PASSWORD_MIN_LENGTH;
    const maxLength = configured.maxLength ?? DEFAULT_PASSWORD_MAX_LENGTH;
    if (
      !Number.isSafeInteger(minLength) ||
      !Number.isSafeInteger(maxLength) ||
      minLength < 1 ||
      maxLength < minLength ||
      maxLength > PASSWORD_MAX_LENGTH_CEILING
    ) {
      throw new Error(
        `PasswordCredentialService password length bounds must satisfy 1 <= minLength <= maxLength <= ${PASSWORD_MAX_LENGTH_CEILING}.`,
      );
    }
    const scrypt = { ...DEFAULT_SCRYPT, ...configured.scrypt };
    if (!isValidScryptParams(scrypt)) {
      throw new Error(
        'PasswordCredentialService password.scrypt must be valid scrypt parameters (N a power of two up to 2^20, r <= 32, p <= 16).',
      );
    }
    const denylist = new Set<string>();
    for (const entry of [
      ...DEFAULT_PASSWORD_DENYLIST,
      ...(configured.denylist ?? []),
    ]) {
      if (typeof entry === 'string' && entry) {
        denylist.add(normalizePassword(entry).toLowerCase());
      }
    }
    this.policy = {
      minLength,
      maxLength,
      denylist,
      reject: configured.reject,
      pepper: configured.pepper ?? '',
      scrypt,
    };
  }

  static async create(
    options: PasswordCredentialServiceOptions,
  ): Promise<PasswordCredentialService> {
    const service = new PasswordCredentialService(options);
    await service.initialize();
    return service;
  }

  async initialize(): Promise<void> {
    this.sessionService = await SessionService.create({
      ...this.options,
      defaultTTL: this.sessionTtl,
    });
    // Unbounded: membership reads here back authorization decisions.
    this.memberships = await MembershipCollection.create(
      withoutListBounds(this.options),
    );
    this.users = await UserCollection.create(this.options);
    this.credentials = await UsersPasswordCredentialCollection.create(
      this.options,
    );
    this.limiter =
      this.options.loginLimiter ??
      (await LoginAttemptLimiter.create({
        ...this.options,
        ...this.options.limiter,
      }));
    // Derived once per service under the current policy, so a missing user
    // or credential costs the same scrypt call as a present one.
    this.dummyHash = await hashSecret(
      randomBytes(16).toString('hex'),
      this.policy.pepper,
      this.policy.scrypt,
    );
  }

  /** The limiter in use (shared or private). */
  get loginLimiter(): LoginAttemptLimiter {
    return this.limiter;
  }

  // -------------------------------------------------------------------------
  // Sign in
  // -------------------------------------------------------------------------

  /**
   * Verify an email and password and mint a session. Throws
   * {@link PasswordCredentialError} for every refusal that is not a rate
   * limit and {@link LoginRateLimitError} when the budget is exhausted.
   */
  async signIn(input: PasswordSignInInput): Promise<PasswordSignInResult> {
    const identifier =
      typeof input.identifier === 'string' ? input.identifier : '';
    const emailKey =
      identifier.length <= MAX_IDENTIFIER_LENGTH
        ? normalizeEmail(identifier)
        : '';
    const password = typeof input.password === 'string' ? input.password : '';
    const source = input.ipAddress?.trim() || null;
    // Nothing to key any budget on: refuse like a wrong password. Every other
    // request, malformed or not, reserves before anything else.
    if (!emailKey && !source) throw new PasswordCredentialError();

    const tenantId = input.tenantId || null;
    const lease = await this.limiter.reserve({
      kind: PASSWORD_LOGIN_KIND,
      subject: emailKey || null,
      source,
      // Never the identifier, the user id, or a session id: the subject and
      // source hashes already correlate the attempt.
      metadata: { tenantId },
    });
    if (!lease.allowed) throw new LoginRateLimitError(lease);

    let credentialFailed = false;
    let mintedSessionId: string | null = null;
    try {
      // A missing identifier or password is a failed attempt like any other.
      if (!emailKey || !password) {
        credentialFailed = true;
        throw new PasswordCredentialError();
      }
      const candidate = normalizePassword(password);
      // Longer than any password policy accepts: it cannot be right, so skip
      // the hash rather than let the client choose its cost.
      const tooLong = codePointLength(candidate) > this.policy.maxLength;

      const user = tooLong ? null : await this.findUserByEmailKey(emailKey);
      const credential =
        user?.id && UUID_PATTERN.test(user.id)
          ? await this.credentials.findByUserId(user.id)
          : null;
      const ok = tooLong
        ? false
        : await this.verifyEqualWork(candidate, credential?.passwordHash);
      if (!ok || !credential || !user?.id) {
        credentialFailed = true;
        throw new PasswordCredentialError();
      }
      if (!user.isActive()) {
        credentialFailed = true;
        throw new PasswordCredentialError();
      }
      const userId = user.id;

      if (tenantId) {
        const membership = await this.memberships.findByUserAndTenant(
          userId,
          tenantId,
        );
        if (!membership?.isActive()) {
          credentialFailed = true;
          throw new PasswordCredentialError();
        }
      }

      const mustChange = credential.mustChange === true;
      const now = Date.now();
      const sessionId = await this.sessionService.createSession(
        userId,
        tenantId ?? undefined,
        {
          ttl: this.sessionTtl,
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
          authMethod: PASSWORD_LOGIN_KIND,
          // A temporary password from an administrative reset authenticates
          // the person only far enough to choose a new one: an empty ceiling
          // (no permissions, no bypass), and `changePassword` ends it.
          ...(mustChange && {
            data: { [SESSION_DATA_KEYS.permissionCeiling]: [] },
          }),
        },
      );
      mintedSessionId = sessionId;

      // Bind the session to the credential that was verified: a change,
      // reset or clear that completed while this sign-in was in flight is
      // visible here, or its revocation sweep (which runs after its write)
      // sees this session. The salted hash is unique per write; the one
      // legitimate change that keeps the password is a concurrent sign-in's
      // parameter-upgrade rehash, which keeps the row and its version, so
      // that case is confirmed by verifying the same password again.
      const current = await this.credentials.findByUserId(userId);
      const stillValid =
        current !== null &&
        (current.passwordHash === credential.passwordHash ||
          (current.id === credential.id &&
            current.version === credential.version &&
            (await verifySecretHash(
              candidate,
              this.policy.pepper,
              current.passwordHash,
            ))));
      if (!stillValid) {
        credentialFailed = true;
        throw new PasswordCredentialError();
      }

      await this.upgradeHashIfNeeded(userId, candidate, credential);

      const previous = input.replaceSessionId?.trim();
      if (previous && previous !== sessionId) {
        await this.sessionService
          .destroySession(previous)
          .catch(() => undefined);
      }

      await lease.succeed();
      return {
        sessionId,
        userId,
        tenantId,
        authMethod: PASSWORD_LOGIN_KIND,
        expiresAt: new Date(now + this.sessionTtl * 1000).toISOString(),
        mustChange,
      };
    } catch (error) {
      if (credentialFailed) await lease.fail().catch(() => undefined);
      else await lease.release().catch(() => undefined);
      // Never leave a session behind for a sign-in that reported failure.
      if (mintedSessionId) {
        await this.sessionService
          .destroySession(mintedSessionId)
          .catch(() => undefined);
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Password management
  // -------------------------------------------------------------------------

  /**
   * Set a password where the person has none: the person themself from any
   * first-class session, or an administrator holding `managePermission` for
   * someone else (which, if a password already exists, replaces it and ends
   * every session of theirs like {@link resetPassword} without the
   * must-change flag). A person who already has one uses
   * {@link changePassword}.
   */
  async setPassword(
    input: SetPasswordInput,
  ): Promise<{ revokedSessions: number }> {
    this.assertNotLayered(input.actor);
    const self = input.actor.user.id === input.userId;
    if (!self) await this.assertCanManage(input.actor, input.userId);
    const user = await this.requireUser(input.userId);
    const existing = await this.credentials.findByUserId(input.userId);
    if (self && existing) throw new PasswordCredentialForbiddenError();
    const password = await this.assertPolicy(input.password, user);

    const write = {
      passwordHash: await this.hashPassword(password),
      mustChange: false,
      rotatedAt: new Date(),
      rotatedBy: self ? 'self' : (input.actor.user.id ?? 'admin'),
    };
    let revokedSessions = 0;
    if (self) {
      // Insert-only: a first password never replaces one set concurrently.
      if (!(await this.credentials.insertIfAbsent(input.userId, write))) {
        throw new PasswordCredentialForbiddenError();
      }
    } else if (
      existing ||
      !(await this.credentials.insertIfAbsent(input.userId, write))
    ) {
      // Replacing someone's password — including one set concurrently after
      // the read above — ends their sessions before AND after the write: a
      // failure between the two leaves them signed out, never signed in
      // under a password that is gone.
      revokedSessions += await this.sessionService.destroyAllUserSessions(
        input.userId,
      );
      await this.credentials.upsertForUser(input.userId, write);
      revokedSessions += await this.sessionService.destroyAllUserSessions(
        input.userId,
      );
    }
    await this.recordManagement(input.userId, input.ipAddress, {
      action: 'set',
      self,
      ...(self ? {} : { actorId: input.actor.user.id }),
      revokedSessions,
    });
    return { revokedSessions };
  }

  /**
   * The person changes their own password, proving the current one. Every
   * other session of theirs ends — the reason to change may be that it
   * leaked — and so does this one when it is the restricted session a reset
   * password signed in to.
   */
  async changePassword(
    input: ChangePasswordInput,
  ): Promise<{ revokedSessions: number; endedCurrentSession: boolean }> {
    this.assertNotLayered(input.actor);
    const userId = input.actor.user.id;
    if (!userId) throw new PasswordCredentialForbiddenError();
    const user = await this.requireUser(userId);
    const existing = await this.verifyCurrent(
      user,
      input.currentPassword,
      input.ipAddress,
      'change-password',
    );
    const password = await this.assertPolicy(input.newPassword, user);
    const passwordHash = await this.hashPassword(password);

    // The restricted must-change session has done its one job: end it too,
    // and the person signs in again to get a session with their authority.
    const endedCurrentSession = existing.mustChange;
    const endOthers = () =>
      this.sessionService.destroyAllUserSessions(userId, {
        exceptSessionId: endedCurrentSession
          ? undefined
          : input.actor.sessionId,
      });
    // Sessions end before AND after the write, so a failure between the two
    // never leaves the old password's sessions standing.
    let revokedSessions = await endOthers();
    // Guarded on the exact credential just proved: a reset or other write
    // that landed meanwhile is never overwritten under the old password.
    if (
      !(await this.credentials.replaceIfCurrent(existing, {
        passwordHash,
        rotatedAt: new Date(),
        rotatedBy: 'self',
      }))
    ) {
      throw new PasswordCredentialError();
    }
    revokedSessions += await endOthers();
    await this.recordManagement(userId, input.ipAddress, {
      action: 'change',
      self: true,
      revokedSessions,
    });
    return { revokedSessions, endedCurrentSession };
  }

  /**
   * Administrative reset: replace someone else's password and end every
   * session they hold. `mustChange` (default true) makes the next sign-in a
   * restricted session that can only change the password.
   */
  async resetPassword(
    input: ResetPasswordInput,
  ): Promise<{ revokedSessions: number }> {
    this.assertNotLayered(input.actor);
    // Resetting your own password without the current one is exactly what a
    // hijacked session would do; a person changes their own.
    if (input.actor.user.id === input.userId) {
      throw new PasswordCredentialForbiddenError();
    }
    await this.assertCanManage(input.actor, input.userId);
    const user = await this.requireUser(input.userId);
    const password = await this.assertPolicy(input.password, user);
    const mustChange = input.mustChange ?? true;

    const write = {
      passwordHash: await this.hashPassword(password),
      mustChange,
      rotatedAt: new Date(),
      rotatedBy: input.actor.user.id ?? 'admin',
    };
    // Before AND after the write: a failure between the two leaves the
    // person signed out rather than signed in under the old password.
    let revokedSessions = await this.sessionService.destroyAllUserSessions(
      input.userId,
    );
    await this.credentials.upsertForUser(input.userId, write);
    revokedSessions += await this.sessionService.destroyAllUserSessions(
      input.userId,
    );
    await this.recordManagement(input.userId, input.ipAddress, {
      action: 'reset',
      actorId: input.actor.user.id,
      mustChange,
      revokedSessions,
    });
    return { revokedSessions };
  }

  /**
   * Remove a person's password and end their password sessions. An
   * administrator holding `managePermission`, or the person proving the
   * current password (not from a must-change session).
   */
  async clearPassword(
    input: ClearPasswordInput,
  ): Promise<{ revokedSessions: number }> {
    this.assertNotLayered(input.actor);
    const self = input.actor.user.id === input.userId;
    let proven: UsersPasswordCredential | null = null;
    if (self) {
      const user = await this.requireUser(input.userId);
      proven = await this.verifyCurrent(
        user,
        input.currentPassword ?? '',
        input.ipAddress,
        'clear-password',
      );
      if (proven.mustChange) throw new PasswordCredentialForbiddenError();
    } else {
      await this.assertCanManage(input.actor, input.userId);
    }
    const endPasswordSessions = () =>
      this.sessionService.destroyUserSessionsByAuthMethod(
        input.userId,
        PASSWORD_LOGIN_KIND,
      );
    let revokedSessions = await endPasswordSessions();
    if (proven) {
      // Guarded on the credential just proved (see changePassword).
      if (!(await this.credentials.deleteIfCurrent(proven))) {
        throw new PasswordCredentialError();
      }
    } else {
      await this.credentials.deleteByUserId(input.userId);
    }
    revokedSessions += await endPasswordSessions();
    await this.recordManagement(input.userId, input.ipAddress, {
      action: 'clear',
      self,
      ...(self ? {} : { actorId: input.actor.user.id }),
      revokedSessions,
    });
    return { revokedSessions };
  }

  /** Whether the person has a password (for admin UIs; never for sign-in responses). */
  async hasPassword(userId: string): Promise<boolean> {
    if (!UUID_PATTERN.test(userId)) return false;
    return (await this.credentials.findByUserId(userId)) !== null;
  }

  /**
   * Check a candidate against the policy without storing it — for a form
   * that wants to say "too short" before submitting. Throws
   * {@link PasswordPolicyError}.
   */
  async validatePassword(password: string, userId: string): Promise<void> {
    await this.assertPolicy(password, await this.requireUser(userId));
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async findUserByEmailKey(emailKey: string): Promise<User | null> {
    const [user] = await this.users.list({ where: { emailKey }, limit: 1 });
    return user ?? null;
  }

  private async requireUser(userId: string): Promise<User> {
    const user = UUID_PATTERN.test(userId)
      ? await this.users.get(userId)
      : null;
    if (!user) throw new PasswordCredentialForbiddenError();
    return user;
  }

  /**
   * Prove the current password for a self-service change or clear, through
   * the limiter on the same subject key as sign-in, so these paths cannot be
   * used to guess outside the sign-in budget.
   */
  private async verifyCurrent(
    user: User,
    currentPassword: string,
    ipAddress: string | undefined,
    purpose: string,
  ): Promise<UsersPasswordCredential> {
    if (typeof currentPassword !== 'string' || !currentPassword) {
      throw new PasswordCredentialError();
    }
    const lease = await this.limiter.reserve({
      kind: PASSWORD_LOGIN_KIND,
      subject: user.emailKey || (user.id as string),
      source: ipAddress,
      metadata: { purpose },
    });
    if (!lease.allowed) throw new LoginRateLimitError(lease);
    try {
      const existing = await this.credentials.findByUserId(user.id as string);
      const candidate = normalizePassword(currentPassword);
      const tooLong = codePointLength(candidate) > this.policy.maxLength;
      const ok = tooLong
        ? false
        : await this.verifyEqualWork(candidate, existing?.passwordHash);
      if (!ok || !existing) {
        await lease.fail().catch(() => undefined);
        throw new PasswordCredentialError();
      }
      await lease.succeed().catch(() => undefined);
      return existing;
    } catch (error) {
      if (!(error instanceof PasswordCredentialError)) {
        await lease.release().catch(() => undefined);
      }
      throw error;
    }
  }

  private assertNotLayered(actor: SessionContext): void {
    // A session layered on a shared device (a PIN session) may sit on an
    // unattended tablet: it never manages passwords, its own included.
    if (actor.parent || actor.authMethod === 'pin') {
      throw new PasswordCredentialForbiddenError();
    }
  }

  private async assertCanManage(
    actor: SessionContext,
    targetUserId: string,
  ): Promise<void> {
    if (!actor.permissions.includes(this.managePermission)) {
      throw new PasswordCredentialForbiddenError();
    }
    // `permissions` were resolved for the actor's tenant, so they confer
    // authority only over that tenant's people. The password (and the
    // session sweep a reset triggers) is one per person across every tenant,
    // so the target must be an active member of the actor's tenant AND of
    // no other — otherwise a tenant-A admin could take over a tenant-B
    // account. Unknown, malformed and foreign targets are refused alike.
    // Read outside any ambient tenant filter, like the permission resolver.
    const active =
      actor.tenantId && UUID_PATTERN.test(targetUserId)
        ? (
            await withSystemContext(() =>
              this.memberships.findByUser(targetUserId),
            )
          ).filter((membership) => membership.isActive())
        : [];
    if (
      active.length === 0 ||
      active.some((membership) => membership.tenantId !== actor.tenantId)
    ) {
      throw new PasswordCredentialForbiddenError();
    }
  }

  /** Returns the normalized password to hash, or throws {@link PasswordPolicyError}. */
  private async assertPolicy(password: string, user: User): Promise<string> {
    if (typeof password !== 'string' || !password) {
      throw new PasswordPolicyError('Enter a password.');
    }
    const normalized = normalizePassword(password);
    const length = codePointLength(normalized);
    if (length < this.policy.minLength) {
      throw new PasswordPolicyError(
        `Password must be at least ${this.policy.minLength} characters.`,
      );
    }
    if (length > this.policy.maxLength) {
      throw new PasswordPolicyError(
        `Password must be at most ${this.policy.maxLength} characters.`,
      );
    }
    const folded = normalized.toLowerCase();
    if (this.policy.denylist.has(folded)) {
      throw new PasswordPolicyError(
        'That password is too common. Choose another.',
      );
    }
    const email = user.emailKey || normalizeEmail(user.email) || null;
    if (email && (folded === email || folded === email.split('@')[0])) {
      throw new PasswordPolicyError('Password must not be your email address.');
    }
    if (this.policy.reject) {
      const refusal = await this.policy.reject(normalized, {
        userId: user.id as string,
        email,
      });
      if (refusal) throw new PasswordPolicyError(refusal);
    }
    return normalized;
  }

  private hashPassword(password: string): Promise<string> {
    return hashSecret(password, this.policy.pepper, this.policy.scrypt);
  }

  /**
   * Verify against the stored hash, or the dummy hash when there is none,
   * doing the same scrypt work either way. A stored hash derived under
   * weaker parameters than the current policy (before its upgrade rehash)
   * would otherwise verify faster than the dummy does and reveal that the
   * credential exists, so its verification is padded up to the policy's
   * cost.
   */
  private async verifyEqualWork(
    candidate: string,
    encoded: string | null | undefined,
  ): Promise<boolean> {
    const stored = encoded || this.dummyHash;
    const ok = await verifySecretHash(candidate, this.policy.pepper, stored);
    await padScryptWork(stored, this.policy.scrypt);
    return ok;
  }

  /**
   * Rehash a just-verified password whose stored parameters are below the
   * current policy. Best effort: a failure here must never turn a completed
   * sign-in into an error, and the guarded write never replaces a password
   * that changed after it was verified.
   */
  private async upgradeHashIfNeeded(
    userId: string,
    password: string,
    credential: UsersPasswordCredential,
  ): Promise<void> {
    if (!scryptHashNeedsUpgrade(credential.passwordHash, this.policy.scrypt)) {
      return;
    }
    try {
      const upgraded = await hashSecret(
        password,
        this.policy.pepper,
        this.policy.scrypt,
      );
      await this.credentials.replaceHashIfUnchanged(
        userId,
        credential.passwordHash,
        upgraded,
      );
    } catch {
      // Keep the old (still valid) hash; the next sign-in tries again.
    }
  }

  private async recordManagement(
    userId: string,
    ipAddress: string | undefined,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.limiter.recordManagement({
      kind: PASSWORD_LOGIN_KIND,
      subject: userId,
      source: ipAddress,
      metadata,
    });
  }
}
