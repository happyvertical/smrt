/**
 * PasskeyCredentialService — passkey (WebAuthn) sign-in for an existing,
 * active user, and the lifecycle of the person's passkeys (#3275).
 *
 * All WebAuthn parsing and verification is `@simplewebauthn/server`; this
 * module owns the ceremony state, the sign-in order, and the authority rules.
 *
 * ## Ceremonies
 *
 * `beginAuthentication` / `beginRegistration` return an opaque `ceremonyId`:
 * `base64url(payload) + '.' + base64url(HMAC-SHA256(secret, payload))`, where
 * the payload carries the purpose, the random 32-byte challenge, an expiry
 * and, for registration, the person and the SHA-256 of the actor's session id
 * (never the raw id). Issuing writes nothing, so an unauthenticated "begin"
 * request costs no storage. Single use is enforced when a ceremony is
 * finished: its challenge hash is inserted into the unique
 * {@link UsersPasskeyChallenge} ledger, and a conflict is a replay. Set
 * `challengeSecret` (at least 32 characters) in any deployment with more than
 * one process, or a ceremony begun on one will not verify on another.
 *
 * ## Sign-in (discoverable / usernameless)
 *
 * 1. Take the submitted credential id (what the client sent, never a resolved
 *    user) and RESERVE a login attempt on it, source = the client address.
 * 2. Verify and consume the ceremony; load the credential; verify the
 *    assertion (origin, RP id, user verification REQUIRED); check the
 *    user handle, the signature counter, that the user is ACTIVE and, when a
 *    tenant is given, holds an ACTIVE membership in it. Never create a user.
 * 3. Mint a first-class session (`authMethod: 'passkey'`) through
 *    `SessionService.createSession`, then re-check the credential with one
 *    guarded UPDATE of the counter (a passkey removed meanwhile, or a
 *    concurrent assertion, makes it a no-op and the session is destroyed).
 *
 * Every refusal other than a rate limit is one {@link PasskeyCredentialError}
 * ("Invalid credentials."); a rate limit is {@link LoginRateLimitError}.
 *
 * ## Management and authority
 *
 * Registering a passkey, or a person removing their own, needs a session
 * minted within `freshSessionSeconds` (decided on the STORED session row): a
 * stolen long-lived session cannot enrol an attacker's authenticator. A
 * layered (device PIN) session never manages passkeys, and an administrator
 * may only manage people whose every active membership is in the
 * administrator's session tenant — passkeys, like the password, are one set
 * per person across tenants.
 *
 * @packageDocumentation
 */

import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { withSystemContext } from '@happyvertical/smrt-tenancy';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { MembershipCollection } from '../collections/MembershipCollection.js';
import { UsersPasskeyChallengeCollection } from '../collections/PasskeyChallengeCollection.js';
import { UsersPasskeyCredentialCollection } from '../collections/PasskeyCredentialCollection.js';
import { SessionCollection } from '../collections/SessionCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import type { PasskeyChallengePurpose } from '../models/PasskeyChallenge.js';
import type { UsersPasskeyCredential } from '../models/PasskeyCredential.js';
import {
  DEFAULT_SESSION_TTL,
  type Session,
  type SessionAuthMethod,
} from '../models/Session.js';
import type { User } from '../models/User.js';
import { withoutListBounds } from './authorization-read-options.js';
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

/**
 * `@simplewebauthn/server` is loaded on first use, never at import time. It
 * depends on `reflect-metadata`, which installs `Reflect.decorate`; a model
 * module evaluated AFTER that point has its `@field`/`@smrt` decorators
 * applied through it and silently registers with no fields. Importing this
 * file (it is re-exported from the package entry) must therefore not be what
 * loads it.
 */
let webauthnModule: Promise<typeof import('@simplewebauthn/server')> | null =
  null;
const webauthn = () => {
  webauthnModule ??= import('@simplewebauthn/server');
  return webauthnModule;
};

/** Login-limiter kind and session `authMethod` for passkey sign-ins. */
export const PASSKEY_LOGIN_KIND = 'passkey';
/** Default permission required to list or remove another person's passkeys. */
export const DEFAULT_PASSKEY_MANAGE_PERMISSION = 'users.passkey.manage';
/**
 * Server-set `Session.data` key naming the passkey row a session was signed
 * in with. Never write it from client input.
 */
export const PASSKEY_SESSION_DATA_KEY = 'passkeyCredentialId';
/** Default lifetime of a ceremony (5 minutes). */
export const DEFAULT_PASSKEY_CHALLENGE_TTL_SECONDS = 5 * 60;
/** No configuration may keep a ceremony open longer than this (10 minutes). */
export const PASSKEY_CHALLENGE_TTL_CEILING_SECONDS = 10 * 60;
/** Default age a session may have when it registers or removes a passkey (15 minutes). */
export const DEFAULT_PASSKEY_FRESH_SESSION_SECONDS = 15 * 60;
/** Smallest accepted `freshSessionSeconds`. */
export const PASSKEY_FRESH_SESSION_FLOOR_SECONDS = 60;
/** Largest accepted `freshSessionSeconds` (1 hour). */
export const PASSKEY_FRESH_SESSION_CEILING_SECONDS = 60 * 60;
/** Default passkeys per person. */
export const DEFAULT_MAX_PASSKEYS_PER_USER = 10;
/** No configuration may allow more passkeys per person than this. */
export const PASSKEY_MAX_PER_USER_CEILING = 100;
/** Longest passkey name, in code points. */
export const PASSKEY_NAME_MAX_LENGTH = 64;
/** Name given to a passkey registered without one. */
export const DEFAULT_PASSKEY_NAME = 'Passkey';
/** Longest ceremony id accepted, in characters. */
const MAX_CEREMONY_ID_LENGTH = 4096;
/** Longest credential id accepted, in characters (the WebAuthn bound is 1023 bytes). */
const MAX_CREDENTIAL_ID_LENGTH = 1024;
/** Longest base64url member of a client response accepted, in characters. */
const MAX_RESPONSE_FIELD_LENGTH = 32 * 1024;
/** Challenge size, in bytes. */
const CHALLENGE_BYTES = 32;
/** Shortest accepted `challengeSecret`. */
const MIN_CHALLENGE_SECRET_LENGTH = 32;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
]);

/** Catalog definition for {@link DEFAULT_PASSKEY_MANAGE_PERMISSION}. */
export const PASSKEY_PERMISSION_DEFINITIONS: PermissionDefinition[] = [
  {
    slug: DEFAULT_PASSKEY_MANAGE_PERMISSION,
    category: 'users',
    name: 'Manage passkeys',
    description: "List or remove another person's passkeys",
  },
];

let passkeyPermissionsRegistered = false;

/** Register the passkey management permission once when the service is used. */
export function ensurePasskeyPermissionsRegistered(): void {
  if (passkeyPermissionsRegistered) return;
  passkeyPermissionsRegistered = true;
  registerPermissionDefinitions(PASSKEY_PERMISSION_DEFINITIONS);
}

/**
 * Every sign-in refusal that is not a rate limit: unknown credential, bad or
 * replayed or expired ceremony, failed verification, counter regression,
 * inactive user, no membership. One message, so responses cannot enumerate
 * accounts.
 */
export class PasskeyCredentialError extends InvalidCredentialsError {
  constructor(message = 'Invalid credentials.') {
    super(message);
    this.name = 'PasskeyCredentialError';
  }
}

/** Thrown by the management calls when the actor may not manage the passkey. */
export class PasskeyCredentialForbiddenError extends Error {
  constructor(message = 'Not permitted to manage this passkey.') {
    super(message);
    this.name = 'PasskeyCredentialForbiddenError';
  }
}

/**
 * Thrown when a management call needs a session minted recently and the
 * actor's is older: the person must sign in again, then retry.
 */
export class PasskeyReauthenticationRequiredError extends Error {
  constructor(message = 'Sign in again to manage your passkeys.') {
    super(message);
    this.name = 'PasskeyReauthenticationRequiredError';
  }
}

/**
 * Thrown by register and rename for a refusal whose message is safe to show
 * the person: a bad name, the passkey limit, an authenticator that is already
 * registered, or a registration that did not verify.
 */
export class PasskeyRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasskeyRegistrationError';
  }
}

/** Where passkeys are valid: the origin(s) and relying party identity. */
export interface PasskeyRelyingPartyOptions {
  /**
   * Every origin a ceremony may run on: an absolute `https:` URL with no path
   * (or `http:` for localhost, 127.0.0.1 and [::1] only).
   */
  origin: string | readonly string[];
  /**
   * The RP id passkeys are scoped to. Defaults to the hostname of the first
   * origin; must be that hostname, or a parent domain of EVERY origin's. It
   * cannot be changed later without orphaning every registered passkey.
   */
  rpId?: string;
  /** Name the authenticator shows the person. */
  rpName: string;
}

export interface PasskeyCredentialServiceOptions extends SmrtClassOptions {
  /** Required: passkeys are bound to the relying party. */
  relyingParty: PasskeyRelyingPartyOptions;
  /** Lifetime of a passkey session in seconds. Default seven days. */
  sessionTtl?: number;
  /**
   * Shared {@link LoginAttemptLimiter}. When omitted one is created from
   * `limiter` (or defaults). Supplying the host's instance keeps password,
   * passkey and PIN budgets in one table with one audit sink.
   */
  loginLimiter?: LoginAttemptLimiter;
  /** Options for the private limiter when `loginLimiter` is not supplied. */
  limiter?: Omit<LoginAttemptLimiterOptions, keyof SmrtClassOptions>;
  /** Permission slug an administrator needs to manage others' passkeys. */
  managePermission?: string;
  /**
   * Secret that signs ceremony ids (at least 32 characters). When omitted a
   * random per-instance secret is used, which only works while the process
   * that began a ceremony is the one that finishes it: set it for any
   * multi-process deployment.
   */
  challengeSecret?: string;
  /** Seconds a ceremony stays valid, 1 to 600. Default 300. */
  challengeTtlSeconds?: number;
  /**
   * How recently the session must have been minted to register a passkey or
   * remove one's own, 60 to 3600 seconds. Default 900.
   */
  freshSessionSeconds?: number;
  /** Passkeys one person may hold, 1 to 100. Default 10. */
  maxPasskeysPerUser?: number;
}

export interface PasskeyAuthenticationBegin {
  /** Opaque, signed ceremony state: send it back with the assertion. */
  ceremonyId: string;
  options: PublicKeyCredentialRequestOptionsJSON;
}

export interface PasskeyRegistrationBegin {
  ceremonyId: string;
  options: PublicKeyCredentialCreationOptionsJSON;
}

export interface PasskeySignInInput {
  ceremonyId: string;
  /** The `AuthenticationResponseJSON` the browser produced; validated here. */
  response: unknown;
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
   * if any. Revoked after a successful sign-in (session fixation).
   */
  replaceSessionId?: string | null;
}

export interface PasskeySignInResult {
  /** The new session id: the cookie value. Never send it to client script. */
  sessionId: string;
  userId: string;
  tenantId: string | null;
  authMethod: SessionAuthMethod;
  expiresAt: string;
}

/** A passkey as shown to its owner or an administrator. No key material, no credential id. */
export interface PasskeySummary {
  id: string;
  name: string;
  createdAt: string | null;
  lastUsedAt: string | null;
  backedUp: boolean;
  deviceType: 'singleDevice' | 'multiDevice' | null;
  transports: string[];
}

export interface BeginPasskeyRegistrationInput {
  /** Resolved session of the person registering. */
  actor: SessionContext;
}

export interface FinishPasskeyRegistrationInput {
  actor: SessionContext;
  ceremonyId: string;
  /** The `RegistrationResponseJSON` the browser produced; validated here. */
  response: unknown;
  /** Shown name; trimmed, at most 64 characters, defaults to "Passkey". */
  name?: string;
  ipAddress?: string;
}

export interface ListPasskeysInput {
  actor: SessionContext;
  /** Another person's passkeys (administrators); omitted for the actor's own. */
  userId?: string;
}

export interface RenamePasskeyInput {
  actor: SessionContext;
  passkeyId: string;
  name: string;
  ipAddress?: string;
}

export interface RemovePasskeyInput {
  actor: SessionContext;
  passkeyId: string;
  ipAddress?: string;
}

export interface RemoveAllPasskeysInput {
  actor: SessionContext;
  userId: string;
  ipAddress?: string;
}

/** The verified, signed contents of a ceremony id. */
interface CeremonyPayload {
  v: 1;
  purpose: PasskeyChallengePurpose;
  /** base64url of the 32 random bytes. */
  challenge: string;
  /** Expiry, epoch milliseconds. */
  exp: number;
  /** Registration only: the person registering. */
  userId?: string;
  /** Registration only: sha256 hex of the registering session id. */
  sessionHash?: string;
}

/** Internal: a ceremony id that did not verify. Never leaves this module. */
class CeremonyRejectedError extends Error {}

const toBase64Url = (value: Uint8Array | string): string =>
  Buffer.from(value).toString('base64url');

const sha256Hex = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

function codePointLength(value: string): number {
  let length = 0;
  for (const _ of value) length++;
  return length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** A bounded base64url string, or null. */
function base64urlField(value: unknown, max: number): string | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    BASE64URL_PATTERN.test(value)
    ? value
    : null;
}

/** The credential id a response claims, when it is a plausible one. */
function submittedCredentialId(response: unknown): string | null {
  return isRecord(response)
    ? base64urlField(response.id, MAX_CREDENTIAL_ID_LENGTH)
    : null;
}

/**
 * Copy an assertion into the shape the library expects, dropping everything
 * else the client sent. Null when any required member is missing or unbounded.
 */
function parseAuthenticationResponse(
  raw: unknown,
): AuthenticationResponseJSON | null {
  if (!isRecord(raw) || raw.type !== 'public-key') return null;
  const id = base64urlField(raw.id, MAX_CREDENTIAL_ID_LENGTH);
  const rawId = base64urlField(raw.rawId, MAX_CREDENTIAL_ID_LENGTH);
  if (!id || !rawId || !isRecord(raw.response)) return null;
  const inner = raw.response;
  const clientDataJSON = base64urlField(
    inner.clientDataJSON,
    MAX_RESPONSE_FIELD_LENGTH,
  );
  const authenticatorData = base64urlField(
    inner.authenticatorData,
    MAX_RESPONSE_FIELD_LENGTH,
  );
  const signature = base64urlField(inner.signature, MAX_RESPONSE_FIELD_LENGTH);
  if (!clientDataJSON || !authenticatorData || !signature) return null;
  let userHandle: string | undefined;
  if (inner.userHandle !== undefined && inner.userHandle !== null) {
    // An empty handle is "none"; anything else must be base64url.
    if (inner.userHandle !== '') {
      const handle = base64urlField(inner.userHandle, MAX_CREDENTIAL_ID_LENGTH);
      if (!handle) return null;
      userHandle = handle;
    }
  }
  return {
    id,
    rawId,
    type: 'public-key',
    response: {
      clientDataJSON,
      authenticatorData,
      signature,
      ...(userHandle !== undefined && { userHandle }),
    },
    clientExtensionResults: {},
  };
}

/** The registration counterpart of {@link parseAuthenticationResponse}. */
function parseRegistrationResponse(
  raw: unknown,
): RegistrationResponseJSON | null {
  if (!isRecord(raw) || raw.type !== 'public-key') return null;
  const id = base64urlField(raw.id, MAX_CREDENTIAL_ID_LENGTH);
  const rawId = base64urlField(raw.rawId, MAX_CREDENTIAL_ID_LENGTH);
  if (!id || !rawId || !isRecord(raw.response)) return null;
  const inner = raw.response;
  const clientDataJSON = base64urlField(
    inner.clientDataJSON,
    MAX_RESPONSE_FIELD_LENGTH,
  );
  const attestationObject = base64urlField(
    inner.attestationObject,
    MAX_RESPONSE_FIELD_LENGTH,
  );
  if (!clientDataJSON || !attestationObject) return null;
  const transports = Array.isArray(inner.transports)
    ? inner.transports
        .filter((entry): entry is string => typeof entry === 'string')
        .slice(0, 8)
    : undefined;
  return {
    id,
    rawId,
    type: 'public-key',
    response: {
      clientDataJSON,
      attestationObject,
      ...(transports && { transports: transports as never }),
    },
    clientExtensionResults: {},
  };
}

/** Validate the relying party and resolve its origins and RP id. */
function resolveRelyingParty(
  relyingParty: PasskeyRelyingPartyOptions | undefined,
): { origins: string[]; rpId: string; rpName: string } {
  const fail = (detail: string): never => {
    throw new Error(`PasskeyCredentialService relyingParty ${detail}`);
  };
  if (!isRecord(relyingParty)) fail('is required.');
  const configured = relyingParty as PasskeyRelyingPartyOptions;
  const rawOrigins = Array.isArray(configured.origin)
    ? configured.origin
    : [configured.origin];
  if (rawOrigins.length === 0) fail('needs at least one origin.');

  const origins: string[] = [];
  const hostnames: string[] = [];
  for (const rawOrigin of rawOrigins) {
    let url: URL;
    try {
      url = new URL(String(rawOrigin));
    } catch {
      return fail(
        `origin ${JSON.stringify(rawOrigin)} is not an absolute URL.`,
      );
    }
    const secure =
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
    if (
      typeof rawOrigin !== 'string' ||
      !secure ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    ) {
      return fail(
        `origin ${JSON.stringify(rawOrigin)} must be an https origin with no path (http only for localhost, 127.0.0.1 or [::1]).`,
      );
    }
    if (!origins.includes(url.origin)) origins.push(url.origin);
    hostnames.push(url.hostname);
  }

  const rpId = (configured.rpId ?? hostnames[0] ?? '').toLowerCase();
  if (!rpId) fail('rpId is required.');
  for (const hostname of hostnames) {
    // A registrable suffix: the hostname itself, or a parent domain that is
    // not a bare top-level label ("com") and not part of an IP address.
    const isSuffix =
      hostname === rpId ||
      (hostname.endsWith(`.${rpId}`) &&
        rpId.includes('.') &&
        !/^[\d.]+$/u.test(hostname) &&
        !hostname.startsWith('['));
    if (!isSuffix) {
      fail(
        `rpId "${rpId}" must be the hostname of, or a parent domain of, every origin ("${hostname}").`,
      );
    }
  }
  const rpName =
    typeof configured.rpName === 'string' ? configured.rpName.trim() : '';
  if (!rpName || codePointLength(rpName) > 128) {
    fail('rpName must be a name of 1 to 128 characters.');
  }
  return { origins, rpId, rpName };
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max) {
    throw new Error(
      `PasskeyCredentialService ${name} must be an integer from ${min} to ${max}.`,
    );
  }
  return resolved;
}

export class PasskeyCredentialService {
  private readonly options: PasskeyCredentialServiceOptions;
  private readonly sessionTtl: number;
  private readonly managePermission: string;
  private readonly origins: string[];
  private readonly rpId: string;
  private readonly rpName: string;
  private readonly challengeSecret: Buffer;
  private readonly challengeTtlMs: number;
  private readonly freshSessionMs: number;
  private readonly maxPasskeys: number;
  private sessionService!: SessionService;
  private sessionRows!: SessionCollection;
  private memberships!: MembershipCollection;
  private users!: UserCollection;
  private credentials!: UsersPasskeyCredentialCollection;
  private challenges!: UsersPasskeyChallengeCollection;
  private limiter!: LoginAttemptLimiter;

  constructor(options: PasskeyCredentialServiceOptions) {
    this.options = options;
    ensurePasskeyPermissionsRegistered();
    this.sessionTtl = options.sessionTtl ?? DEFAULT_SESSION_TTL;
    if (!(Number.isFinite(this.sessionTtl) && this.sessionTtl > 0)) {
      throw new Error(
        'PasskeyCredentialService sessionTtl must be a positive number.',
      );
    }
    this.managePermission =
      options.managePermission ?? DEFAULT_PASSKEY_MANAGE_PERMISSION;
    const relyingParty = resolveRelyingParty(options.relyingParty);
    this.origins = relyingParty.origins;
    this.rpId = relyingParty.rpId;
    this.rpName = relyingParty.rpName;
    if (options.challengeSecret !== undefined) {
      if (
        typeof options.challengeSecret !== 'string' ||
        options.challengeSecret.length < MIN_CHALLENGE_SECRET_LENGTH
      ) {
        throw new Error(
          `PasskeyCredentialService challengeSecret must be at least ${MIN_CHALLENGE_SECRET_LENGTH} characters.`,
        );
      }
      this.challengeSecret = Buffer.from(options.challengeSecret, 'utf8');
    } else {
      this.challengeSecret = randomBytes(32);
    }
    this.challengeTtlMs =
      1000 *
      boundedInteger(
        options.challengeTtlSeconds,
        DEFAULT_PASSKEY_CHALLENGE_TTL_SECONDS,
        1,
        PASSKEY_CHALLENGE_TTL_CEILING_SECONDS,
        'challengeTtlSeconds',
      );
    this.freshSessionMs =
      1000 *
      boundedInteger(
        options.freshSessionSeconds,
        DEFAULT_PASSKEY_FRESH_SESSION_SECONDS,
        PASSKEY_FRESH_SESSION_FLOOR_SECONDS,
        PASSKEY_FRESH_SESSION_CEILING_SECONDS,
        'freshSessionSeconds',
      );
    this.maxPasskeys = boundedInteger(
      options.maxPasskeysPerUser,
      DEFAULT_MAX_PASSKEYS_PER_USER,
      1,
      PASSKEY_MAX_PER_USER_CEILING,
      'maxPasskeysPerUser',
    );
  }

  static async create(
    options: PasskeyCredentialServiceOptions,
  ): Promise<PasskeyCredentialService> {
    const service = new PasskeyCredentialService(options);
    await service.initialize();
    return service;
  }

  async initialize(): Promise<void> {
    this.sessionService = await SessionService.create({
      ...this.options,
      defaultTTL: this.sessionTtl,
    });
    // Unbounded: these reads back authorization decisions and quotas.
    const unbounded = withoutListBounds(this.options);
    this.memberships = await MembershipCollection.create(unbounded);
    this.credentials = await UsersPasskeyCredentialCollection.create(unbounded);
    this.users = await UserCollection.create(this.options);
    this.sessionRows = await SessionCollection.create(this.options);
    this.challenges = await UsersPasskeyChallengeCollection.create(
      this.options,
    );
    this.limiter =
      this.options.loginLimiter ??
      (await LoginAttemptLimiter.create({
        ...this.options,
        ...this.options.limiter,
      }));
  }

  /** The limiter in use (shared or private). */
  get loginLimiter(): LoginAttemptLimiter {
    return this.limiter;
  }

  // -------------------------------------------------------------------------
  // Sign in
  // -------------------------------------------------------------------------

  /**
   * Start a usernameless sign-in: the options to hand to the browser's
   * `navigator.credentials.get`. Writes nothing and says nothing about any
   * account (`allowCredentials` is empty: the authenticator offers its own).
   */
  async beginAuthentication(): Promise<PasskeyAuthenticationBegin> {
    const { ceremonyId, challenge } = this.issueCeremony('authentication');
    const { generateAuthenticationOptions } = await webauthn();
    const options = await generateAuthenticationOptions({
      rpID: this.rpId,
      challenge: Buffer.from(challenge, 'base64url'),
      userVerification: 'required',
      allowCredentials: [],
      timeout: this.challengeTtlMs,
    });
    return { ceremonyId, options };
  }

  /**
   * Verify a passkey assertion and mint a session. Throws
   * {@link PasskeyCredentialError} for every refusal that is not a rate limit
   * and {@link LoginRateLimitError} when the budget is exhausted.
   */
  async finishAuthentication(
    input: PasskeySignInInput,
  ): Promise<PasskeySignInResult> {
    const submittedId = submittedCredentialId(input.response);
    const source = input.ipAddress?.trim() || null;
    // Nothing to key any budget on (a disabled source budget keys nothing):
    // refuse like a wrong credential. Every other request, malformed or not,
    // reserves before anything else.
    if (!submittedId && !(source && this.limiter.limitsSource)) {
      throw new PasskeyCredentialError();
    }

    const requestedTenantId = input.tenantId || null;
    const lease = await this.limiter.reserve({
      kind: PASSKEY_LOGIN_KIND,
      // What the client submitted, never a resolved user: unknown and wrong
      // credentials take the same path.
      subject: submittedId,
      source,
      metadata: {
        tenantId:
          requestedTenantId === 'unique-active-membership'
            ? null
            : requestedTenantId,
      },
    });
    if (!lease.allowed) throw new LoginRateLimitError(lease);

    let credentialFailed = false;
    let failMetadata: Record<string, unknown> | undefined;
    let mintedSessionId: string | null = null;
    const refuse = (metadata?: Record<string, unknown>): never => {
      credentialFailed = true;
      failMetadata = metadata;
      throw new PasskeyCredentialError();
    };
    try {
      const response = parseAuthenticationResponse(input.response);
      if (!response || !submittedId) return refuse();

      // The ceremony: signed, unexpired, for authentication, and consumed
      // (single use) before any credential lookup.
      const ceremony = await this.consumeCeremony(
        input.ceremonyId,
        'authentication',
      ).catch((error) => {
        if (error instanceof CeremonyRejectedError) return null;
        throw error;
      });
      if (!ceremony) return refuse();

      const stored = await this.credentials.findByCredentialId(submittedId);
      if (!stored?.id || !UUID_PATTERN.test(stored.userId)) return refuse();
      const user = await this.users.get(stored.userId);
      if (!user?.id) return refuse();

      const { verifyAuthenticationResponse } = await webauthn();
      let verification: Awaited<
        ReturnType<typeof verifyAuthenticationResponse>
      >;
      try {
        verification = await verifyAuthenticationResponse({
          response,
          expectedChallenge: ceremony.challenge,
          expectedOrigin: this.origins,
          expectedRPID: this.rpId,
          requireUserVerification: true,
          credential: {
            id: stored.credentialId,
            publicKey: new Uint8Array(
              Buffer.from(stored.publicKey, 'base64url'),
            ),
            // The counter is checked below, where a regression can be
            // reported as such; 0 disables the library's own (redundant) check.
            counter: 0,
            transports: stored.getTransports(),
          },
        });
      } catch {
        return refuse();
      }
      if (!verification.verified) return refuse();

      // A discoverable credential reports its user handle; when it does it
      // must name the person the credential row belongs to.
      const userHandle = response.response.userHandle;
      if (userHandle && userHandle !== toBase64Url(user.id)) return refuse();

      // A counter that does not advance means a cloned authenticator (or a
      // replayed assertion). Authenticators that never count stay at 0.
      const newCounter = verification.authenticationInfo.newCounter;
      const storedCounter = stored.signCount ?? 0;
      if (
        !Number.isSafeInteger(newCounter) ||
        ((storedCounter > 0 || newCounter > 0) && newCounter <= storedCounter)
      ) {
        return refuse({ reason: 'counter' });
      }

      if (!user.isActive()) return refuse();
      const userId = user.id;

      const tenantId =
        requestedTenantId === 'unique-active-membership'
          ? await this.resolveUniqueActiveMembershipTenant(userId)
          : requestedTenantId;
      if (!tenantId && requestedTenantId === 'unique-active-membership') {
        return refuse();
      }
      if (tenantId) {
        const membership = await this.memberships.findByUserAndTenant(
          userId,
          tenantId,
        );
        if (!membership?.isActive()) return refuse();
      }

      const now = Date.now();
      const sessionId = await this.sessionService.createSession(
        userId,
        tenantId ?? undefined,
        {
          ttl: this.sessionTtl,
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
          authMethod: PASSKEY_LOGIN_KIND,
          data: { [PASSKEY_SESSION_DATA_KEY]: stored.id },
        },
      );
      mintedSessionId = sessionId;

      // Bind the session to the credential that was verified: one guarded
      // UPDATE that applies only while the row still exists with the counter
      // it was verified against. A passkey removed after the lookup (whose
      // revocation sweep may already have run), or a concurrent assertion
      // that advanced the counter first, makes it a no-op.
      const recorded = await this.credentials.recordUseIfCurrent(
        stored.id,
        userId,
        storedCounter,
        newCounter,
        verification.authenticationInfo.credentialBackedUp === true,
      );
      if (!recorded) return refuse({ reason: 'superseded' });

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
        authMethod: PASSKEY_LOGIN_KIND,
        expiresAt: new Date(now + this.sessionTtl * 1000).toISOString(),
      };
    } catch (error) {
      if (credentialFailed)
        await lease.fail(failMetadata).catch(() => undefined);
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
  // Registration
  // -------------------------------------------------------------------------

  /**
   * Start registering a passkey for the actor: the options to hand to
   * `navigator.credentials.create`. The actor's session must be fresh, first
   * class, and without a permission ceiling.
   */
  async beginRegistration(
    input: BeginPasskeyRegistrationInput,
  ): Promise<PasskeyRegistrationBegin> {
    const { user } = await this.assertFreshManager(input.actor);
    const existing = await this.credentials.listByUserId(user.id as string);
    if (existing.length >= this.maxPasskeys) throw this.limitReached();

    const userName = user.email || user.username || (user.id as string);
    const { ceremonyId, challenge } = this.issueCeremony('registration', {
      userId: user.id as string,
      sessionHash: sha256Hex(input.actor.sessionId),
    });
    const { generateRegistrationOptions } = await webauthn();
    const options = await generateRegistrationOptions({
      rpName: this.rpName,
      rpID: this.rpId,
      userName,
      userDisplayName: userName,
      // The stable WebAuthn user handle: sign-in checks it against the row.
      userID: new TextEncoder().encode(user.id as string),
      challenge: Buffer.from(challenge, 'base64url'),
      attestationType: 'none',
      excludeCredentials: existing.map((passkey) => ({
        id: passkey.credentialId,
        transports: passkey.getTransports(),
      })),
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
      },
      timeout: this.challengeTtlMs,
    });
    return { ceremonyId, options };
  }

  /**
   * Verify a registration and store the passkey. Same guards as
   * {@link beginRegistration}, and the ceremony must have been begun by this
   * actor's own session.
   */
  async finishRegistration(
    input: FinishPasskeyRegistrationInput,
  ): Promise<{ passkey: PasskeySummary }> {
    const { user } = await this.assertFreshManager(input.actor);
    const userId = user.id as string;
    const name = this.normalizeName(input.name, true);
    const response = parseRegistrationResponse(input.response);
    if (!response) throw this.registrationFailed();

    const ceremony = await this.consumeCeremony(
      input.ceremonyId,
      'registration',
    ).catch((error) => {
      if (error instanceof CeremonyRejectedError) {
        throw new PasskeyRegistrationError(
          'This request expired or was already used. Start again.',
        );
      }
      throw error;
    });
    if (
      ceremony.userId !== userId ||
      ceremony.sessionHash !== sha256Hex(input.actor.sessionId)
    ) {
      throw this.registrationFailed();
    }

    let verification: Awaited<
      ReturnType<
        Awaited<ReturnType<typeof webauthn>>['verifyRegistrationResponse']
      >
    >;
    try {
      const { verifyRegistrationResponse } = await webauthn();
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: ceremony.challenge,
        expectedOrigin: this.origins,
        expectedRPID: this.rpId,
        requireUserPresence: true,
        requireUserVerification: true,
      });
    } catch {
      throw this.registrationFailed();
    }
    if (!verification.verified) throw this.registrationFailed();
    const registered = verification.registrationInfo;

    if ((await this.credentials.countByUserId(userId)) >= this.maxPasskeys) {
      throw this.limitReached();
    }
    const inserted = await this.credentials.insertIfAbsent({
      userId,
      credentialId: registered.credential.id,
      publicKey: toBase64Url(registered.credential.publicKey),
      signCount: Math.max(0, Math.trunc(registered.credential.counter) || 0),
      transports: registered.credential.transports ?? null,
      name,
      aaguid: registered.aaguid || null,
      backedUp: registered.credentialBackedUp === true,
      deviceType: registered.credentialDeviceType,
      createdBy: 'self',
    });
    if (!inserted?.id) {
      throw new PasskeyRegistrationError('This passkey is already registered.');
    }
    // Concurrent registrations can each pass the count above; settle it.
    if ((await this.credentials.countByUserId(userId)) > this.maxPasskeys) {
      await this.credentials.deleteOwned(inserted.id, userId);
      throw this.limitReached();
    }
    await this.recordManagement(userId, input.ipAddress, {
      action: 'register',
      self: true,
      deviceType: inserted.deviceType,
    });
    return { passkey: this.summarize(inserted) };
  }

  // -------------------------------------------------------------------------
  // Management
  // -------------------------------------------------------------------------

  /**
   * The person's passkeys, oldest first: their own, or — for an
   * administrator holding `managePermission` under the single-tenant target
   * rule — someone else's. Never key material or credential ids.
   */
  async listPasskeys(input: ListPasskeysInput): Promise<PasskeySummary[]> {
    this.assertNotLayered(input.actor);
    const actorId = input.actor.user?.id;
    if (!actorId || !UUID_PATTERN.test(actorId)) {
      throw new PasskeyCredentialForbiddenError();
    }
    const targetId = input.userId?.trim() || actorId;
    if (targetId !== actorId) {
      await this.assertCanManage(input.actor, targetId);
    }
    return (await this.credentials.listByUserId(targetId)).map((passkey) =>
      this.summarize(passkey),
    );
  }

  /** The person renames one of their own passkeys. */
  async renamePasskey(
    input: RenamePasskeyInput,
  ): Promise<{ passkey: PasskeySummary }> {
    this.assertNotLayered(input.actor);
    const userId = input.actor.user?.id;
    if (!userId || !UUID_PATTERN.test(userId)) {
      throw new PasskeyCredentialForbiddenError();
    }
    const passkey = await this.requireOwned(input.passkeyId, userId);
    const name = this.normalizeName(input.name, false);
    if (
      !(await this.credentials.renameOwned(passkey.id as string, userId, name))
    ) {
      throw new PasskeyCredentialForbiddenError();
    }
    await this.recordManagement(userId, input.ipAddress, {
      action: 'rename',
      self: true,
    });
    passkey.name = name;
    return { passkey: this.summarize(passkey) };
  }

  /**
   * Remove one passkey: the person's own (from a fresh session) or, for an
   * administrator under the single-tenant target rule, anyone's. Sessions
   * end before AND after the delete, so a failure between the two leaves the
   * person signed out, never signed in on a passkey that is gone: for an
   * administrator every passkey session of the person; for the person every
   * one except the current session — unless the current session was signed in
   * with the removed passkey, which then ends too.
   */
  async removePasskey(
    input: RemovePasskeyInput,
  ): Promise<{ revokedSessions: number; endedCurrentSession: boolean }> {
    this.assertNotLayered(input.actor);
    const actorId = input.actor.user?.id;
    if (!actorId || !UUID_PATTERN.test(actorId)) {
      throw new PasskeyCredentialForbiddenError();
    }
    const passkey = UUID_PATTERN.test(input.passkeyId)
      ? await this.credentials.get(input.passkeyId)
      : null;
    if (!passkey?.id) throw new PasskeyCredentialForbiddenError();
    const passkeyId = passkey.id;
    const targetId = passkey.userId;
    const self = targetId === actorId;

    let endedCurrentSession = false;
    if (self) {
      const { session } = await this.assertFreshManager(input.actor);
      endedCurrentSession =
        session.getData<unknown>(PASSKEY_SESSION_DATA_KEY) === passkeyId;
    } else {
      await this.assertCanManage(input.actor, targetId);
    }

    const endSessions = () =>
      this.sessionService.destroyUserSessionsByAuthMethod(
        targetId,
        PASSKEY_LOGIN_KIND,
        {
          exceptSessionId:
            self && !endedCurrentSession ? input.actor.sessionId : undefined,
        },
      );
    let revokedSessions = await endSessions();
    if (!(await this.credentials.deleteOwned(passkeyId, targetId))) {
      throw new PasskeyCredentialForbiddenError();
    }
    revokedSessions += await endSessions();
    await this.recordManagement(targetId, input.ipAddress, {
      action: 'remove',
      self,
      ...(self ? {} : { actorId }),
      revokedSessions,
    });
    return { revokedSessions, endedCurrentSession };
  }

  /**
   * Administrative recovery for a person who lost every authenticator: delete
   * all their passkeys and end every passkey session of theirs. Holding
   * `managePermission` under the single-tenant target rule; never on oneself.
   * The person then signs in with another credential and registers anew.
   */
  async removeAllPasskeys(
    input: RemoveAllPasskeysInput,
  ): Promise<{ removed: number; revokedSessions: number }> {
    this.assertNotLayered(input.actor);
    const actorId = input.actor.user?.id;
    if (!actorId || input.userId === actorId) {
      throw new PasskeyCredentialForbiddenError();
    }
    await this.assertCanManage(input.actor, input.userId);
    const endSessions = () =>
      this.sessionService.destroyUserSessionsByAuthMethod(
        input.userId,
        PASSKEY_LOGIN_KIND,
      );
    let revokedSessions = await endSessions();
    const removed = await this.credentials.deleteAllForUser(input.userId);
    revokedSessions += await endSessions();
    await this.recordManagement(input.userId, input.ipAddress, {
      action: 'remove-all',
      self: false,
      actorId,
      removed,
      revokedSessions,
    });
    return { removed, revokedSessions };
  }

  /** Whether the person has a passkey (for admin UIs; never for sign-in responses). */
  async hasPasskeys(userId: string): Promise<boolean> {
    if (!UUID_PATTERN.test(userId)) return false;
    return (await this.credentials.countByUserId(userId)) > 0;
  }

  // -------------------------------------------------------------------------
  // Ceremonies
  // -------------------------------------------------------------------------

  private sign(payloadB64: string): Buffer {
    return createHmac('sha256', this.challengeSecret)
      .update(payloadB64)
      .digest();
  }

  private issueCeremony(
    purpose: PasskeyChallengePurpose,
    registration?: { userId: string; sessionHash: string },
  ): { ceremonyId: string; challenge: string } {
    const challenge = toBase64Url(randomBytes(CHALLENGE_BYTES));
    const payload: CeremonyPayload = {
      v: 1,
      purpose,
      challenge,
      exp: Date.now() + this.challengeTtlMs,
      ...registration,
    };
    const payloadB64 = toBase64Url(JSON.stringify(payload));
    return {
      ceremonyId: `${payloadB64}.${toBase64Url(this.sign(payloadB64))}`,
      challenge,
    };
  }

  /**
   * Check a ceremony id: bounded, well formed, correctly signed (constant
   * time), for `purpose`, and unexpired. Throws {@link CeremonyRejectedError}.
   */
  private readCeremony(
    ceremonyId: unknown,
    purpose: PasskeyChallengePurpose,
  ): CeremonyPayload {
    if (
      typeof ceremonyId !== 'string' ||
      ceremonyId.length === 0 ||
      ceremonyId.length > MAX_CEREMONY_ID_LENGTH
    ) {
      throw new CeremonyRejectedError();
    }
    const parts = ceremonyId.split('.');
    const [payloadB64, macB64] = parts;
    if (
      parts.length !== 2 ||
      !payloadB64 ||
      !macB64 ||
      !BASE64URL_PATTERN.test(payloadB64) ||
      !BASE64URL_PATTERN.test(macB64)
    ) {
      throw new CeremonyRejectedError();
    }
    const presented = Buffer.from(macB64, 'base64url');
    const expected = this.sign(payloadB64);
    if (
      presented.length !== expected.length ||
      !timingSafeEqual(presented, expected)
    ) {
      throw new CeremonyRejectedError();
    }
    let payload: unknown;
    try {
      payload = JSON.parse(
        Buffer.from(payloadB64, 'base64url').toString('utf8'),
      );
    } catch {
      throw new CeremonyRejectedError();
    }
    if (
      !isRecord(payload) ||
      payload.v !== 1 ||
      payload.purpose !== purpose ||
      typeof payload.exp !== 'number' ||
      !Number.isFinite(payload.exp) ||
      payload.exp <= Date.now() ||
      typeof payload.challenge !== 'string' ||
      payload.challenge.length !== 43 ||
      !BASE64URL_PATTERN.test(payload.challenge)
    ) {
      throw new CeremonyRejectedError();
    }
    if (purpose === 'registration') {
      if (
        typeof payload.userId !== 'string' ||
        typeof payload.sessionHash !== 'string' ||
        !SHA256_HEX_PATTERN.test(payload.sessionHash)
      ) {
        throw new CeremonyRejectedError();
      }
    }
    return payload as unknown as CeremonyPayload;
  }

  /**
   * {@link readCeremony}, then consume it: of any number of uses of one
   * ceremony exactly one gets past the unique challenge hash.
   */
  private async consumeCeremony(
    ceremonyId: unknown,
    purpose: PasskeyChallengePurpose,
  ): Promise<CeremonyPayload> {
    const payload = this.readCeremony(ceremonyId, purpose);
    const consumed = await this.challenges.consume(
      sha256Hex(payload.challenge),
      purpose,
      new Date(payload.exp),
    );
    if (!consumed) throw new CeremonyRejectedError();
    return payload;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Select a tenant only when a passkey-authenticated person has exactly one
   * active direct membership; resolved after the assertion verifies, so
   * ambiguity cannot turn a successful sign-in into an unscoped session.
   */
  private async resolveUniqueActiveMembershipTenant(
    userId: string,
  ): Promise<string | null> {
    const memberships = await withSystemContext(() =>
      this.memberships.findActiveByUser(userId),
    );
    return memberships.length === 1 && memberships[0]?.tenantId
      ? memberships[0].tenantId
      : null;
  }

  private assertNotLayered(actor: SessionContext): void {
    // A session layered on a shared device (a PIN session) may sit on an
    // unattended tablet: it never manages passkeys, its own included.
    if (actor.parent || actor.authMethod === 'pin') {
      throw new PasskeyCredentialForbiddenError();
    }
  }

  /**
   * The actor may enrol or remove their own passkey only from a first-class
   * session minted within `freshSessionSeconds`. Decided on the STORED
   * session row, never on the caller-built context: the row must exist and
   * still be valid, belong to the actor, not be layered, and carry no
   * permission ceiling — a restricted session, such
   * as a must-change password session, cannot enrol an authenticator.
   */
  private async assertFreshManager(
    actor: SessionContext,
  ): Promise<{ user: User; session: Session }> {
    this.assertNotLayered(actor);
    const userId = actor.user?.id;
    if (
      !userId ||
      !UUID_PATTERN.test(userId) ||
      typeof actor.sessionId !== 'string' ||
      !UUID_PATTERN.test(actor.sessionId)
    ) {
      throw new PasskeyCredentialForbiddenError();
    }
    const session = await this.sessionRows.findValidSession(actor.sessionId);
    if (
      !session ||
      session.userId !== userId ||
      session.parentSessionId ||
      session.authMethod === 'pin'
    ) {
      throw new PasskeyCredentialForbiddenError();
    }
    if (session.getPermissionCeiling() !== null) {
      throw new PasskeyCredentialForbiddenError();
    }
    // The authentication time, not the row's age: tenant-switch rotation
    // mints a new row but carries the original time forward, and a malformed
    // stamp reads as null (stale).
    const mintedAt = session.getAuthenticatedAt()?.getTime();
    if (
      typeof mintedAt !== 'number' ||
      Date.now() - mintedAt > this.freshSessionMs
    ) {
      throw new PasskeyReauthenticationRequiredError();
    }
    const user = await this.users.get(userId);
    if (!user?.id || !user.isActive()) {
      throw new PasskeyCredentialForbiddenError();
    }
    return { user, session };
  }

  private async assertCanManage(
    actor: SessionContext,
    targetUserId: string,
  ): Promise<void> {
    if (!actor.permissions.includes(this.managePermission)) {
      throw new PasskeyCredentialForbiddenError();
    }
    // `permissions` were resolved for the actor's tenant, so they confer
    // authority only over that tenant's people. A person's passkeys (and the
    // session sweep a removal triggers) are one set across every tenant, so
    // the target must be an active member of the actor's tenant AND of no
    // other — otherwise a tenant-A admin could remove a tenant-B account's
    // passkeys. Unknown, malformed and foreign targets are refused alike.
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
      throw new PasskeyCredentialForbiddenError();
    }
  }

  private async requireOwned(
    passkeyId: string,
    userId: string,
  ): Promise<UsersPasskeyCredential> {
    const passkey = UUID_PATTERN.test(passkeyId)
      ? await this.credentials.findOwned(passkeyId, userId)
      : null;
    if (!passkey) throw new PasskeyCredentialForbiddenError();
    return passkey;
  }

  /** Trim and bound a passkey name; throws {@link PasskeyRegistrationError}. */
  private normalizeName(name: unknown, allowDefault: boolean): string {
    const trimmed =
      typeof name === 'string' ? name.normalize('NFC').trim() : '';
    if (!trimmed) {
      if (allowDefault) return DEFAULT_PASSKEY_NAME;
      throw new PasskeyRegistrationError('Enter a name for this passkey.');
    }
    if (codePointLength(trimmed) > PASSKEY_NAME_MAX_LENGTH) {
      throw new PasskeyRegistrationError(
        `A passkey name can be at most ${PASSKEY_NAME_MAX_LENGTH} characters.`,
      );
    }
    // Control and format characters are never part of a visible name.
    if (/\p{C}/u.test(trimmed)) {
      throw new PasskeyRegistrationError(
        'A passkey name cannot contain control characters.',
      );
    }
    return trimmed;
  }

  private limitReached(): PasskeyRegistrationError {
    return new PasskeyRegistrationError(
      `You can register at most ${this.maxPasskeys} passkeys. Remove one first.`,
    );
  }

  private registrationFailed(): PasskeyRegistrationError {
    return new PasskeyRegistrationError(
      'Your passkey could not be verified. Try again.',
    );
  }

  private summarize(passkey: UsersPasskeyCredential): PasskeySummary {
    return {
      id: passkey.id as string,
      name: passkey.name,
      createdAt: passkey.created_at ? passkey.created_at.toISOString() : null,
      lastUsedAt: passkey.lastUsedAt
        ? new Date(passkey.lastUsedAt).toISOString()
        : null,
      backedUp: passkey.backedUp === true,
      deviceType: passkey.deviceType ?? null,
      transports: passkey.getTransports(),
    };
  }

  private async recordManagement(
    userId: string,
    ipAddress: string | undefined,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.limiter.recordManagement({
      kind: PASSKEY_LOGIN_KIND,
      subject: userId,
      source: ipAddress,
      metadata,
    });
  }
}
