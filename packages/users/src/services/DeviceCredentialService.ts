/**
 * DeviceCredentialService — per-person sign-in on an enrolled device,
 * layered on the device's own bearer session (#3276).
 *
 * ## The problem
 *
 * A shared tablet is enrolled once through the terminal device-code grant and
 * holds a long-lived bearer session bound to a *device* account. Everything
 * done on it is attributed to that account. This service lets a person
 * present a short credential (a PIN today; a fob or badge later) **on that
 * device only**, and mints a short-lived session for the person that is
 * valid exactly as long as the device session is.
 *
 * ## The pipeline (shared by every credential kind)
 *
 * 1. Resolve the device bearer token to a live session and require that it
 *    was established by device enrollment (`authMethod === 'terminal'` by
 *    default) and is not itself a layered session.
 * 2. Ask the host whether this device is still enrolled and active
 *    (`assertEnrolledDevice`) — smrt-users does not own a Device object.
 * 3. Reserve a login attempt: subject = whatever the verifier derives from
 *    the input, source = the device account.
 * 4. Run the credential verifier. It must do equal work for a missing and a
 *    present credential.
 * 5. Require the person to hold an active membership in the device session's
 *    tenant — a device credential never widens tenant scope.
 * 6. Mint the person's session with `authMethod = verifier.kind` and
 *    `parentSessionId = device session`, and return its id. The client sends
 *    that id as its bearer from then on; `SessionService.loadSessionContext`
 *    enforces parent liveness and exposes `parent` for host gates.
 *
 * Anything that is not an enrolled-device bearer session — a browser cookie
 * session, a mobile session, a layered session — is refused before any
 * credential work, with the same error a wrong credential produces.
 *
 * ## Adding a credential kind
 *
 * Implement {@link DeviceCredentialVerifier} and pass it to
 * {@link DeviceCredentialService.signIn}. {@link PinVerifier} is the
 * reference implementation. A fob verifier differs mainly in that the
 * subject is unknown until the tag is read, which is why `subjectKey` lives
 * on the verifier.
 *
 * @packageDocumentation
 */

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { MembershipCollection } from '../collections/MembershipCollection.js';
import { UsersPinCredentialCollection } from '../collections/PinCredentialCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import type { UsersPinCredential } from '../models/PinCredential.js';
import type { SessionAuthMethod } from '../models/Session.js';
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

/** Default lifetime of a per-person device session (8 hours — a shift). */
export const DEFAULT_DEVICE_CREDENTIAL_SESSION_TTL_SECONDS = 8 * 60 * 60;
/** Default permission required to set, reset, or clear another person's PIN. */
export const DEFAULT_PIN_MANAGE_PERMISSION = 'users.pin.manage';
/** Login-limiter kind reported for PIN attempts. */
export const PIN_LOGIN_KIND = 'pin';

/** Catalog definition for {@link DEFAULT_PIN_MANAGE_PERMISSION}. */
export const PIN_PERMISSION_DEFINITIONS: PermissionDefinition[] = [
  {
    slug: DEFAULT_PIN_MANAGE_PERMISSION,
    category: 'users',
    name: 'Manage device PINs',
    description: "Set, reset, or clear another person's device PIN",
  },
];

let pinPermissionsRegistered = false;

/** Register the PIN management permission once when the service is used. */
export function ensurePinPermissionsRegistered(): void {
  if (pinPermissionsRegistered) return;
  pinPermissionsRegistered = true;
  registerPermissionDefinitions(PIN_PERMISSION_DEFINITIONS);
}

/** Thrown when the caller is not an enrolled device, or the credential is wrong. */
export class DeviceCredentialError extends InvalidCredentialsError {
  constructor(message = 'Invalid credentials.') {
    super(message);
    this.name = 'DeviceCredentialError';
  }
}

/** Thrown by set/reset/clear when the actor may not manage the credential. */
export class DeviceCredentialForbiddenError extends Error {
  constructor(message = 'Not permitted to manage this credential.') {
    super(message);
    this.name = 'DeviceCredentialForbiddenError';
  }
}

/** Thrown by set/reset when the new secret fails policy. */
export class DeviceCredentialPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceCredentialPolicyError';
  }
}

/** Everything a verifier gets to see about the device the attempt came from. */
export interface DeviceSignInContext {
  /** The enrolled device's resolved bearer session. */
  device: SessionContext;
}

/**
 * One credential kind. Implementations must do equal work whether or not a
 * credential is enrolled for the subject (compare against a dummy hash).
 */
export interface DeviceCredentialVerifier<Input> {
  /** Becomes `authMethod` on the minted session and the limiter's audit kind. */
  readonly kind: SessionAuthMethod;
  /** The identifier the limiter keys the subject budget on. */
  subjectKey(input: Input): string;
  /** Returns the authenticated user id, or null for any failure. */
  verify(
    input: Input,
    context: DeviceSignInContext,
  ): Promise<{ userId: string } | null>;
}

export interface DeviceCredentialServiceOptions extends SmrtClassOptions {
  /**
   * Cookie name passed to the {@link SessionService}; should match the host's
   * session cookie so one service resolves cookies and bearers alike.
   */
  sessionCookieName?: string;
  /** Lifetime of the person's session. Defaults to {@link DEFAULT_DEVICE_CREDENTIAL_SESSION_TTL_SECONDS}. */
  personSessionTtlSeconds?: number;
  /** Whether the person's session extends on activity. Defaults to true. */
  personSessionAutoExtend?: boolean;
  /**
   * Auth methods that count as an enrolled device session. Defaults to
   * `['terminal']` — the device-code grant is how devices enrol.
   */
  deviceAuthMethods?: SessionAuthMethod[];
  /**
   * Host hook: throw (or return false) when the device session's account is
   * not an enrolled, active device. smrt-users guarantees only that the
   * bearer is a live, non-layered device-enrolled session; whether that
   * device is still active is the host's data. Required.
   */
  assertEnrolledDevice: (device: SessionContext) => Promise<boolean | void>;
  /**
   * Shared {@link LoginAttemptLimiter}. When omitted one is created from
   * `limiter` (or defaults). Supplying the host's instance keeps PIN,
   * password and terminal budgets in one table with one audit sink.
   */
  loginLimiter?: LoginAttemptLimiter;
  /** Options for the private limiter when `loginLimiter` is not supplied. */
  limiter?: Omit<LoginAttemptLimiterOptions, keyof SmrtClassOptions>;
  /** Permission slug an administrator needs to manage others' PINs. */
  managePermission?: string;
  /** PIN policy. */
  pin?: PinPolicyOptions;
}

export interface PinPolicyOptions {
  /** Minimum digits. Default 4. */
  minLength?: number;
  /** Maximum digits. Default 8. */
  maxLength?: number;
  /**
   * Server-side secret mixed into every hash. Strongly recommended: a 4–8
   * digit secret is only as strong as the pepper once the table leaks.
   */
  pepper?: string;
  /** Reject repeated and sequential digits (`0000`, `1234`, `9876`). Default true. */
  rejectTrivial?: boolean;
  /** scrypt parameters. Defaults: N=2^15, r=8, p=1. */
  scrypt?: { N?: number; r?: number; p?: number };
}

export interface DeviceSignInInput {
  /** The device's bearer token (`Authorization: Bearer …`). */
  deviceToken: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface DeviceSignInResult {
  /** The person's session id — the new bearer for person-attributed work. */
  sessionId: string;
  userId: string;
  tenantId: string | null;
  authMethod: SessionAuthMethod;
  expiresAt: string;
  /** True when the person must choose a new PIN before continuing. */
  mustReset: boolean;
}

export interface PinSignInInput extends DeviceSignInInput {
  userId: string;
  pin: string;
}

export interface SetPinInput {
  /** Resolved session of whoever is making the change. */
  actor: SessionContext;
  userId: string;
  pin: string;
  /** Required when a person changes their own PIN from a PIN session. */
  currentPin?: string;
  ipAddress?: string;
}

export interface ResetPinInput {
  actor: SessionContext;
  userId: string;
  pin: string;
  ipAddress?: string;
}

export interface ClearPinInput {
  actor: SessionContext;
  userId: string;
  ipAddress?: string;
}

// ---------------------------------------------------------------------------
// PIN hashing
// ---------------------------------------------------------------------------

interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

const DEFAULT_SCRYPT: ScryptParams = { N: 2 ** 15, r: 8, p: 1 };
const HASH_BYTES = 32;

async function hashPin(
  pin: string,
  pepper: string,
  params: ScryptParams,
  salt: Buffer = randomBytes(16),
): Promise<string> {
  const derived = await new Promise<Buffer>((resolve, reject) => {
    scrypt(
      `${pepper}\u0000${pin}`,
      salt,
      HASH_BYTES,
      {
        N: params.N,
        r: params.r,
        p: params.p,
        // Node's default maxmem (32 MiB) is below 128·N·r for the default
        // parameters; allow headroom so the derivation never throws.
        maxmem: 128 * params.N * params.r * 2,
      },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

async function verifyPinHash(
  pin: string,
  pepper: string,
  encoded: string,
): Promise<boolean> {
  const [scheme, N, r, p, saltB64, hashB64] = encoded.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const params = { N: Number(N), r: Number(r), p: Number(p) };
  if (![params.N, params.r, params.p].every(Number.isFinite)) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const candidate = await hashPin(
    pin,
    pepper,
    params,
    Buffer.from(saltB64, 'base64'),
  );
  const actual = Buffer.from(candidate.split('$')[5] ?? '', 'base64');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function isTrivialPin(pin: string): boolean {
  if (/^(\d)\1+$/u.test(pin)) return true;
  let ascending = true;
  let descending = true;
  for (let i = 1; i < pin.length; i++) {
    const diff = pin.charCodeAt(i) - pin.charCodeAt(i - 1);
    if (diff !== 1) ascending = false;
    if (diff !== -1) descending = false;
  }
  return ascending || descending;
}

// ---------------------------------------------------------------------------
// PIN verifier
// ---------------------------------------------------------------------------

/**
 * Reference {@link DeviceCredentialVerifier}: `{ userId, pin }` against
 * {@link UsersPinCredential}. Always runs scrypt, against a precomputed dummy
 * hash when the user has no PIN, so timing does not reveal enrollment.
 */
export class PinVerifier implements DeviceCredentialVerifier<PinSignInInput> {
  readonly kind: SessionAuthMethod = PIN_LOGIN_KIND;

  constructor(
    private readonly credentials: UsersPinCredentialCollection,
    private readonly pepper: string,
    private readonly dummyHash: string,
  ) {}

  subjectKey(input: PinSignInInput): string {
    return input.userId;
  }

  async verify(input: PinSignInInput): Promise<{ userId: string } | null> {
    const credential = await this.credentials.findByUserId(input.userId);
    const encoded = credential?.pinHash || this.dummyHash;
    const ok = await verifyPinHash(input.pin, this.pepper, encoded);
    return ok && credential ? { userId: credential.userId } : null;
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class DeviceCredentialService {
  private readonly options: DeviceCredentialServiceOptions;
  private readonly personSessionTtlSeconds: number;
  private readonly deviceAuthMethods: Set<string>;
  private readonly managePermission: string;
  private readonly pinPolicy: Required<
    Omit<PinPolicyOptions, 'scrypt' | 'pepper'>
  > & {
    pepper: string;
    scrypt: ScryptParams;
  };
  private sessionService!: SessionService;
  /**
   * Resolves *other* sessions (the device bearer, an actor) without touching
   * their expiry: `sessionService` auto-extends with the person-session TTL,
   * which must never be applied to a device session with its own lifetime.
   */
  private readonlySessionService!: SessionService;
  private memberships!: MembershipCollection;
  private users!: UserCollection;
  private pinCredentials!: UsersPinCredentialCollection;
  private limiter!: LoginAttemptLimiter;
  private pinVerifier!: PinVerifier;

  constructor(options: DeviceCredentialServiceOptions) {
    if (typeof options.assertEnrolledDevice !== 'function') {
      throw new Error(
        'DeviceCredentialService requires an assertEnrolledDevice hook.',
      );
    }
    this.options = options;
    ensurePinPermissionsRegistered();
    this.personSessionTtlSeconds =
      options.personSessionTtlSeconds ??
      DEFAULT_DEVICE_CREDENTIAL_SESSION_TTL_SECONDS;
    this.deviceAuthMethods = new Set(options.deviceAuthMethods ?? ['terminal']);
    this.managePermission =
      options.managePermission ?? DEFAULT_PIN_MANAGE_PERMISSION;
    this.pinPolicy = {
      minLength: options.pin?.minLength ?? 4,
      maxLength: options.pin?.maxLength ?? 8,
      rejectTrivial: options.pin?.rejectTrivial ?? true,
      pepper: options.pin?.pepper ?? '',
      scrypt: { ...DEFAULT_SCRYPT, ...options.pin?.scrypt },
    };
  }

  static async create(
    options: DeviceCredentialServiceOptions,
  ): Promise<DeviceCredentialService> {
    const service = new DeviceCredentialService(options);
    await service.initialize();
    return service;
  }

  async initialize(): Promise<void> {
    this.sessionService = await SessionService.create({
      ...this.options,
      autoExtend: this.options.personSessionAutoExtend ?? true,
      cookieName: this.options.sessionCookieName,
      defaultTTL: this.personSessionTtlSeconds,
    });
    this.readonlySessionService = await SessionService.create({
      ...this.options,
      autoExtend: false,
      cookieName: this.options.sessionCookieName,
    });
    this.memberships = await MembershipCollection.create(this.options);
    this.users = await UserCollection.create(this.options);
    this.pinCredentials = await UsersPinCredentialCollection.create(
      this.options,
    );
    this.limiter =
      this.options.loginLimiter ??
      (await LoginAttemptLimiter.create({
        ...this.options,
        ...this.options.limiter,
      }));
    // The dummy hash is derived once per service so a missing credential
    // costs the same scrypt call as a present one.
    const dummy = await hashPin(
      randomBytes(8).toString('hex'),
      this.pinPolicy.pepper,
      this.pinPolicy.scrypt,
    );
    this.pinVerifier = new PinVerifier(
      this.pinCredentials,
      this.pinPolicy.pepper,
      dummy,
    );
  }

  /** The reference PIN verifier bound to this service's policy. */
  get pin(): PinVerifier {
    return this.pinVerifier;
  }

  /** The limiter in use (shared or private), for hosts that add verifiers. */
  get loginLimiter(): LoginAttemptLimiter {
    return this.limiter;
  }

  // -------------------------------------------------------------------------
  // Sign in
  // -------------------------------------------------------------------------

  /** PIN sign-in: {@link signIn} with the built-in {@link PinVerifier}. */
  async signInWithPin(input: PinSignInInput): Promise<DeviceSignInResult> {
    return this.signIn(this.pinVerifier, input);
  }

  /**
   * Generic sign-in pipeline. See the module docs for the sequence. Throws
   * {@link DeviceCredentialError} for every refusal that is not a rate limit
   * (not a device, inactive device, unknown user, wrong credential, no
   * membership) and {@link LoginRateLimitError} when the budget is exhausted.
   */
  async signIn<Input extends DeviceSignInInput>(
    verifier: DeviceCredentialVerifier<Input>,
    input: Input,
  ): Promise<DeviceSignInResult> {
    const device = await this.resolveEnrolledDevice(input.deviceToken);
    if (!device) throw new DeviceCredentialError();

    const lease = await this.limiter.reserve({
      kind: String(verifier.kind),
      subject: verifier.subjectKey(input),
      source: device.user.id ?? undefined,
      // No session ids or user ids in audit metadata: the session id is a
      // bearer credential and the subject/source hashes already identify
      // the attempt for correlation.
      metadata: { tenantId: device.tenantId ?? null },
    });
    if (!lease.allowed) throw new LoginRateLimitError(lease);

    let verified: { userId: string } | null = null;
    let credentialFailed = false;
    try {
      verified = await verifier.verify(input, { device });
      if (!verified) {
        credentialFailed = true;
        throw new DeviceCredentialError();
      }

      const person = await this.users.get(verified.userId);
      if (!person?.isActive()) {
        credentialFailed = true;
        throw new DeviceCredentialError();
      }

      // Never widen tenant scope: the person must belong to the device's
      // tenant. A device with no tenant context mints no tenant context.
      const tenantId = device.tenantId;
      if (tenantId) {
        const membership = await this.memberships.findByUserAndTenant(
          verified.userId,
          tenantId,
        );
        if (!membership?.isActive()) {
          credentialFailed = true;
          throw new DeviceCredentialError();
        }
      }

      const sessionId = await this.sessionService.createSession(
        verified.userId,
        tenantId ?? undefined,
        {
          ttl: this.personSessionTtlSeconds,
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
          authMethod: verifier.kind,
          parentSessionId: device.sessionId,
          data: { deviceUserId: device.user.id },
        },
      );

      let mustReset = false;
      if (verifier.kind === PIN_LOGIN_KIND) {
        const credential = await this.pinCredentials.findByUserId(
          verified.userId,
        );
        mustReset = credential?.mustReset ?? false;
      }

      await lease.succeed();
      return {
        sessionId,
        userId: verified.userId,
        tenantId: tenantId ?? null,
        authMethod: verifier.kind,
        expiresAt: new Date(
          Date.now() + this.personSessionTtlSeconds * 1000,
        ).toISOString(),
        mustReset,
      };
    } catch (error) {
      if (credentialFailed) await lease.fail().catch(() => undefined);
      else await lease.release().catch(() => undefined);
      throw error;
    }
  }

  /**
   * Sign the person out. Ends only the person's layered session; the device
   * session is untouched. Returns false for anything that is not a live
   * layered session (never reveals which).
   */
  async signOut(personToken: string): Promise<boolean> {
    const context = await this.sessionService.loadSessionContext(personToken);
    if (!context?.parent) return false;
    return this.sessionService.destroySession(personToken);
  }

  /**
   * Resolve a person's bearer. Returns null unless it is a live layered
   * session whose parent is still an enrolled device.
   */
  async loadPersonSession(personToken: string): Promise<SessionContext | null> {
    const context = await this.sessionService.loadSessionContext(personToken);
    if (!context?.parent) return null;
    return context;
  }

  /**
   * Resolve any bearer or cookie session id to its context without extending
   * it — for handlers that need the acting session (`setPin` and friends)
   * when the host's hook has not already resolved it into `locals`.
   */
  async resolveActor(sessionToken: string): Promise<SessionContext | null> {
    const token = sessionToken?.trim();
    if (!token) return null;
    return this.readonlySessionService.loadSessionContext(token);
  }

  // -------------------------------------------------------------------------
  // PIN management
  // -------------------------------------------------------------------------

  /**
   * A person sets or changes their own PIN, or an administrator sets one for
   * them. A person acting from a PIN session must supply their current PIN
   * (checked through the limiter, so it cannot be used as an oracle); a
   * person acting from any first-class session (browser, mobile) may set it
   * outright, and so may an administrator holding `managePermission`.
   */
  async setPin(input: SetPinInput): Promise<void> {
    this.assertPinPolicy(input.pin);
    const self = input.actor.user.id === input.userId;
    if (!self) this.assertCanManage(input.actor);

    // Any layered session — PIN or another device credential kind — sits on
    // a possibly unattended device, so it must prove the current PIN.
    if (
      self &&
      (input.actor.authMethod === PIN_LOGIN_KIND || input.actor.parent)
    ) {
      const existing = await this.pinCredentials.findByUserId(input.userId);
      if (existing) {
        if (!input.currentPin) throw new DeviceCredentialForbiddenError();
        const lease = await this.limiter.reserve({
          kind: PIN_LOGIN_KIND,
          subject: input.userId,
          source: input.actor.parent?.userId ?? input.ipAddress,
          metadata: { purpose: 'change-pin' },
        });
        if (!lease.allowed) throw new LoginRateLimitError(lease);
        const ok = await verifyPinHash(
          input.currentPin,
          this.pinPolicy.pepper,
          existing.pinHash,
        );
        if (!ok) {
          await lease.fail().catch(() => undefined);
          throw new DeviceCredentialError();
        }
        await lease.succeed().catch(() => undefined);
      }
    }

    await this.writePin(input.userId, input.pin, {
      mustReset: false,
      rotatedBy: self ? 'self' : (input.actor.user.id ?? 'admin'),
    });
    await this.limiter.recordManagement({
      kind: PIN_LOGIN_KIND,
      subject: input.userId,
      source: input.ipAddress,
      metadata: { action: 'set', self, actorId: input.actor.user.id },
    });
  }

  /**
   * Administrative reset: writes a temporary PIN the person must change on
   * next use, and revokes every live PIN session the person holds.
   */
  async resetPin(input: ResetPinInput): Promise<{ revokedSessions: number }> {
    this.assertCanManage(input.actor);
    this.assertPinPolicy(input.pin);
    await this.writePin(input.userId, input.pin, {
      mustReset: true,
      rotatedBy: input.actor.user.id ?? 'admin',
    });
    const revokedSessions =
      await this.sessionService.destroyUserSessionsByAuthMethod(
        input.userId,
        PIN_LOGIN_KIND,
      );
    await this.limiter.recordManagement({
      kind: PIN_LOGIN_KIND,
      subject: input.userId,
      source: input.ipAddress,
      metadata: {
        action: 'reset',
        actorId: input.actor.user.id,
        revokedSessions,
      },
    });
    return { revokedSessions };
  }

  /** Remove a person's PIN entirely and revoke their live PIN sessions. */
  async clearPin(input: ClearPinInput): Promise<{ revokedSessions: number }> {
    const self = input.actor.user.id === input.userId;
    if (
      !self ||
      input.actor.authMethod === PIN_LOGIN_KIND ||
      input.actor.parent
    ) {
      this.assertCanManage(input.actor);
    }
    await this.pinCredentials.deleteByUserId(input.userId);
    const revokedSessions =
      await this.sessionService.destroyUserSessionsByAuthMethod(
        input.userId,
        PIN_LOGIN_KIND,
      );
    await this.limiter.recordManagement({
      kind: PIN_LOGIN_KIND,
      subject: input.userId,
      source: input.ipAddress,
      metadata: {
        action: 'clear',
        self,
        actorId: input.actor.user.id,
        revokedSessions,
      },
    });
    return { revokedSessions };
  }

  /** Whether the person has a PIN enrolled (for admin UIs; never for login responses). */
  async hasPin(userId: string): Promise<boolean> {
    return (await this.pinCredentials.findByUserId(userId)) !== null;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async resolveEnrolledDevice(
    deviceToken: string,
  ): Promise<SessionContext | null> {
    const token = deviceToken?.trim();
    if (!token) return null;
    // Never through `sessionService`: that one auto-extends with the person
    // TTL and would rewrite the device session's own expiry on every attempt.
    const device = await this.readonlySessionService.loadSessionContext(token);
    if (!device) return null;
    // Only a first-class, device-enrolled session may carry a person: a
    // browser cookie, a mobile session, or another person's layered session
    // is not a device.
    if (device.parent) return null;
    if (!this.deviceAuthMethods.has(String(device.authMethod ?? ''))) {
      return null;
    }
    try {
      const ok = await this.options.assertEnrolledDevice(device);
      if (ok === false) return null;
    } catch {
      return null;
    }
    return device;
  }

  private assertCanManage(actor: SessionContext): void {
    // A PIN session can never administer PINs, whatever permissions the
    // person holds: a stolen unlocked tablet must not be able to rotate
    // other people's credentials.
    if (actor.authMethod === PIN_LOGIN_KIND || actor.parent) {
      throw new DeviceCredentialForbiddenError();
    }
    if (!actor.permissions.includes(this.managePermission)) {
      throw new DeviceCredentialForbiddenError();
    }
  }

  private assertPinPolicy(pin: string): void {
    if (typeof pin !== 'string' || !/^\d+$/u.test(pin)) {
      throw new DeviceCredentialPolicyError('PIN must contain only digits.');
    }
    if (
      pin.length < this.pinPolicy.minLength ||
      pin.length > this.pinPolicy.maxLength
    ) {
      throw new DeviceCredentialPolicyError(
        `PIN must be ${this.pinPolicy.minLength}–${this.pinPolicy.maxLength} digits.`,
      );
    }
    if (this.pinPolicy.rejectTrivial && isTrivialPin(pin)) {
      throw new DeviceCredentialPolicyError(
        'PIN must not be a repeated or sequential run of digits.',
      );
    }
  }

  private async writePin(
    userId: string,
    pin: string,
    meta: { mustReset: boolean; rotatedBy: string },
  ): Promise<UsersPinCredential> {
    const user = await this.users.get(userId);
    if (!user) throw new DeviceCredentialForbiddenError('Unknown user.');
    const pinHash = await hashPin(
      pin,
      this.pinPolicy.pepper,
      this.pinPolicy.scrypt,
    );
    return this.pinCredentials.upsertForUser(userId, {
      pinHash,
      mustReset: meta.mustReset,
      rotatedAt: new Date(),
      rotatedBy: meta.rotatedBy,
    });
  }
}
