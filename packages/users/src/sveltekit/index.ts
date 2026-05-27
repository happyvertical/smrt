/**
 * SvelteKit integration for session management
 * @packageDocumentation
 *
 * @example
 * ```typescript
 * // hooks.server.ts
 * import { createSessionHandler } from '@happyvertical/smrt-users/sveltekit';
 * import { sequence } from '@sveltejs/kit/hooks';
 *
 * const sessionHandler = createSessionHandler({
 *   db: { type: 'postgres', url: process.env.DATABASE_URL }
 * });
 *
 * export const handle = sequence(sessionHandler);
 * ```
 */

// Consumers that import from this subpath (e.g.
// `@happyvertical/smrt-users/sveltekit`) typically do NOT also import the
// package root, so the root's `__smrt-register__` side effect never runs
// — and `SessionService` / `Session` would then evaluate their @smrt()
// decorators against an empty manifest, falling back to zero-field
// metadata (the original bug from issue #1132). Importing the registration
// shim here makes this subpath self-sufficient.
import '../__smrt-register__.js';

import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { DEFAULT_SESSION_TTL } from '../models/Session.js';
import {
  decodeOidcTransaction,
  encodeOidcTransaction,
  getUsersOidcConfig,
  OidcLoginError,
  type OidcLoginResult,
  OidcLoginService,
  type OidcProviderConfig,
  type OidcProviderResolutionOptions,
  type OidcTransaction,
  type ResolvedOidcProviderConfig,
  resolveOidcProviderConfig,
} from '../services/OidcLoginService.js';
import { withSessionPermissionContext } from '../services/SessionPermissionContext.js';
import { SessionService } from '../services/SessionService.js';
import {
  type ApproveCliAuthRequestInput,
  TerminalAuthError,
  TerminalAuthService,
  type TerminalAuthServiceOptions,
} from '../services/TerminalAuthService.js';

export { defaultSessionLocals, type SessionLocals } from './types.js';

/**
 * Options for session handler
 */
export interface SessionHandlerOptions extends SmrtClassOptions {
  /** Cookie name (default: 'sid') */
  cookieName?: string;
  /** Session TTL in seconds (default: 7 days) */
  ttl?: number;
  /** Paths to skip session loading (e.g., '/api/health') */
  skipPaths?: string[];
  /** Whether to auto-extend sessions on each request (default: false) */
  autoExtend?: boolean;
  /** Cookie domain (default: undefined, uses request domain) */
  cookieDomain?: string;
  /** Cookie path (default: '/') */
  cookiePath?: string;
  /** Whether cookies are secure (default: true in production) */
  cookieSecure?: boolean;
  /** SameSite cookie attribute (default: 'lax') */
  cookieSameSite?: 'strict' | 'lax' | 'none';
  /** Whether to enter smrt-tenancy request context when tenant data exists */
  enterTenantContext?: boolean;
  /** Whether to enforce Postgres RLS via request-scoped transactions */
  postgresRls?: boolean;
}

/**
 * SvelteKit Handle type (minimal definition to avoid requiring @sveltejs/kit as dependency)
 */
type HandleInput = {
  event: {
    cookies: {
      get: (name: string) => string | undefined;
      set: (
        name: string,
        value: string,
        options?: Record<string, unknown>,
      ) => void;
      delete: (name: string, options?: Record<string, unknown>) => void;
    };
    locals: Record<string, unknown>;
    url: { pathname: string; protocol?: string };
    request: { headers: Headers };
  };
  resolve: (event: unknown) => Promise<Response>;
};

type Handle = (input: HandleInput) => Promise<Response>;

type SvelteKitRequestEvent = {
  cookies: HandleInput['event']['cookies'];
  getClientAddress?: () => string;
  locals?: Record<string, unknown>;
  params?: Record<string, string | undefined>;
  request: Request;
  url: URL;
};

type OidcProviderResolver =
  | string
  | ((event: SvelteKitRequestEvent) => string | undefined);

type OidcStringResolver<T> =
  | T
  | ((result: OidcLoginResult, event: SvelteKitRequestEvent) => T | Promise<T>);

export interface OidcSvelteKitOptions
  extends SmrtClassOptions,
    OidcProviderResolutionOptions {
  /** Optional fetch override for tests or custom runtimes. */
  fetch?: typeof fetch;
  /** JWT clock tolerance passed to jose. */
  clockTolerance?: number | string;
  /** Provider name, or a resolver. Defaults to event.params.provider. */
  provider?: OidcProviderResolver;
  /** Callback path used when provider.redirectUri is omitted. */
  callbackPath?: string | ((providerName: string) => string);
  /** Query parameter used to preserve post-login redirects. */
  returnToParam?: string;
  /** Prefix for the temporary OIDC transaction cookie. */
  transactionCookiePrefix?: string;
  /** Temporary transaction cookie TTL in seconds. Default: 10 minutes. */
  transactionTtl?: number;
  /** Cookie path for the temporary OIDC transaction. */
  transactionCookiePath?: string;
  /** Secure flag for the temporary OIDC transaction cookie. */
  transactionCookieSecure?: boolean;
  /** SameSite value for the temporary OIDC transaction cookie. */
  transactionCookieSameSite?: 'strict' | 'lax' | 'none';
  /** HMAC secret for transaction cookie integrity. Defaults to clientSecret. */
  transactionCookieSecret?: string;
  /** Session cookie name. Defaults to sid. */
  sessionCookieName?: string;
  /** Session cookie path. Defaults to /. */
  sessionCookiePath?: string;
  /** Secure flag for the session cookie. Defaults to true on HTTPS. */
  sessionCookieSecure?: boolean;
  /** SameSite value for the session cookie. */
  sessionCookieSameSite?: 'strict' | 'lax' | 'none';
  /** Session TTL in seconds. Defaults to the package session default. */
  sessionTtl?: number;
  /** Optional tenant to bind to the session. */
  tenantId?: OidcStringResolver<string | null | undefined>;
  /** Redirect target after successful callback. */
  successRedirect?: OidcStringResolver<string>;
  /** Redirect target after failed callback. If omitted, failures return 401. */
  failureRedirect?:
    | string
    | ((error: unknown, event: SvelteKitRequestEvent) => string);
}

export interface BeginOidcLoginResult {
  providerName: string;
  transaction: OidcTransaction;
  url: URL;
}

export interface CompleteOidcLoginResult extends OidcLoginResult {
  providerName: string;
  returnTo?: string;
  sessionId: string;
}

/**
 * Creates a SvelteKit handle hook for session management.
 *
 * This hook:
 * 1. Reads the session cookie
 * 2. Loads session context (user + permissions) if valid
 * 3. Populates event.locals with user, permissions, tenantId, sessionId
 * 4. Optionally extends session on each request
 *
 * @example
 * ```typescript
 * // hooks.server.ts
 * import { createSessionHandler } from '@happyvertical/smrt-users/sveltekit';
 *
 * const sessionHandler = createSessionHandler({
 *   db: { type: 'sqlite', url: 'app.db' },
 *   cookieName: 'sid',
 *   ttl: 7 * 24 * 60 * 60, // 7 days
 *   skipPaths: ['/api/health', '/api/public'],
 * });
 *
 * export const handle = sessionHandler;
 * // Or with sequence:
 * // export const handle = sequence(sessionHandler, otherHandler);
 * ```
 */
export function createSessionHandler(options: SessionHandlerOptions): Handle {
  const cookieName = options.cookieName ?? 'sid';
  const ttl = options.ttl ?? DEFAULT_SESSION_TTL;
  const skipPaths = options.skipPaths ?? [];
  const cookiePath = options.cookiePath ?? '/';
  const cookieSameSite = options.cookieSameSite ?? 'lax';

  // Lazy-initialized session service
  let sessionService: SessionService | null = null;

  const getSessionService = async (): Promise<SessionService> => {
    if (!sessionService) {
      sessionService = await SessionService.create({
        ...options,
        defaultTTL: ttl,
        autoExtend: options.autoExtend ?? false,
      });
    }
    return sessionService;
  };

  return async ({ event, resolve }) => {
    // Initialize locals with defaults (use property assignment for type safety)
    event.locals.user = null;
    event.locals.permissions = [];
    event.locals.tenantId = null;
    event.locals.sessionId = null;

    // Skip session loading for certain paths
    if (skipPaths.some((path) => event.url.pathname.startsWith(path))) {
      return resolve(event);
    }

    // Get session ID from cookie
    const sessionId = event.cookies.get(cookieName);
    if (!sessionId && !options.postgresRls) {
      return resolve(event);
    }

    try {
      const service = await getSessionService();
      return await withSessionPermissionContext(
        {
          ...options,
          enterTenantContext: options.enterTenantContext,
          postgresRls: options.postgresRls,
          sessionId,
          sessionService: service,
        },
        async (context) => {
          if (context.session) {
            event.locals.user = context.user;
            event.locals.permissions = context.permissions;
            event.locals.tenantId = context.tenantId;
            event.locals.sessionId = context.sessionId;
          }

          return resolve(event);
        },
      );
    } catch (error) {
      console.error('Session or request context initialization error:', error);

      if (options.postgresRls) {
        return new Response('Internal Server Error', { status: 500 });
      }

      return resolve(event);
    }
  };
}

/**
 * Options for creating a session cookie
 */
export interface CreateSessionCookieOptions {
  /** Session TTL in seconds (default: 7 days) */
  ttl?: number;
  /** User agent string */
  userAgent?: string;
  /** Client IP address */
  ipAddress?: string;
  /** Custom session data */
  data?: Record<string, unknown>;
}

// Store for session service instances (keyed by db config hash)
const sessionServiceCache = new Map<string, SessionService>();

/**
 * Get or create a cached session service instance
 */
async function getOrCreateSessionService(
  options: SmrtClassOptions,
  ttl: number,
): Promise<SessionService> {
  // Simple cache key based on db config
  const cacheKey = JSON.stringify(options.db);

  let service = sessionServiceCache.get(cacheKey);
  if (!service) {
    service = await SessionService.create({
      ...options,
      defaultTTL: ttl,
    });
    sessionServiceCache.set(cacheKey, service);
  }
  return service;
}

/**
 * Helper to create a session and set the cookie after login.
 *
 * @example
 * ```typescript
 * // +page.server.ts
 * import { createSessionCookie } from '@happyvertical/smrt-users/sveltekit';
 * import { redirect } from '@sveltejs/kit';
 *
 * export const actions = {
 *   login: async (event) => {
 *     // Validate credentials...
 *     const user = await validateLogin(email, password);
 *
 *     await createSessionCookie(event, user.id, tenantId, {
 *       db: { type: 'sqlite', url: 'app.db' },
 *       ipAddress: event.getClientAddress(),
 *       userAgent: event.request.headers.get('user-agent') ?? '',
 *     });
 *
 *     throw redirect(303, '/dashboard');
 *   }
 * };
 * ```
 */
export async function createSessionCookie(
  event: HandleInput['event'],
  userId: string,
  tenantId: string | undefined,
  options: SmrtClassOptions &
    CreateSessionCookieOptions & {
      cookieName?: string;
      cookiePath?: string;
      cookieSecure?: boolean;
      cookieSameSite?: 'strict' | 'lax' | 'none';
    },
): Promise<string> {
  const cookieName = options.cookieName ?? 'sid';
  const ttl = options.ttl ?? DEFAULT_SESSION_TTL;
  const cookiePath = options.cookiePath ?? '/';
  const cookieSameSite = options.cookieSameSite ?? 'lax';
  const cookieSecure = options.cookieSecure ?? event.url.protocol === 'https:';

  const service = await getOrCreateSessionService(options, ttl);

  const sessionId = await service.createSession(userId, tenantId, {
    ttl,
    userAgent: options.userAgent,
    ipAddress: options.ipAddress,
    data: options.data,
  });

  event.cookies.set(cookieName, sessionId, {
    path: cookiePath,
    httpOnly: true,
    secure: cookieSecure,
    sameSite: cookieSameSite,
    maxAge: ttl,
  });

  return sessionId;
}

/**
 * Helper to destroy a session and delete the cookie on logout.
 *
 * @example
 * ```typescript
 * // +page.server.ts
 * import { destroySessionCookie } from '@happyvertical/smrt-users/sveltekit';
 * import { redirect } from '@sveltejs/kit';
 *
 * export const actions = {
 *   logout: async (event) => {
 *     await destroySessionCookie(event, {
 *       db: { type: 'sqlite', url: 'app.db' }
 *     });
 *     throw redirect(303, '/');
 *   }
 * };
 * ```
 */
export async function destroySessionCookie(
  event: HandleInput['event'],
  options: SmrtClassOptions & {
    cookieName?: string;
    cookiePath?: string;
    ttl?: number;
  },
): Promise<void> {
  const cookieName = options.cookieName ?? 'sid';
  const cookiePath = options.cookiePath ?? '/';
  const ttl = options.ttl ?? DEFAULT_SESSION_TTL;

  const sessionId = event.cookies.get(cookieName);

  if (sessionId) {
    try {
      const service = await getOrCreateSessionService(options, ttl);
      await service.destroySession(sessionId);
    } catch (error) {
      // Log but don't fail - cookie will be deleted regardless
      console.error('Session destruction error:', error);
    }
  }

  event.cookies.delete(cookieName, { path: cookiePath });
}

/**
 * Helper to switch tenant context for the current session.
 *
 * @example
 * ```typescript
 * // +page.server.ts
 * import { switchSessionTenant } from '@happyvertical/smrt-users/sveltekit';
 *
 * export const actions = {
 *   switchTenant: async (event) => {
 *     const data = await event.request.formData();
 *     const tenantId = data.get('tenantId') as string;
 *
 *     await switchSessionTenant(event, tenantId, {
 *       db: { type: 'sqlite', url: 'app.db' }
 *     });
 *
 *     return { success: true };
 *   }
 * };
 * ```
 */
export async function switchSessionTenant(
  event: HandleInput['event'],
  tenantId: string | null,
  options: SmrtClassOptions & {
    cookieName?: string;
    ttl?: number;
  },
): Promise<boolean> {
  const cookieName = options.cookieName ?? 'sid';
  const ttl = options.ttl ?? DEFAULT_SESSION_TTL;

  const sessionId = event.cookies.get(cookieName);
  if (!sessionId) return false;

  const service = await getOrCreateSessionService(options, ttl);
  return service.switchTenant(sessionId, tenantId);
}

function getOidcProviderName(
  event: SvelteKitRequestEvent,
  options: OidcSvelteKitOptions,
): string | undefined {
  if (typeof options.provider === 'function') {
    return options.provider(event);
  }

  return options.provider ?? event.params?.provider ?? options.defaultProvider;
}

function getOidcTransactionCookieName(
  providerName: string,
  options: OidcSvelteKitOptions,
): string {
  const prefix = options.transactionCookiePrefix ?? 'smrt_oidc';
  const safeProvider = providerName.replace(/[^a-z0-9_-]/giu, '_');
  return `${prefix}_${safeProvider}`;
}

function useSecureCookie(
  event: SvelteKitRequestEvent,
  explicit?: boolean,
): boolean {
  return explicit ?? event.url.protocol === 'https:';
}

function resolveCallbackPath(
  providerName: string,
  options: OidcSvelteKitOptions,
): string {
  if (typeof options.callbackPath === 'function') {
    return options.callbackPath(providerName);
  }

  return options.callbackPath ?? `/auth/${providerName}/callback`;
}

function resolveProviderWithRedirectUri(
  event: SvelteKitRequestEvent,
  providerName: string,
  provider: OidcProviderConfig,
  options: OidcSvelteKitOptions,
): ResolvedOidcProviderConfig {
  return {
    ...provider,
    redirectUri:
      provider.redirectUri ??
      new URL(
        resolveCallbackPath(providerName, options),
        event.url.origin,
      ).toString(),
  };
}

function createOidcService(
  event: SvelteKitRequestEvent,
  options: OidcSvelteKitOptions,
): OidcLoginService {
  const providerName = getOidcProviderName(event, options);
  const resolved = resolveOidcProviderConfig(providerName, options);
  const provider = resolveProviderWithRedirectUri(
    event,
    resolved.providerName,
    resolved.provider,
    options,
  );

  return new OidcLoginService({
    ...options,
    provider,
    providerName: resolved.providerName,
  });
}

function getReturnTo(
  event: SvelteKitRequestEvent,
  options: OidcSvelteKitOptions,
): string | undefined {
  const param = options.returnToParam ?? 'returnTo';
  return getLocalReturnTo(event.url.searchParams.get(param));
}

function getLocalReturnTo(
  returnTo: string | null | undefined,
): string | undefined {
  if (!returnTo) return undefined;
  // Keep return targets local to avoid open redirects.
  if (returnTo.startsWith('/') && !returnTo.startsWith('//')) {
    return returnTo;
  }

  return undefined;
}

function getTransactionCookieSameSite(
  event: SvelteKitRequestEvent,
  options: OidcSvelteKitOptions,
): 'strict' | 'lax' | 'none' {
  if (options.transactionCookieSameSite) {
    return options.transactionCookieSameSite;
  }

  return useSecureCookie(event, options.transactionCookieSecure)
    ? 'none'
    : 'lax';
}

function getTransactionCookieSecret(
  provider: ResolvedOidcProviderConfig,
  options: OidcSvelteKitOptions,
): string | undefined {
  const secret = options.transactionCookieSecret ?? provider.clientSecret;
  return secret && secret.length > 0 ? secret : undefined;
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

async function signTransactionPayload(
  payload: string,
  secret: string,
): Promise<string> {
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

async function encodeOidcTransactionCookie(
  transaction: OidcTransaction,
  secret?: string,
): Promise<string> {
  const payload = encodeOidcTransaction(transaction);
  if (!secret) return payload;

  const signature = await signTransactionPayload(payload, secret);
  return `${payload}.${signature}`;
}

async function decodeOidcTransactionCookie(
  value: string,
  secret?: string,
): Promise<OidcTransaction> {
  if (!secret) return decodeOidcTransaction(value);

  const separatorIndex = value.lastIndexOf('.');
  if (separatorIndex < 0) {
    throw new OidcLoginError('Invalid OIDC login transaction signature.');
  }

  const payload = value.slice(0, separatorIndex);
  const signature = value.slice(separatorIndex + 1);
  const expectedSignature = await signTransactionPayload(payload, secret);
  if (!timingSafeEqual(signature, expectedSignature)) {
    throw new OidcLoginError('Invalid OIDC login transaction signature.');
  }

  return decodeOidcTransaction(payload);
}

function getTransactionTtl(options: OidcSvelteKitOptions): number {
  return (
    options.transactionTtl ?? getUsersOidcConfig().transactionTtl ?? 10 * 60
  );
}

async function resolveTenantId(
  result: OidcLoginResult,
  event: SvelteKitRequestEvent,
  options: OidcSvelteKitOptions,
): Promise<string | null | undefined> {
  if (typeof options.tenantId === 'function') {
    return options.tenantId(result, event);
  }

  return options.tenantId;
}

function redirectResponse(location: string | URL): Response {
  return new Response(null, {
    headers: { location: location.toString() },
    status: 303,
  });
}

function failureResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : 'OIDC login failed.';
  return new Response(message, {
    status: 401,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
    },
  });
}

function resolveSuccessRedirect(
  result: CompleteOidcLoginResult,
  event: SvelteKitRequestEvent,
  options: OidcSvelteKitOptions,
): string | Promise<string> {
  if (typeof options.successRedirect === 'function') {
    return options.successRedirect(result, event);
  }

  return options.successRedirect ?? result.returnTo ?? '/';
}

function resolveFailureRedirect(
  error: unknown,
  event: SvelteKitRequestEvent,
  options: OidcSvelteKitOptions,
): string | undefined {
  if (!options.failureRedirect) return undefined;

  if (typeof options.failureRedirect === 'function') {
    return options.failureRedirect(error, event);
  }

  return options.failureRedirect;
}

/**
 * Start an OIDC login from a SvelteKit route.
 *
 * Sets a short-lived, HTTP-only transaction cookie containing state, nonce,
 * and PKCE verifier, then returns the provider authorization URL.
 */
export async function beginOidcLogin(
  event: SvelteKitRequestEvent,
  options: OidcSvelteKitOptions,
): Promise<BeginOidcLoginResult> {
  const service = createOidcService(event, options);
  const transaction = service.createTransaction(getReturnTo(event, options));
  const result = await service.createAuthorizationUrl({ transaction });

  event.cookies.set(
    getOidcTransactionCookieName(service.providerName, options),
    await encodeOidcTransactionCookie(
      transaction,
      getTransactionCookieSecret(service.provider, options),
    ),
    {
      httpOnly: true,
      maxAge: getTransactionTtl(options),
      path: options.transactionCookiePath ?? '/',
      sameSite: getTransactionCookieSameSite(event, options),
      secure: useSecureCookie(event, options.transactionCookieSecure),
    },
  );

  return {
    providerName: service.providerName,
    transaction,
    url: result.url,
  };
}

/**
 * Complete an OIDC callback, create or update the SMRT user/profile, and set
 * the session cookie.
 */
export async function completeOidcLogin(
  event: SvelteKitRequestEvent,
  options: OidcSvelteKitOptions,
): Promise<CompleteOidcLoginResult> {
  const service = createOidcService(event, options);
  const cookieName = getOidcTransactionCookieName(
    service.providerName,
    options,
  );
  const cookiePath = options.transactionCookiePath ?? '/';

  try {
    const rawTransaction = event.cookies.get(cookieName);
    if (!rawTransaction) {
      throw new OidcLoginError('Missing OIDC login transaction cookie.');
    }

    const decodedTransaction = await decodeOidcTransactionCookie(
      rawTransaction,
      getTransactionCookieSecret(service.provider, options),
    );
    const transaction = {
      ...decodedTransaction,
      returnTo: getLocalReturnTo(decodedTransaction.returnTo),
    };
    const ttl = getTransactionTtl(options);
    if (Date.now() - transaction.createdAt > ttl * 1000) {
      throw new OidcLoginError('OIDC login transaction has expired.');
    }

    const result = await service.completeLogin(event.url, transaction);
    const tenantId = await resolveTenantId(result, event, options);
    const sessionId = await createSessionCookie(
      event as unknown as HandleInput['event'],
      result.user.id as string,
      tenantId ?? undefined,
      {
        ...options,
        cookieName: options.sessionCookieName,
        cookiePath: options.sessionCookiePath,
        cookieSameSite: options.sessionCookieSameSite,
        cookieSecure: useSecureCookie(event, options.sessionCookieSecure),
        data: {
          oidcIssuer: result.claims.iss,
          oidcProvider: service.providerName,
        },
        ipAddress: event.getClientAddress?.(),
        ttl: options.sessionTtl,
        userAgent: event.request.headers.get('user-agent') ?? undefined,
      },
    );

    return {
      ...result,
      providerName: service.providerName,
      returnTo: transaction.returnTo,
      sessionId,
    };
  } finally {
    event.cookies.delete(cookieName, { path: cookiePath });
  }
}

/**
 * Create a SvelteKit GET handler that redirects to an OIDC provider.
 *
 * @example
 * ```typescript
 * // src/routes/auth/[provider]/login/+server.ts
 * import { createOidcLoginHandler } from '@happyvertical/smrt-users/sveltekit';
 *
 * export const GET = createOidcLoginHandler({
 *   db: { type: 'postgres', url: process.env.DATABASE_URL! },
 * });
 * ```
 */
export function createOidcLoginHandler(options: OidcSvelteKitOptions) {
  return async (event: SvelteKitRequestEvent): Promise<Response> => {
    const { url } = await beginOidcLogin(event, options);
    return redirectResponse(url);
  };
}

/**
 * Create a SvelteKit GET handler for the provider callback.
 */
export function createOidcCallbackHandler(options: OidcSvelteKitOptions) {
  return async (event: SvelteKitRequestEvent): Promise<Response> => {
    try {
      const result = await completeOidcLogin(event, options);
      const redirectTo = await resolveSuccessRedirect(result, event, options);
      return redirectResponse(redirectTo);
    } catch (error) {
      const failureRedirect = resolveFailureRedirect(error, event, options);
      if (failureRedirect) return redirectResponse(failureRedirect);
      return failureResponse(error);
    }
  };
}

// ---------------------------------------------------------------------------
// Terminal / CLI device-code auth
// ---------------------------------------------------------------------------

/** Cached TerminalAuthService instances keyed by options identity. */
const terminalAuthServiceCache = new Map<string, TerminalAuthService>();

function terminalAuthCacheKey(options: TerminalAuthServiceOptions): string {
  return JSON.stringify({
    db: options.db,
    cookie: options.sessionCookieName,
    prefix: options.userCodePrefix,
    reqTtl: options.requestTtlSeconds,
    sessTtl: options.sessionTtlSeconds,
    poll: options.pollIntervalSeconds,
    path: options.verificationPath,
  });
}

async function getOrCreateTerminalAuthService(
  options: TerminalAuthServiceOptions,
): Promise<TerminalAuthService> {
  const key = terminalAuthCacheKey(options);
  let service = terminalAuthServiceCache.get(key);
  if (!service) {
    service = await TerminalAuthService.create(options);
    terminalAuthServiceCache.set(key, service);
  }
  return service;
}

/**
 * Pull `Bearer <token>` out of an `Authorization` header. Returns `null` if
 * the header is missing or malformed.
 */
export function parseBearerToken(authorization: string | null): string | null {
  const match = authorization?.match(/^Bearer\s+(.+)$/iu);
  return match?.[1]?.trim() || null;
}

/** Options for the terminal-auth start handler. */
export interface CreateTerminalAuthStartHandlerOptions
  extends TerminalAuthServiceOptions {
  /**
   * Override the verification origin returned to the CLI (e.g. when the
   * public origin differs from the request origin behind a proxy). Defaults
   * to `event.url.origin`.
   */
  verificationOrigin?: string | ((event: SvelteKitRequestEvent) => string);
}

/**
 * Create a SvelteKit POST handler that starts a new terminal-auth request.
 * Mount under `/api/cli/auth/start/+server.ts`:
 *
 * ```ts
 * export const POST = createTerminalAuthStartHandler({
 *   db: { type: 'postgres', url: process.env.DATABASE_URL! },
 *   userCodePrefix: 'WG',
 * });
 * ```
 */
export function createTerminalAuthStartHandler(
  options: CreateTerminalAuthStartHandlerOptions,
) {
  return async (event: SvelteKitRequestEvent): Promise<Response> => {
    const service = await getOrCreateTerminalAuthService(options);
    const origin =
      typeof options.verificationOrigin === 'function'
        ? options.verificationOrigin(event)
        : (options.verificationOrigin ?? event.url.origin);
    const result = await service.createRequest(origin);
    return jsonResponse(result, 201);
  };
}

/**
 * Create a SvelteKit POST handler that exchanges a polling device code for a
 * bearer token once the request has been approved. Mount under
 * `/api/cli/auth/token/+server.ts`.
 */
export function createTerminalAuthTokenHandler(
  options: TerminalAuthServiceOptions,
) {
  return async (event: SvelteKitRequestEvent): Promise<Response> => {
    const body = (await event.request.json().catch(() => null)) as {
      deviceCode?: unknown;
    } | null;
    const deviceCode =
      typeof body?.deviceCode === 'string' ? body.deviceCode.trim() : '';
    if (!deviceCode) {
      return jsonResponse({ error: 'deviceCode is required.' }, 400);
    }

    const service = await getOrCreateTerminalAuthService(options);
    const result = await service.exchangeDeviceCode(deviceCode);
    return jsonResponse(result);
  };
}

/**
 * Create a SvelteKit DELETE handler that revokes the bearer token in the
 * request's `Authorization` header. Always returns `{ authenticated: false }`
 * — does not leak whether the token was actually live, by design.
 */
export function createBearerSessionDeleteHandler(
  options: TerminalAuthServiceOptions,
) {
  return async (event: SvelteKitRequestEvent): Promise<Response> => {
    const token = parseBearerToken(event.request.headers.get('authorization'));
    if (token) {
      try {
        const service = await getOrCreateTerminalAuthService(options);
        await service.destroyBearerSession(token);
      } catch (error) {
        console.error('Terminal bearer session revocation error:', error);
      }
    }
    return jsonResponse({ authenticated: false });
  };
}

/**
 * Look up the session associated with a bearer token. Use from
 * `hooks.server.ts` to resolve `Authorization: Bearer <sid>` headers
 * alongside cookie-based sessions.
 */
export async function loadBearerSessionContext(
  token: string,
  options: TerminalAuthServiceOptions,
) {
  const service = await getOrCreateTerminalAuthService(options);
  return service.loadBearerSession(token);
}

/** Shape passed back to `+page.server.ts` `load`. */
export interface TerminalLoginPageData {
  userCode: string;
  requestStatus: string | null;
}

/** Shape returned by the approve action on success. */
export interface TerminalLoginApproveSuccess {
  approved: true;
  requestStatus: string;
  userCode: string;
}

/** Shape returned by the approve action on failure (HTTP 4xx). */
export interface TerminalLoginApproveFailure {
  status: number;
  error: string;
  userCode: string;
}

/**
 * Page-server helper for the terminal-login approval page. Returns
 * `{ load, approve }` you can spread into a `+page.server.ts` module.
 *
 * `approve` is the action implementation, not a wrapped object — wire it up
 * as you like, e.g. `export const actions = { approve: handler.approve }`.
 *
 * @example
 * ```ts
 * // src/routes/terminal-login/+page.server.ts
 * import { mountTerminalLoginPage } from '@happyvertical/smrt-users/sveltekit';
 *
 * const handlers = mountTerminalLoginPage({
 *   db: { type: 'postgres', url: process.env.DATABASE_URL! },
 *   userCodePrefix: 'WG',
 *   requireUser: (event) => Boolean(event.locals.user),
 *   resolveUser: (event) => event.locals.user,
 *   resolveTenantId: (event) => event.locals.tenantId,
 * });
 *
 * export const load = handlers.load;
 * export const actions = { approve: handlers.approve };
 * ```
 */
export interface MountTerminalLoginPageOptions
  extends TerminalAuthServiceOptions {
  /** Resolve the authenticated user from `event.locals`. */
  resolveUser: (
    event: SvelteKitRequestEvent,
  ) => { id?: string | null; email?: string | null } | null | undefined;
  /** Resolve the tenant id from `event.locals`. */
  resolveTenantId: (event: SvelteKitRequestEvent) => string | null | undefined;
  /** Query-string parameter holding the user code on the page URL. */
  codeQueryParam?: string;
}

export interface MountedTerminalLoginPage {
  load: (event: SvelteKitRequestEvent) => Promise<TerminalLoginPageData>;
  approve: (
    event: SvelteKitRequestEvent,
  ) => Promise<
    | TerminalLoginApproveSuccess
    | { type: 'failure'; status: number; data: TerminalLoginApproveFailure }
  >;
}

export function mountTerminalLoginPage(
  options: MountTerminalLoginPageOptions,
): MountedTerminalLoginPage {
  const codeParam = options.codeQueryParam ?? 'code';

  return {
    load: async (event) => {
      const userCode =
        event.url.searchParams.get(codeParam)?.trim().toUpperCase() ?? '';
      let requestStatus: string | null = null;
      if (userCode) {
        const service = await getOrCreateTerminalAuthService(options);
        const request = await service.getRequestForUserCode(userCode);
        requestStatus = request?.status ?? null;
      }
      return { requestStatus, userCode };
    },

    approve: async (event) => {
      const formData = await event.request.formData();
      const userCode =
        formData.get('userCode')?.toString().trim().toUpperCase() ?? '';

      if (!userCode) {
        return {
          type: 'failure',
          status: 400,
          data: {
            status: 400,
            error: 'Enter a terminal login code.',
            userCode,
          },
        };
      }

      const user = options.resolveUser(event);
      const tenantId = options.resolveTenantId(event);
      if (!user?.id) {
        return {
          type: 'failure',
          status: 401,
          data: {
            status: 401,
            error: 'Sign in before approving terminal access.',
            userCode,
          },
        };
      }

      try {
        const service = await getOrCreateTerminalAuthService(options);
        const approveInput: ApproveCliAuthRequestInput = {
          ipAddress: event.getClientAddress?.(),
          tenantId: tenantId ?? null,
          user: {
            email: user.email ?? '',
            id: user.id,
          },
          userAgent: event.request.headers.get('user-agent') ?? undefined,
          userCode,
        };
        const request = await service.approveRequest(approveInput);
        return {
          approved: true,
          requestStatus: request.status,
          userCode,
        };
      } catch (error) {
        const message =
          error instanceof TerminalAuthError
            ? error.message
            : error instanceof Error
              ? error.message
              : 'Unable to approve terminal login.';
        return {
          type: 'failure',
          status: 400,
          data: { status: 400, error: message, userCode },
        };
      }
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export {
  TerminalAuthError,
  TerminalAuthService,
  type TerminalAuthServiceOptions,
};
