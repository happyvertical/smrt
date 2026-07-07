/**
 * MobileAuthService — server side of the SMRT mobile `/api/mobile` contract
 * (ADR 0001 Phase 3.5, issue #1748).
 *
 * Implements server-brokered OIDC/PKCE for native mobile clients on top of
 * the existing building blocks: {@link OidcLoginService} for the protocol
 * work, {@link SessionService} for the opaque bearer session (the session id
 * IS the bearer token — the same convention `TerminalAuthService` ships), and
 * the membership/role/tenant collections for the session bootstrap.
 *
 * Wire DTOs come from `@happyvertical/smrt-mobile-contract` — the owning
 * package for both the Kotlin client contract and these TypeScript types.
 *
 * ## Stateless completion: the state token
 *
 * The mobile flow has no cookie jar, so the web flow's HMAC-signed
 * transaction cookie cannot carry `state`/`nonce`/`codeVerifier` across the
 * redirect. Instead (per the frozen contract) the CLIENT persists and echoes
 * `state` + `codeVerifier`, and the server stays stateless by making the
 * OAuth `state` value itself a signed token: base64url JSON carrying the
 * nonce, provider, and creation time, plus an HMAC-SHA256 signature when a
 * secret is available (`stateSecret` option, defaulting to the provider's
 * `clientSecret` — the same fallback the web transaction cookie uses). The
 * client treats `state` as opaque; `MobileSessionManager` just compares the
 * redirect's `state` to the persisted one and echoes it back.
 *
 * The `codeVerifier` deliberately NEVER rides inside the state token: state
 * appears in the authorization URL (browser history, proxy logs), and a
 * verifier there would defeat PKCE. It stays client-held — returned once in
 * the `auth/start` response body and echoed once in the `auth/complete`
 * request body, both over TLS POSTs. The nonce, by contrast, is already a
 * query parameter of the authorization URL, so embedding it in `state`
 * leaks nothing while letting the server enforce full ID-token nonce
 * verification without server-side pending state.
 *
 * @packageDocumentation
 */

import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import type {
  MobileAuthCompleteRequest,
  MobileAuthSession,
  MobileAuthStartRequest,
  MobileAuthStartResponse,
  MobileSessionBootstrap,
  MobileTenantOption,
  MobileUserSummary,
} from '@happyvertical/smrt-mobile-contract';
import { MembershipCollection } from '../collections/MembershipCollection.js';
import { RoleCollection } from '../collections/RoleCollection.js';
import { TenantCollection } from '../collections/TenantCollection.js';
import {
  type OidcClaims,
  UserCollection,
} from '../collections/UserCollection.js';
import type { Membership } from '../models/Membership.js';
import type { Role } from '../models/Role.js';
import type { Tenant } from '../models/Tenant.js';
import {
  OidcLoginError,
  OidcLoginService,
  type OidcProviderResolutionOptions,
  type OidcTokenSet,
  type OidcTransaction,
  resolveOidcProviderConfig,
} from './OidcLoginService.js';
import type { SessionContext } from './SessionService.js';
import { SessionService } from './SessionService.js';

/** 30 days — mobile sessions outlive browser sessions by design. */
const DEFAULT_MOBILE_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
/** 10 minutes — matches the web flow's transaction-cookie TTL. */
const DEFAULT_MOBILE_TRANSACTION_TTL_SECONDS = 10 * 60;
/** Tolerated forward clock skew when checking state-token freshness. */
const STATE_TOKEN_CLOCK_SKEW_MS = 60 * 1000;
/** Upper bound for a client-supplied correlation `state` value. */
const MAX_CLIENT_STATE_LENGTH = 512;
/** Cap for the per-(provider, redirectUri) OIDC service cache. */
const MAX_OIDC_SERVICE_CACHE = 16;
/** Cap for IdP-sourced strings persisted in the session data blob. */
const MAX_STORED_CLAIM_LENGTH = 1024;

/**
 * Machine-readable error codes carried on {@link MobileAuthError} and in the
 * JSON error body (`{ error, code }`) the SvelteKit handlers emit.
 */
export type MobileAuthErrorCode =
  | 'invalid_request'
  | 'unknown_provider'
  | 'invalid_redirect_uri'
  | 'missing_code_verifier'
  | 'invalid_state'
  | 'expired_transaction'
  | 'exchange_failed'
  | 'signin_not_permitted'
  | 'missing_bearer_token'
  | 'invalid_bearer_token'
  | 'provider_unavailable'
  | 'server_misconfigured';

/**
 * HTTP-mapped mobile-auth failure. `status` drives the response code; `code`
 * gives clients a stable discriminator (messages may change).
 */
export class MobileAuthError extends Error {
  readonly status: number;
  readonly code: MobileAuthErrorCode;

  constructor(status: number, code: MobileAuthErrorCode, message: string) {
    super(message);
    this.name = 'MobileAuthError';
    this.status = status;
    this.code = code;
  }
}

/** Context handed to the {@link MobileAuthServiceOptions.resolveUser} hook. */
export interface MobileLoginContext {
  claims: OidcClaims;
  tokens: OidcTokenSet;
  providerName: string;
}

/** Minimal user identity a {@link MobileAuthServiceOptions.resolveUser} hook returns. */
export interface MobileResolvedUser {
  id: string;
  email?: string | null;
}

/** Context handed to the {@link MobileAuthServiceOptions.resolveTenantId} hook. */
export interface MobileTenantContext {
  userId: string;
  claims: OidcClaims;
  providerName: string;
}

/** Context handed to the {@link MobileAuthServiceOptions.buildExtras} hook. */
export interface MobileBootstrapContext {
  /** Full session context (user, membership, tenantId, sessionId). */
  session: SessionContext;
  /**
   * The session's resolved permission slugs. Any MODEL JSON placed into
   * `extras` must be projected with `toPublicJSON({ permissions })` using
   * THIS set, or the response leaks fields the generated routes redact
   * (`@field({ readPermission })`, #1822). Fail closed.
   */
  permissions: string[];
  tenants: MobileTenantOption[];
  activeTenant: MobileTenantOption | null;
}

/** Request metadata recorded onto the minted session. */
export interface MobileRequestMeta {
  userAgent?: string;
  ipAddress?: string;
}

export interface MobileAuthServiceOptions
  extends SmrtClassOptions,
    OidcProviderResolutionOptions {
  /** Optional fetch override for tests or custom runtimes. */
  fetch?: typeof fetch;
  /** JWT clock tolerance passed to jose. */
  clockTolerance?: number | string;
  /**
   * Allowed mobile redirect URIs. Entries are exact matches, except entries
   * ending in `/` which allow any sub-path of that prefix. When omitted or
   * empty, any structurally valid mobile redirect URI is accepted (https,
   * loopback http, or a private app scheme — RFC 8252); configure this in
   * production so authorization responses cannot be pointed at an
   * attacker-controlled URI.
   */
  redirectUris?: string[];
  /** Mobile bearer session TTL in seconds. Default: 30 days. */
  sessionTtl?: number;
  /**
   * Auth handshake (start → complete) TTL in seconds. Default: 10 minutes,
   * matching the web flow's transaction cookie.
   */
  transactionTtl?: number;
  /**
   * HMAC secret for state-token integrity. Defaults to the resolved
   * provider's `clientSecret`.
   *
   * State signing binds the `nonce`/provider/createdAt in the OAuth `state`
   * so they cannot be forged, so it is REQUIRED by default: if neither
   * `stateSecret` nor the provider's `clientSecret` is available, sign-in
   * fails closed (500 `server_misconfigured`). A public OIDC client (no
   * client secret — the PKCE case) just supplies a `stateSecret`; it is a
   * server-side HMAC key unrelated to OAuth client authentication, so any
   * deployment can set one. Set {@link allowUnsignedState} to opt into
   * unsigned tokens (NOT recommended — then `redirectUris` is the only
   * defense against state forgery).
   */
  stateSecret?: string;
  /**
   * Permit unsigned state tokens when no `stateSecret`/`clientSecret` is
   * configured. Default false (fail closed). Only enable for local
   * development or a deployment that accepts the state-forgery risk;
   * production should configure a `stateSecret` instead.
   */
  allowUnsignedState?: boolean;
  /**
   * Include descendant tenants reachable through ACTIVE memberships whose
   * role has `inheritsToDescendants: true` (#1867) in the bootstrap tenant
   * list. Default true.
   */
  includeInheritedTenants?: boolean;
  /**
   * Provision a user even when the IdP explicitly reported the email as
   * unverified. Passed through to `UserCollection.getOrCreateFromOidc`.
   */
  allowUnverifiedEmail?: boolean;
  /**
   * Map verified IdP claims to a SMRT user. The default provisions (or
   * resolves) the user via `UserCollection.getOrCreateFromOidc`. Return
   * `null`/`undefined` to REFUSE sign-in (403 `signin_not_permitted`) —
   * invite-gated apps resolve against their own membership rules here
   * without any user row being created. THROWING (vs returning null) is
   * treated as an unexpected server error and surfaces as a generic 500;
   * translate expected denials into a `null` return or a thrown
   * {@link MobileAuthError}.
   */
  resolveUser?: (
    context: MobileLoginContext,
  ) => Promise<MobileResolvedUser | null | undefined>;
  /**
   * Choose the tenant the minted session is bound to. Return a tenant id,
   * `null` for an explicitly tenant-less session, or `undefined` to fall
   * back to the default (the first direct ACTIVE membership's tenant,
   * sorted by tenant name). The session's tenant is the isolation key for
   * every `@TenantScoped` query, so only return tenants the user can
   * actually resolve permissions in.
   */
  resolveTenantId?: (
    context: MobileTenantContext,
  ) => Promise<string | null | undefined>;
  /**
   * App-defined `extras` object for the session bootstrap. Must be a plain
   * JSON object (the Kotlin client decodes it as `JsonObject`). See
   * {@link MobileBootstrapContext.permissions} for the read-permission
   * redaction requirement on model JSON.
   */
  buildExtras?: (
    context: MobileBootstrapContext,
  ) => Promise<Record<string, unknown> | null | undefined>;
}

/** Result of {@link MobileAuthService.logout}. */
export interface MobileLogoutResult {
  ok: true;
  /** Whether a live session was actually revoked. */
  destroyed: boolean;
}

/**
 * Payload encoded into the OAuth `state` value. Short keys keep the
 * authorization URL compact.
 */
interface MobileStatePayload {
  /** Version discriminator. */
  v: 1;
  /** Random entropy (CSRF binding for the client's opaque comparison). */
  s: string;
  /** OIDC nonce echoed for ID-token verification at complete time. */
  n: string;
  /** Provider name the handshake was started for. */
  p: string;
  /** Creation time (epoch ms) for TTL enforcement. */
  t: number;
  /** Optional client-supplied correlation value (opaque passthrough). */
  c?: string;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    '=',
  );
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function randomBase64Url(byteLength = 16): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

async function hmacBase64Url(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(payload),
  );
  return bytesToBase64Url(new Uint8Array(signature));
}

function timingSafeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let diff = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return diff === 0;
}

async function encodeMobileState(
  payload: MobileStatePayload,
  secret: string | undefined,
): Promise<string> {
  const encoded = bytesToBase64Url(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  if (!secret) return encoded;
  return `${encoded}.${await hmacBase64Url(encoded, secret)}`;
}

async function decodeMobileState(
  raw: string,
  secret: string | undefined,
): Promise<MobileStatePayload> {
  const invalid = () =>
    new MobileAuthError(401, 'invalid_state', 'Invalid mobile auth state.');

  let encoded = raw;
  if (secret) {
    const separator = raw.lastIndexOf('.');
    if (separator < 0) throw invalid();
    encoded = raw.slice(0, separator);
    const signature = raw.slice(separator + 1);
    const expected = await hmacBase64Url(encoded, secret);
    if (!timingSafeEqual(signature, expected)) throw invalid();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encoded)));
  } catch {
    throw invalid();
  }

  if (!parsed || typeof parsed !== 'object') throw invalid();
  const record = parsed as Partial<MobileStatePayload>;
  if (
    record.v !== 1 ||
    typeof record.s !== 'string' ||
    record.s.length === 0 ||
    typeof record.n !== 'string' ||
    record.n.length === 0 ||
    typeof record.p !== 'string' ||
    record.p.length === 0 ||
    typeof record.t !== 'number' ||
    !Number.isFinite(record.t) ||
    (record.c !== undefined && typeof record.c !== 'string')
  ) {
    throw invalid();
  }

  return {
    v: 1,
    s: record.s,
    n: record.n,
    p: record.p,
    t: record.t,
    c: record.c,
  };
}

/**
 * Pull the token out of an `Authorization: Bearer <token>` header. Returns
 * `null` when the header is missing or malformed.
 */
export function readMobileBearerToken(
  authorizationHeader: string | null | undefined,
): string | null {
  const match = authorizationHeader?.match(/^Bearer\s+(.+)$/iu);
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : null;
}

// Schemes that could execute script or read local resources if a redirect
// value ever reached a browser context. Rejected regardless of allow list.
const DANGEROUS_REDIRECT_SCHEMES = new Set([
  'javascript:',
  'data:',
  'vbscript:',
  'file:',
  'blob:',
  'about:',
]);

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]'
  );
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

/**
 * Validate a mobile redirect URI: absolute, a safe scheme (https, loopback
 * http, or a private app scheme per RFC 8252), and — when an allow list is
 * configured — present on it. Returns the normalized URI.
 */
export function validateMobileRedirectUri(
  value: unknown,
  allowList: string[] = [],
): string {
  const redirectUri = normalizeOptionalString(value);
  if (!redirectUri) {
    throw new MobileAuthError(
      400,
      'invalid_redirect_uri',
      'Missing mobile redirect URI.',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    throw new MobileAuthError(
      400,
      'invalid_redirect_uri',
      'Mobile redirect URI must be an absolute URL.',
    );
  }

  const scheme = parsed.protocol.toLowerCase();
  if (DANGEROUS_REDIRECT_SCHEMES.has(scheme)) {
    throw new MobileAuthError(
      400,
      'invalid_redirect_uri',
      'Mobile redirect URI uses an unsupported scheme.',
    );
  }
  // Plain http is only permitted for native loopback redirects (RFC 8252).
  // https and private-use app schemes (e.g. com.example.app://) are allowed.
  if (scheme === 'http:' && !isLoopbackHost(parsed.hostname)) {
    throw new MobileAuthError(
      400,
      'invalid_redirect_uri',
      'Mobile redirect URI must use https, a loopback address, or an app scheme.',
    );
  }

  const entries = allowList.map((entry) => entry.trim()).filter(Boolean);
  if (entries.length > 0) {
    const allowed = entries.some((entry) =>
      redirectUriMatchesAllowEntry(parsed, redirectUri, entry),
    );
    if (!allowed) {
      throw new MobileAuthError(
        400,
        'invalid_redirect_uri',
        'Mobile redirect URI is not allowed.',
      );
    }
  }

  return redirectUri;
}

/**
 * Does a validated redirect URI match one allow-list entry?
 *
 * - A NON-prefix entry (no trailing `/`) is an exact string match.
 * - A prefix entry (trailing `/`) matches on the PARSED URL — same protocol,
 *   same host (incl. port), and the candidate's NORMALIZED pathname starting
 *   with the entry's pathname. Comparing normalized pathnames is what defeats
 *   path traversal: `http://127.0.0.1/cb/../evil/` parses to pathname
 *   `/evil/`, which does not start with `/cb/`, so a raw-string
 *   `startsWith('http://127.0.0.1/cb/')` false-positive can't slip a code to
 *   an unregistered path.
 */
function redirectUriMatchesAllowEntry(
  parsedCandidate: URL,
  candidate: string,
  entry: string,
): boolean {
  if (!entry.endsWith('/')) {
    return candidate === entry;
  }
  let parsedEntry: URL;
  try {
    parsedEntry = new URL(entry);
  } catch {
    return false;
  }
  return (
    parsedCandidate.protocol === parsedEntry.protocol &&
    parsedCandidate.host === parsedEntry.host &&
    parsedCandidate.pathname.startsWith(parsedEntry.pathname)
  );
}

function isModuleNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND' ||
      /Cannot find package '@happyvertical\/smrt-tenancy'/.test(error.message))
  );
}

/**
 * Run `fn` inside smrt-tenancy's system context when the package is
 * available (mirrors `SessionPermissionContext`'s tolerance). Mobile session
 * resolution and tenant enumeration are inherently CROSS-tenant reads —
 * under strict tenancy interceptors they must not be pinned to any single
 * tenant context.
 */
async function runWithSystemContext<T>(fn: () => Promise<T>): Promise<T> {
  try {
    const tenancy = await import('@happyvertical/smrt-tenancy');
    return await tenancy.withSystemContext(fn);
  } catch (error) {
    if (isModuleNotFoundError(error)) {
      return await fn();
    }
    throw error;
  }
}

interface TenantOptionSources {
  memberships: Membership[];
  tenantById: Map<string, Tenant>;
  roleById: Map<string, Role>;
}

/**
 * Server implementation of the `/api/mobile` auth + session contract.
 *
 * Framework-agnostic: methods take plain wire DTOs and header strings and
 * return wire DTOs or throw {@link MobileAuthError}. The SvelteKit adapters
 * live in `@happyvertical/smrt-users/sveltekit`
 * (`createMobileAuthHandlers`).
 */
export class MobileAuthService {
  private readonly options: MobileAuthServiceOptions;
  private readonly classOptions: SmrtClassOptions;
  private readonly sessionTtl: number;
  private readonly transactionTtl: number;
  private sessionService!: SessionService;
  private userCollection!: UserCollection;
  private membershipCollection!: MembershipCollection;
  private roleCollection!: RoleCollection;
  private tenantCollection!: TenantCollection;
  /** Per-(provider, redirectUri) service cache preserving metadata caches. */
  private readonly oidcServices = new Map<string, OidcLoginService>();

  constructor(options: MobileAuthServiceOptions) {
    const {
      fetch: _fetch,
      clockTolerance: _clockTolerance,
      redirectUris: _redirectUris,
      sessionTtl,
      transactionTtl,
      stateSecret: _stateSecret,
      allowUnsignedState: _allowUnsignedState,
      includeInheritedTenants: _includeInheritedTenants,
      allowUnverifiedEmail: _allowUnverifiedEmail,
      resolveUser: _resolveUser,
      resolveTenantId: _resolveTenantId,
      buildExtras: _buildExtras,
      defaultProvider: _defaultProvider,
      providers: _providers,
      ...classOptions
    } = options;
    this.options = options;
    this.classOptions = classOptions;
    this.sessionTtl =
      sessionTtl && sessionTtl > 0
        ? Math.floor(sessionTtl)
        : DEFAULT_MOBILE_SESSION_TTL_SECONDS;
    this.transactionTtl =
      transactionTtl && transactionTtl > 0
        ? Math.floor(transactionTtl)
        : DEFAULT_MOBILE_TRANSACTION_TTL_SECONDS;
  }

  private async initialize(): Promise<void> {
    this.sessionService = await SessionService.create({
      ...this.classOptions,
      defaultTTL: this.sessionTtl,
    });
    this.userCollection = await UserCollection.create(this.classOptions);
    this.membershipCollection = await MembershipCollection.create(
      this.classOptions,
    );
    this.roleCollection = await RoleCollection.create(this.classOptions);
    this.tenantCollection = await TenantCollection.create(this.classOptions);
  }

  static async create(
    options: MobileAuthServiceOptions,
  ): Promise<MobileAuthService> {
    const service = new MobileAuthService(options);
    await service.initialize();
    return service;
  }

  /**
   * The underlying {@link SessionService}. Exposed so route guards can share
   * it with `withSessionPermissionContext` instead of minting a second one.
   */
  getSessionService(): SessionService {
    return this.sessionService;
  }

  private resolveProvider(requested: string | null | undefined) {
    try {
      return resolveOidcProviderConfig(
        normalizeOptionalString(requested),
        this.options,
      );
    } catch (error) {
      const message =
        error instanceof OidcLoginError
          ? error.message
          : 'Unknown mobile auth provider.';
      throw new MobileAuthError(400, 'unknown_provider', message);
    }
  }

  private getOidcService(
    providerName: string,
    redirectUri: string,
  ): OidcLoginService {
    const key = `${providerName}\n${redirectUri}`;
    const cached = this.oidcServices.get(key);
    if (cached) {
      // LRU: re-insert so the hot entry moves to the newest slot and eviction
      // drops a genuinely-cold provider rather than the one in active use.
      this.oidcServices.delete(key);
      this.oidcServices.set(key, cached);
      return cached;
    }

    const { provider } = this.resolveProvider(providerName);
    const service = new OidcLoginService({
      ...this.classOptions,
      fetch: this.options.fetch,
      clockTolerance: this.options.clockTolerance,
      provider: { ...provider, redirectUri },
      providerName,
    });

    // Bounded cache: redirect URIs are allow-list validated before we get
    // here, but a no-allow-list dev setup must not grow this unboundedly.
    // Map iteration is insertion-order, so with re-insert-on-hit above the
    // first key is the least-recently-used entry.
    if (this.oidcServices.size >= MAX_OIDC_SERVICE_CACHE) {
      const lru = this.oidcServices.keys().next().value;
      if (lru !== undefined) this.oidcServices.delete(lru);
    }
    this.oidcServices.set(key, service);
    return service;
  }

  /**
   * The HMAC secret for state signing, or `undefined` when unsigned tokens
   * are explicitly permitted via {@link MobileAuthServiceOptions.allowUnsignedState}.
   * Fails closed (throws → 500 `server_misconfigured`) when no secret is
   * available and unsigned tokens are not opted in, so a deployment can never
   * silently fall back to forgeable state tokens.
   */
  private stateSecretFor(provider: {
    clientSecret?: string;
  }): string | undefined {
    const secret = this.options.stateSecret ?? provider.clientSecret;
    if (secret && secret.length > 0) {
      return secret;
    }
    if (this.options.allowUnsignedState === true) {
      return undefined;
    }
    throw new MobileAuthError(
      500,
      'server_misconfigured',
      'Mobile auth is not configured for signed state. Set a stateSecret (or provider clientSecret), or opt into allowUnsignedState.',
    );
  }

  /**
   * `POST /api/mobile/auth/start` — begin the server-brokered PKCE
   * handshake. Returns the authorization URL plus the `state` and
   * `codeVerifier` the client must persist and echo back on complete.
   */
  async start(input: MobileAuthStartRequest): Promise<MobileAuthStartResponse> {
    const resolution = this.resolveProvider(input.providerId);
    const redirectUri = validateMobileRedirectUri(
      input.redirectUri,
      this.options.redirectUris,
    );

    const clientState = normalizeOptionalString(input.state);
    if (clientState && clientState.length > MAX_CLIENT_STATE_LENGTH) {
      throw new MobileAuthError(
        400,
        'invalid_request',
        `Client state exceeds ${MAX_CLIENT_STATE_LENGTH} characters.`,
      );
    }

    const service = this.getOidcService(resolution.providerName, redirectUri);
    const base = service.createTransaction();
    const state = await encodeMobileState(
      {
        v: 1,
        s: randomBase64Url(16),
        n: base.nonce,
        p: resolution.providerName,
        t: Date.now(),
        c: clientState,
      },
      this.stateSecretFor(resolution.provider),
    );
    const transaction: OidcTransaction = { ...base, state };

    const scopes = Array.isArray(input.scopes)
      ? input.scopes
          .filter((scope): scope is string => typeof scope === 'string')
          .map((scope) => scope.trim())
          .filter(Boolean)
      : [];
    const loginHint = normalizeOptionalString(input.loginHint);

    let url: URL;
    try {
      ({ url } = await service.createAuthorizationUrl({
        transaction,
        authorizationParams: {
          ...(scopes.length > 0 ? { scope: scopes.join(' ') } : {}),
          ...(loginHint ? { login_hint: loginHint } : {}),
        },
      }));
    } catch (error) {
      const message =
        error instanceof OidcLoginError
          ? error.message
          : 'Mobile auth provider is unavailable.';
      throw new MobileAuthError(502, 'provider_unavailable', message);
    }

    return {
      providerId: resolution.providerName,
      authorizationUrl: url.toString(),
      state,
      codeVerifier: transaction.codeVerifier,
      nonce: transaction.nonce,
      redirectUri,
    };
  }

  /**
   * `POST /api/mobile/auth/complete` — exchange the authorization code (with
   * the echoed `state` + `codeVerifier`) for a mobile bearer session.
   */
  async complete(
    input: MobileAuthCompleteRequest,
    meta: MobileRequestMeta = {},
  ): Promise<MobileAuthSession> {
    const code = normalizeOptionalString(input.code);
    if (!code) {
      throw new MobileAuthError(
        400,
        'invalid_request',
        'Missing authorization code.',
      );
    }
    const rawState = normalizeOptionalString(input.state);
    if (!rawState) {
      throw new MobileAuthError(
        401,
        'invalid_state',
        'Missing mobile auth state.',
      );
    }
    const codeVerifier = normalizeOptionalString(input.codeVerifier);
    if (!codeVerifier) {
      throw new MobileAuthError(
        400,
        'missing_code_verifier',
        'Missing PKCE code verifier.',
      );
    }
    const redirectUri = validateMobileRedirectUri(
      input.redirectUri,
      this.options.redirectUris,
    );

    // The state token names the provider the handshake was started for; a
    // client-supplied providerId must agree with it.
    const requestedProvider = normalizeOptionalString(input.providerId);
    const probe = this.resolveProvider(requestedProvider);
    const payload = await decodeMobileState(
      rawState,
      this.stateSecretFor(probe.provider),
    );
    if (payload.p !== probe.providerName) {
      throw new MobileAuthError(
        401,
        'invalid_state',
        'Mobile auth state does not match the requested provider.',
      );
    }
    const age = Date.now() - payload.t;
    if (age > this.transactionTtl * 1000 || age < -STATE_TOKEN_CLOCK_SKEW_MS) {
      throw new MobileAuthError(
        401,
        'expired_transaction',
        'Mobile auth handshake has expired. Start a new sign-in.',
      );
    }

    const transaction: OidcTransaction = {
      codeVerifier,
      createdAt: payload.t,
      nonce: payload.n,
      provider: payload.p,
      state: rawState,
    };

    const service = this.getOidcService(probe.providerName, redirectUri);
    const callbackUrl = new URL(redirectUri);
    callbackUrl.searchParams.set('code', code);
    callbackUrl.searchParams.set('state', rawState);

    let claims: OidcClaims;
    let tokens: OidcTokenSet;
    try {
      ({ claims, tokens } = await service.exchangeCallback(
        callbackUrl,
        transaction,
      ));
    } catch (error) {
      const message =
        error instanceof OidcLoginError
          ? error.message
          : 'Mobile auth code exchange failed.';
      throw new MobileAuthError(401, 'exchange_failed', message);
    }

    const resolved = await this.resolveUserFromLogin({
      claims,
      tokens,
      providerName: probe.providerName,
    });
    if (!resolved?.id) {
      throw new MobileAuthError(
        403,
        'signin_not_permitted',
        'This account is not permitted to sign in.',
      );
    }

    const tenants = await this.listTenantOptions(resolved.id);
    const tenantId = await this.resolveSessionTenantId(
      { userId: resolved.id, claims, providerName: probe.providerName },
      tenants,
    );

    const sessionId = await this.sessionService.createSession(
      resolved.id,
      tenantId ?? undefined,
      {
        ttl: this.sessionTtl,
        userAgent: meta.userAgent,
        ipAddress: meta.ipAddress,
        data: {
          source: 'mobile',
          oidcProvider: probe.providerName,
          // Cap the stored IdP-sourced strings so a hostile/misbehaving IdP
          // cannot bloat every session row (iss is already constrained to the
          // configured issuer; sub is bounded defensively).
          oidcIssuer: claims.iss.slice(0, MAX_STORED_CLAIM_LENGTH),
          oidcSubject: claims.sub.slice(0, MAX_STORED_CLAIM_LENGTH),
        },
      },
    );

    const email = resolved.email ?? claims.email ?? '';
    return {
      accessToken: sessionId,
      tokenType: 'Bearer',
      expiresAt: new Date(Date.now() + this.sessionTtl * 1000).toISOString(),
      user: this.toUserSummary(resolved.id, email),
      activeTenant: tenants.find((tenant) => tenant.id === tenantId) ?? null,
      tenants,
    };
  }

  private async resolveUserFromLogin(
    context: MobileLoginContext,
  ): Promise<MobileResolvedUser | null | undefined> {
    if (this.options.resolveUser) {
      return this.options.resolveUser(context);
    }
    const result = await this.userCollection.getOrCreateFromOidc(
      context.claims,
      context.providerName,
      { allowUnverifiedEmail: this.options.allowUnverifiedEmail },
    );
    const id = result.user.id as string | undefined;
    if (!id) return null;
    return { id, email: result.user.email };
  }

  private async resolveSessionTenantId(
    context: MobileTenantContext,
    tenants: MobileTenantOption[],
  ): Promise<string | null> {
    if (this.options.resolveTenantId) {
      const chosen = await this.options.resolveTenantId(context);
      if (chosen !== undefined) return chosen;
    }
    // Default: the first DIRECT membership tenant (options are sorted by
    // name; inherited descendants are excluded because `switchTenant` — and
    // any flow that verifies direct membership — must accept the default).
    const direct = await runWithSystemContext(() =>
      this.membershipCollection.findActiveByUser(context.userId),
    );
    const directIds = new Set(
      direct
        .map((membership) => membership.tenantId)
        .filter((id): id is string => Boolean(id)),
    );
    return tenants.find((tenant) => directIds.has(tenant.id))?.id ?? null;
  }

  /**
   * `GET /api/mobile/session` — bootstrap the app from a bearer token.
   * Throws 401 when the token is missing, unknown, expired, or revoked.
   */
  async bootstrap(
    authorizationHeader: string | null | undefined,
  ): Promise<MobileSessionBootstrap> {
    const context = await this.resolveSessionContext(authorizationHeader);
    const userId = context.user.id as string;
    const tenants = await this.listTenantOptions(userId);
    const activeTenant =
      tenants.find((tenant) => tenant.id === context.tenantId) ?? null;

    const extras = this.options.buildExtras
      ? await this.options.buildExtras({
          session: context,
          permissions: context.permissions,
          tenants,
          activeTenant,
        })
      : undefined;

    return {
      user: this.toUserSummary(userId, context.user.email ?? ''),
      activeTenant,
      tenants,
      ...(extras ? { extras } : {}),
    };
  }

  /**
   * Resolve a bearer header into a full {@link SessionContext} (user,
   * membership, resolved permissions, tenant). Throws {@link MobileAuthError}
   * with the 401 semantics the mobile client's re-auth flow expects.
   */
  async resolveSessionContext(
    authorizationHeader: string | null | undefined,
  ): Promise<SessionContext> {
    const token = readMobileBearerToken(authorizationHeader);
    if (!token) {
      throw new MobileAuthError(
        401,
        'missing_bearer_token',
        'Missing mobile bearer token.',
      );
    }
    // System context: session loading resolves permissions across the
    // user's memberships, which strict tenancy interceptors reject outside
    // an explicit context. Request-scoped tenant entry belongs to the route
    // guard (`withSessionPermissionContext`), not here.
    const context = await runWithSystemContext(() =>
      this.sessionService.loadSessionContext(token),
    );
    if (!context?.user?.id) {
      throw new MobileAuthError(
        401,
        'invalid_bearer_token',
        'Invalid or expired mobile bearer token.',
      );
    }
    return context;
  }

  /**
   * `DELETE /api/mobile/session` — revoke the bearer session. Idempotent:
   * a missing or unknown token reports `destroyed: false` with 200.
   */
  async logout(
    authorizationHeader: string | null | undefined,
  ): Promise<MobileLogoutResult> {
    const token = readMobileBearerToken(authorizationHeader);
    if (!token) return { ok: true, destroyed: false };
    const destroyed = await this.sessionService.destroySession(token);
    return { ok: true, destroyed };
  }

  /**
   * The user's selectable tenants: direct ACTIVE memberships plus — when
   * `includeInheritedTenants` is on (default) — descendant tenants reachable
   * through an ACTIVE membership whose role has `inheritsToDescendants:
   * true` (#1867). Selection mirrors the permission resolver: the NEAREST
   * flagged ancestor membership labels an inherited option, unflagged or
   * inactive ancestors neither confer nor block, and ANY direct membership
   * row on a tenant pins it (active → its own role; inactive → excluded,
   * since a pinned inactive row resolves to the empty permission set).
   *
   * This list is informational — per-request authorization always re-runs
   * through `PermissionResolver`, which additionally fail-closes on
   * malformed hierarchy paths.
   */
  async listTenantOptions(userId: string): Promise<MobileTenantOption[]> {
    // One system-context entry for the whole cross-tenant computation (session
    // resolution and tenant enumeration span tenants, so a single-tenant
    // context would be wrong); the nested reads below inherit it.
    return runWithSystemContext(() => this.buildTenantOptions(userId));
  }

  private async buildTenantOptions(
    userId: string,
  ): Promise<MobileTenantOption[]> {
    const { memberships, tenantById, roleById } =
      await this.loadTenantOptionSources(userId);

    const active = memberships.filter(
      (membership) => membership.isActive() && membership.tenantId,
    );
    // Pin from ALL rows (any status), NOT just active ones: a direct
    // membership row always pins its tenant in the resolver, and an INACTIVE
    // direct row pins to the empty set. So an inactive direct row on a
    // descendant must EXCLUDE that descendant from the inherited list (below)
    // — narrowing this to active-only would wrongly surface it as inherited.
    const pinnedTenantIds = new Set(
      memberships
        .map((membership) => membership.tenantId)
        .filter((id): id is string => Boolean(id)),
    );

    const options: MobileTenantOption[] = [];
    for (const membership of active) {
      const tenant = tenantById.get(membership.tenantId as string);
      if (!tenant?.id) continue;
      const role = membership.roleId
        ? roleById.get(membership.roleId)
        : undefined;
      options.push(this.toTenantOption(tenant, role));
    }

    if (this.options.includeInheritedTenants !== false) {
      const activeByTenant = new Map<string, Membership>();
      for (const membership of active) {
        activeByTenant.set(membership.tenantId as string, membership);
      }
      const isFlagged = (membership: Membership | undefined): boolean => {
        const role = membership?.roleId
          ? roleById.get(membership.roleId)
          : undefined;
        return role?.inheritsToDescendants === true;
      };

      // Batch the descendant reads across all flagged memberships instead of
      // awaiting one per membership in series.
      const flaggedTenantIds = active
        .filter(isFlagged)
        .map((membership) => membership.tenantId as string);
      const descendantLists = await Promise.all(
        flaggedTenantIds.map((tenantId) =>
          this.tenantCollection.getDescendants(tenantId),
        ),
      );

      const candidates = new Map<string, Tenant>();
      for (const descendants of descendantLists) {
        for (const descendant of descendants) {
          if (!descendant.id) continue;
          if (pinnedTenantIds.has(descendant.id)) continue;
          if (!candidates.has(descendant.id)) {
            candidates.set(descendant.id, descendant);
          }
        }
      }

      for (const descendant of candidates.values()) {
        // Nearest ancestor first (getAncestorIds is root → parent order).
        const ancestorIds = descendant.getAncestorIds();
        for (let i = ancestorIds.length - 1; i >= 0; i -= 1) {
          const ancestorMembership = activeByTenant.get(ancestorIds[i]);
          if (!isFlagged(ancestorMembership)) continue;
          const role = roleById.get(ancestorMembership?.roleId as string);
          options.push(this.toTenantOption(descendant, role));
          break;
        }
      }
    }

    return options.sort(
      (a, b) =>
        (a.name ?? '').localeCompare(b.name ?? '', undefined, {
          sensitivity: 'base',
        }) || a.id.localeCompare(b.id),
    );
  }

  private async loadTenantOptionSources(
    userId: string,
  ): Promise<TenantOptionSources> {
    const memberships = await this.membershipCollection.findByUser(userId);
    const active = memberships.filter(
      (membership) => membership.isActive() && membership.tenantId,
    );

    const tenantIds = [
      ...new Set(active.map((membership) => membership.tenantId as string)),
    ];
    const roleIds = [
      ...new Set(
        active
          .map((membership) => membership.roleId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];

    const [tenants, roles] = await Promise.all([
      tenantIds.length > 0
        ? this.tenantCollection.listByIds(tenantIds)
        : Promise.resolve([]),
      roleIds.length > 0
        ? this.roleCollection.listByIds(roleIds)
        : Promise.resolve([]),
    ]);

    return {
      memberships,
      tenantById: new Map(
        tenants
          .filter((tenant): tenant is Tenant => Boolean(tenant?.id))
          .map((tenant) => [tenant.id as string, tenant]),
      ),
      roleById: new Map(
        roles
          .filter((role): role is Role => Boolean(role?.id))
          .map((role) => [role.id as string, role]),
      ),
    };
  }

  private toTenantOption(tenant: Tenant, role: Role | undefined) {
    return {
      id: tenant.id as string,
      name: tenant.name ?? '',
      slug: tenant.slug ?? '',
      roleSlug: role?.slug ?? '',
      roleLabel: role?.name || role?.slug || '',
    } satisfies MobileTenantOption;
  }

  private toUserSummary(id: string, email: string): MobileUserSummary {
    return { id, email, label: email || id };
  }
}
