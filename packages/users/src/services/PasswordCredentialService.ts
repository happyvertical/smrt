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
 * - `replaceForgottenPassword`: the person replaces their own WITHOUT the
 *   current one, from a fresh session the host minted after verifying an
 *   out-of-band proof (#3905). Off unless `recovery` is configured. Ends every
 *   session of theirs, this one included, so the proof is single use.
 *
 * A layered (device PIN) session never manages passwords, and an
 * administrator may only manage people whose every active membership is in
 * the administrator's session tenant — the credential is one per person
 * across tenants, as the PIN is.
 *
 * @packageDocumentation
 */

import { randomBytes } from 'node:crypto';
import {
  isEmbeddedDatabase,
  type SmrtClassOptions,
  withEmbeddedWriteTransaction,
} from '@happyvertical/smrt-core';
import { withSystemContext } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { MembershipCollection } from '../collections/MembershipCollection.js';
import { UsersPasswordCredentialCollection } from '../collections/PasswordCredentialCollection.js';
import { SessionCollection } from '../collections/SessionCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import type { UsersPasswordCredential } from '../models/PasswordCredential.js';
import {
  DEFAULT_SESSION_TTL,
  SESSION_DATA_KEYS,
  type SessionAuthMethod,
} from '../models/Session.js';
import {
  normalizeEmail,
  normalizeUsername,
  type User,
} from '../models/User.js';
import { SessionStatus } from '../types/index.js';
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
/** Default freshness bound for an out-of-band recovery proof (10 minutes). */
export const DEFAULT_PASSWORD_RECOVERY_MAX_AGE_SECONDS = 10 * 60;
/** No configuration may accept an out-of-band proof older than this (1 hour). */
export const PASSWORD_RECOVERY_MAX_AGE_CEILING_SECONDS = 60 * 60;
/** Clock skew tolerated for a proof stamped slightly in the future. */
const RECOVERY_CLOCK_SKEW_MS = 30 * 1000;
/** Session channels that can never stand in for an out-of-band proof. */
const NON_RECOVERY_AUTH_METHODS: ReadonlySet<string> = new Set([
  PASSWORD_LOGIN_KIND,
  'pin',
]);
/** Longest identifier accepted (RFC 5321 path limit). */
const MAX_IDENTIFIER_LENGTH = 320;

type LoginIdentity = Readonly<{
  kind: 'email' | 'username';
  key: string;
}>;

/**
 * `@` is reserved to email identities; valid usernames cannot contain it.
 * This keeps the public password identifier unambiguous without a tenant or
 * family locator.
 */
function normalizeLoginIdentifier(identifier: string): LoginIdentity | null {
  if (identifier.includes('@')) {
    const key = normalizeEmail(identifier);
    return key ? { kind: 'email', key } : null;
  }
  const key = normalizeUsername(identifier);
  return key ? { kind: 'username', key } : null;
}

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
  /** Their canonical username, when they have one. */
  username: string | null;
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

/**
 * Session data a host's recovery flow passes to `createSession({ data })`
 * after it has verified an out-of-band proof (#3905): it stamps when the
 * proof was verified, which `replaceForgottenPassword` checks for freshness.
 * Never derive `provenAt` from client input.
 */
export function outOfBandProofSessionData(
  provenAt: Date = new Date(),
): Record<string, string> {
  if (Number.isNaN(provenAt.getTime())) {
    throw new Error('outOfBandProofSessionData needs a valid date.');
  }
  return { [SESSION_DATA_KEYS.outOfBandProofAt]: provenAt.toISOString() };
}

/** What the host's recovery assertion is shown. */
export interface PasswordRecoveryProofContext {
  /** The actor the call was made with; its session row has already passed every check. */
  actor: SessionContext;
  /** When the out-of-band proof was verified (the session's stamp). */
  provenAt: Date;
}

/**
 * Self-service replacement of a forgotten password (#3905). Every condition
 * must hold, and any doubt refuses:
 *
 * - the actor's stored session is first-class (not layered, no permission
 *   ceiling), still valid, and belongs to the person;
 * - its server-set `authMethod` is one of `authMethods`, which the host mints
 *   ONLY after verifying an out-of-band proof (never `password` or `pin`);
 * - it carries a `SESSION_DATA_KEYS.outOfBandProofAt` stamp (see
 *   {@link outOfBandProofSessionData}) no older than `maxAgeSeconds`;
 * - `assertProof`, when given, returns true.
 */
export interface PasswordRecoveryOptions {
  /** Session `authMethod`s the host mints only from an out-of-band proof. */
  authMethods: readonly SessionAuthMethod[];
  /**
   * Oldest accepted proof, in seconds. Default
   * {@link DEFAULT_PASSWORD_RECOVERY_MAX_AGE_SECONDS}; at most
   * {@link PASSWORD_RECOVERY_MAX_AGE_CEILING_SECONDS}.
   */
  maxAgeSeconds?: number;
  /**
   * Optional host check run after the package's own, e.g. that the proof was
   * a recovery link rather than an ordinary sign-in link. Anything but
   * `true` refuses.
   */
  assertProof?: (
    context: PasswordRecoveryProofContext,
  ) => boolean | Promise<boolean>;
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
  /**
   * Enables {@link PasswordCredentialService.replaceForgottenPassword}.
   * Omitted: there is no way to replace a password without the current one
   * except an administrator's reset.
   */
  recovery?: PasswordRecoveryOptions;
}

export interface PasswordSignInInput {
  /** What the person typed as an email or username. */
  identifier: string;
  password: string;
  /**
   * Tenant to sign into. When set, the person must hold an ACTIVE membership
   * in it; when null/omitted the session carries no tenant context (and so
   * no tenant permissions) until `switchSessionTenant`.
   */
  tenantId?: string | null | 'unique-active-membership';
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

export interface ReplaceForgottenPasswordInput {
  /** The person's own session, minted by the host's recovery flow. */
  actor: SessionContext;
  newPassword: string;
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
  private readonly recovery: {
    authMethods: ReadonlySet<string>;
    maxAgeMs: number;
    assertProof: PasswordRecoveryOptions['assertProof'];
  } | null;
  private sessionService!: SessionService;
  private sessionRows!: SessionCollection;
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
    this.recovery = options.recovery
      ? PasswordCredentialService.resolveRecovery(options.recovery)
      : null;
  }

  private static resolveRecovery(recovery: PasswordRecoveryOptions) {
    const methods = Array.isArray(recovery.authMethods)
      ? recovery.authMethods
      : [];
    if (
      methods.length === 0 ||
      methods.some(
        (method) =>
          typeof method !== 'string' ||
          !method.trim() ||
          NON_RECOVERY_AUTH_METHODS.has(method),
      )
    ) {
      throw new Error(
        'PasswordCredentialService recovery.authMethods must list the out-of-band session methods (never password or pin).',
      );
    }
    const maxAgeSeconds =
      recovery.maxAgeSeconds ?? DEFAULT_PASSWORD_RECOVERY_MAX_AGE_SECONDS;
    if (
      !(Number.isFinite(maxAgeSeconds) && maxAgeSeconds > 0) ||
      maxAgeSeconds > PASSWORD_RECOVERY_MAX_AGE_CEILING_SECONDS
    ) {
      throw new Error(
        `PasswordCredentialService recovery.maxAgeSeconds must be positive and at most ${PASSWORD_RECOVERY_MAX_AGE_CEILING_SECONDS}.`,
      );
    }
    if (
      recovery.assertProof !== undefined &&
      typeof recovery.assertProof !== 'function'
    ) {
      throw new Error(
        'PasswordCredentialService recovery.assertProof must be a function.',
      );
    }
    return {
      authMethods: new Set<string>(methods),
      maxAgeMs: maxAgeSeconds * 1000,
      assertProof: recovery.assertProof,
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
    this.sessionRows = await SessionCollection.create(this.options);
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
    const identity =
      identifier.length <= MAX_IDENTIFIER_LENGTH
        ? normalizeLoginIdentifier(identifier)
        : null;
    const password = typeof input.password === 'string' ? input.password : '';
    const source = input.ipAddress?.trim() || null;
    // Nothing to key any budget on (a disabled source budget keys nothing):
    // refuse like a wrong password. Every other request, malformed or not,
    // reserves before anything else.
    if (!identity && !(source && this.limiter.limitsSource)) {
      throw new PasswordCredentialError();
    }

    const requestedTenantId = input.tenantId || null;
    const lease = await this.limiter.reserve({
      kind: PASSWORD_LOGIN_KIND,
      subject: identity?.key || null,
      source,
      // Never the identifier, the user id, or a session id: the subject and
      // source hashes already correlate the attempt.
      metadata: {
        tenantId:
          requestedTenantId === 'unique-active-membership'
            ? null
            : requestedTenantId,
      },
    });
    if (!lease.allowed) throw new LoginRateLimitError(lease);

    let credentialFailed = false;
    let mintedSessionId: string | null = null;
    try {
      // A missing identifier or password is a failed attempt like any other.
      if (!identity || !password) {
        credentialFailed = true;
        throw new PasswordCredentialError();
      }
      const candidate = normalizePassword(password);
      // Longer than any password policy accepts: it cannot be right, so skip
      // the hash rather than let the client choose its cost.
      const tooLong = codePointLength(candidate) > this.policy.maxLength;

      const user = tooLong ? null : await this.findUserByIdentity(identity);
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

      const tenantId =
        requestedTenantId === 'unique-active-membership'
          ? await this.resolveUniqueActiveMembershipTenant(userId)
          : requestedTenantId;
      if (!tenantId && requestedTenantId === 'unique-active-membership') {
        credentialFailed = true;
        throw new PasswordCredentialError();
      }
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

  /**
   * The person replaces a forgotten password from a fresh session the host
   * minted after verifying an out-of-band proof (#3905); see
   * {@link PasswordRecoveryOptions} for every condition. Works whether or not
   * a password exists, clears `mustChange`, and ends EVERY session of the
   * person before and after the write. The recovery session is consumed by a
   * conditional update in the same transaction as the guarded credential
   * write, so of any concurrent uses of one proof exactly one can succeed
   * (and a failed write leaves the proof unconsumed). Refusals are
   * {@link PasswordCredentialForbiddenError};
   * a write that lost a race with another change is
   * {@link PasswordCredentialError}.
   */
  async replaceForgottenPassword(
    input: ReplaceForgottenPasswordInput,
  ): Promise<{ revokedSessions: number; endedCurrentSession: true }> {
    const recovery = this.recovery;
    if (!recovery) throw new PasswordCredentialForbiddenError();
    this.assertNotLayered(input.actor);
    const userId = input.actor.user?.id;
    if (!userId || !UUID_PATTERN.test(userId)) {
      throw new PasswordCredentialForbiddenError();
    }
    // Decide on the stored session, never on the caller-built context: the
    // channel, ownership, layering, ceiling and stamp are all server-set.
    const session =
      typeof input.actor.sessionId === 'string' &&
      UUID_PATTERN.test(input.actor.sessionId)
        ? await this.sessionRows.findValidSession(input.actor.sessionId)
        : null;
    const now = Date.now();
    const stamp = session?.getData<unknown>(SESSION_DATA_KEYS.outOfBandProofAt);
    const provenAtMs =
      typeof stamp === 'string' ? Date.parse(stamp) : Number.NaN;
    if (
      !session ||
      session.userId !== userId ||
      session.parentSessionId ||
      session.getPermissionCeiling() !== null ||
      typeof session.authMethod !== 'string' ||
      NON_RECOVERY_AUTH_METHODS.has(session.authMethod) ||
      !recovery.authMethods.has(session.authMethod) ||
      !Number.isFinite(provenAtMs) ||
      provenAtMs > now + RECOVERY_CLOCK_SKEW_MS ||
      now - provenAtMs > recovery.maxAgeMs
    ) {
      throw new PasswordCredentialForbiddenError();
    }
    const user = await this.requireUser(userId);
    if (!user.isActive()) throw new PasswordCredentialForbiddenError();
    // The credential the proof is about, read BEFORE any slow work: a
    // concurrent use of the same proof that wins writes a new generation,
    // so this one's guarded write below can never replace it.
    const existing = await this.credentials.findByUserId(userId);
    const provenAt = new Date(provenAtMs);
    if (
      recovery.assertProof &&
      (await recovery.assertProof({ actor: input.actor, provenAt })) !== true
    ) {
      throw new PasswordCredentialForbiddenError();
    }
    const password = await this.assertPolicy(input.newPassword, user);
    const passwordHash = await this.hashPassword(password);

    const recoverySessionId = input.actor.sessionId;
    // Before AND after the write: a failure between the two leaves the
    // person signed out, never signed in under a password that is gone. The
    // recovery session itself is consumed inside the write transaction.
    let revokedSessions = await this.sessionService.destroyAllUserSessions(
      userId,
      { exceptSessionId: recoverySessionId },
    );
    const write = {
      passwordHash,
      mustChange: false,
      rotatedAt: new Date(),
      rotatedBy: 'self-recovery',
    };
    const db = this.credentials.db as DatabaseInterface;
    await withEmbeddedWriteTransaction(
      db,
      isEmbeddedDatabase(db),
      async (tx) => {
        // Consume the proof: one conditional update that only the first of
        // any concurrent uses can make. A second request validated the same
        // session but finds it no longer active and is refused.
        const sessionTable = this.sessionRows.tableName;
        const nowIso = new Date().toISOString();
        const consumed = await tx.query(
          `UPDATE ${sessionTable}
              SET status = ?, updated_at = ?
            WHERE id = ? AND user_id = ? AND status = ? AND expires_at > ?
            RETURNING id`,
          SessionStatus.REVOKED,
          nowIso,
          recoverySessionId,
          userId,
          SessionStatus.ACTIVE,
          nowIso,
        );
        if (consumed.rows?.length !== 1) {
          throw new PasswordCredentialForbiddenError();
        }
        // Guarded on the row read before hashing; a failure rolls the
        // consumption back with it.
        const credentials = await UsersPasswordCredentialCollection.create({
          ...this.options,
          db: tx,
        });
        const written = existing
          ? await credentials.replaceIfCurrent(existing, write)
          : (await credentials.insertIfAbsent(userId, write)) !== null;
        if (!written) throw new PasswordCredentialError();
      },
      true,
    );
    revokedSessions += 1;
    revokedSessions += await this.sessionService.destroyAllUserSessions(userId);
    await this.recordManagement(userId, input.ipAddress, {
      action: 'recover',
      self: true,
      authMethod: session.authMethod,
      proofAgeSeconds: Math.max(0, Math.round((now - provenAtMs) / 1000)),
      replaced: existing !== null,
      revokedSessions,
    });
    return { revokedSessions, endedCurrentSession: true };
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

  private async findUserByIdentity(
    identity: LoginIdentity,
  ): Promise<User | null> {
    const [user] = await this.users.list({
      where:
        identity.kind === 'email'
          ? { emailKey: identity.key }
          : { usernameKey: identity.key },
      limit: 1,
    });
    return user ?? null;
  }

  /**
   * Select a tenant only when a password-authenticated person has exactly one
   * active direct membership. This is resolved after credential verification:
   * callers never need a tenant locator before sign-in, and ambiguity cannot
   * turn a successful password check into an unscoped session.
   */
  private async resolveUniqueActiveMembershipTenant(
    userId: string,
  ): Promise<string | null> {
    const memberships = await this.memberships.findActiveByUser(userId);
    return memberships.length === 1 && memberships[0]?.tenantId
      ? memberships[0].tenantId
      : null;
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
    const username =
      user.usernameKey || normalizeUsername(user.username) || null;
    if (username && folded === username) {
      throw new PasswordPolicyError('Password must not be your username.');
    }
    if (this.policy.reject) {
      const refusal = await this.policy.reject(normalized, {
        userId: user.id as string,
        email,
        username,
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
