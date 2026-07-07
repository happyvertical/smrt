/**
 * SvelteKit handlers for the SMRT mobile `/api/mobile` contract (issue
 * #1748). Thin adapters over {@link MobileAuthService} — parsing, error
 * mapping, and cache headers live here; protocol and session logic live in
 * the service.
 *
 * @packageDocumentation
 *
 * @example
 * ```ts
 * // src/lib/server/mobile.ts
 * import { createMobileAuthHandlers } from '@happyvertical/smrt-users/sveltekit';
 *
 * export const mobile = createMobileAuthHandlers({
 *   db: { type: 'postgres', url: process.env.DATABASE_URL! },
 *   defaultProvider: 'kanidm',
 *   providers: { kanidm: { issuer: '...', clientId: '...', clientSecret: '...' } },
 *   redirectUris: ['com.example.app://auth/callback'],
 * });
 *
 * // src/routes/api/mobile/auth/start/+server.ts
 * //   export const POST = mobile.authStart;
 * // src/routes/api/mobile/auth/complete/+server.ts
 * //   export const POST = mobile.authComplete;
 * // src/routes/api/mobile/session/+server.ts
 * //   export const GET = mobile.session.GET;
 * //   export const DELETE = mobile.session.DELETE;
 *
 * // src/routes/api/mobile/captures/+server.ts — an app route behind the guard.
 * // `db` is the app's own database config (the same one passed to
 * // createMobileAuthHandlers); the guard resolves ctx.userId/ctx.tenantId.
 * // export const POST = mobile.guard(async (event, ctx) => {
 * //   await assertOperationPermission({
 * //     db, collection: 'captures', action: 'create',
 * //   });
 * //   ... // domain ingestion stays app-side
 * // });
 * ```
 */

// Keeps this subpath self-sufficient when imported in isolation (mirrors
// `./index.ts` / `./resource-list-handler.ts`).
import '../__smrt-register__.js';

import { createLogger } from '@happyvertical/logger';
import type {
  MobileAuthCompleteRequest,
  MobileAuthStartRequest,
} from '@happyvertical/smrt-mobile-contract';
import {
  MobileAuthError,
  MobileAuthService,
  type MobileAuthServiceOptions,
  readMobileBearerToken,
} from '../services/MobileAuthService.js';
import { OperationPermissionError } from '../services/OperationPermissionService.js';
import {
  type SessionPermissionRuntimeContext,
  withSessionPermissionContext,
} from '../services/SessionPermissionContext.js';

const logger = createLogger({ level: 'info' });

/**
 * Every `/api/mobile` response carries live credentials or per-user data —
 * never cacheable by an intermediary. Mirrors the terminal-auth handlers.
 */
const NO_STORE_HEADERS: Record<string, string> = {
  'cache-control': 'private, no-store',
  pragma: 'no-cache',
};

/**
 * Minimal structural slice of SvelteKit's `RequestEvent` these handlers
 * touch (kept structural so `@sveltejs/kit` stays out of the dependency
 * tree, like the rest of this package's SvelteKit integration).
 */
export interface MobileRequestEvent {
  request: Request;
  getClientAddress?: () => string;
  locals?: Record<string, unknown>;
}

export type MobileRequestHandler = (
  event: MobileRequestEvent,
) => Promise<Response>;

export interface CreateMobileAuthHandlersOptions
  extends MobileAuthServiceOptions {
  /**
   * Enter smrt-tenancy request context for guarded routes when the session
   * carries a tenant (default true — mobile domain routes are expected to
   * hit `@TenantScoped` models).
   */
  enterTenantContext?: boolean;
  /** Enforce Postgres RLS via request-scoped transactions in guarded routes. */
  postgresRls?: boolean;
}

/** The mounted `/api/mobile` handler set. */
export interface MobileAuthHandlers {
  /** `POST /api/mobile/auth/start` */
  authStart: MobileRequestHandler;
  /** `POST /api/mobile/auth/complete` */
  authComplete: MobileRequestHandler;
  /** `GET /api/mobile/session` + `DELETE /api/mobile/session` */
  session: { GET: MobileRequestHandler; DELETE: MobileRequestHandler };
  /**
   * Bearer-auth middleware for app-owned mobile routes: resolves the
   * `Authorization: Bearer` session, establishes the request permission
   * context ({@link withSessionPermissionContext} — so
   * `assertOperationPermission`, tenancy interceptors, and Postgres RLS all
   * see the caller), populates `event.locals` like the cookie session
   * handler does, and maps auth/permission failures to the JSON + status
   * semantics the mobile client expects (401 → client clears its session
   * and re-authenticates; 403 carries a machine-readable `reason`).
   */
  withSession: (
    event: MobileRequestEvent,
    fn: (
      event: MobileRequestEvent,
      context: SessionPermissionRuntimeContext,
    ) => Promise<Response>,
  ) => Promise<Response>;
  /** Route-wrapper form of {@link MobileAuthHandlers.withSession}. */
  guard: (
    fn: (
      event: MobileRequestEvent,
      context: SessionPermissionRuntimeContext,
    ) => Promise<Response>,
  ) => MobileRequestHandler;
  /** The lazily-created underlying service (shared by all handlers). */
  getService: () => Promise<MobileAuthService>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...NO_STORE_HEADERS },
  });
}

/**
 * Apply the no-store cache policy to a guarded app-route response UNLESS it
 * already declares its own `Cache-Control`. Re-wraps the response (headers are
 * otherwise immutable once constructed) preserving status, body, and headers.
 */
function withNoStoreDefault(response: Response): Response {
  if (response.headers.has('cache-control')) {
    return response;
  }
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(NO_STORE_HEADERS)) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Map a thrown error to the mobile wire error shape `{ error, code?, … }`.
 * Unexpected errors are logged and returned as a generic 500 so internal
 * details never reach the client (and the mobile write queue treats them as
 * retryable server faults, not permanent 4xx).
 */
function errorResponse(error: unknown): Response {
  if (error instanceof MobileAuthError) {
    // Server-fault mobile errors (e.g. server_misconfigured) still carry a
    // client-safe message, but log them so operators see the misconfiguration
    // rather than only the client seeing a 500.
    if (error.status >= 500) {
      logger.error('Mobile handler server error', {
        code: error.code,
        message: error.message,
      });
    }
    return jsonResponse(
      { error: error.message, code: error.code },
      error.status,
    );
  }
  if (error instanceof OperationPermissionError) {
    return jsonResponse(
      {
        error: error.message,
        code: 'permission_denied',
        reason: error.decision.reason,
        permission: error.permission,
      },
      error.status,
    );
  }
  logger.error('Unexpected mobile handler error', { error });
  return jsonResponse(
    { error: 'Internal server error', code: 'internal_error' },
    500,
  );
}

async function readJsonBody(
  event: MobileRequestEvent,
): Promise<Record<string, unknown>> {
  try {
    const body = (await event.request.json()) as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error('not an object');
    }
    return body as Record<string, unknown>;
  } catch {
    throw new MobileAuthError(
      400,
      'invalid_request',
      'Request body must be a JSON object.',
    );
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseStartRequest(
  body: Record<string, unknown>,
): MobileAuthStartRequest {
  return {
    providerId: optionalString(body.providerId),
    redirectUri: optionalString(body.redirectUri) ?? '',
    scopes: Array.isArray(body.scopes)
      ? body.scopes.filter(
          (scope): scope is string => typeof scope === 'string',
        )
      : undefined,
    state: optionalString(body.state),
    loginHint: optionalString(body.loginHint),
  };
}

function parseCompleteRequest(
  body: Record<string, unknown>,
): MobileAuthCompleteRequest {
  return {
    providerId: optionalString(body.providerId),
    code: optionalString(body.code) ?? '',
    state: optionalString(body.state),
    codeVerifier: optionalString(body.codeVerifier),
    redirectUri: optionalString(body.redirectUri) ?? '',
  };
}

function clientAddress(event: MobileRequestEvent): string | undefined {
  // SvelteKit's getClientAddress throws on adapters that cannot supply one
  // (e.g. during prerender) — treat that as "unknown", not a failure.
  try {
    return event.getClientAddress?.();
  } catch {
    return undefined;
  }
}

function populateLocals(
  event: MobileRequestEvent,
  context: SessionPermissionRuntimeContext,
): void {
  if (!event.locals) return;
  event.locals.user = context.user;
  event.locals.membership = context.membership ?? null;
  event.locals.permissions = context.permissions;
  event.locals.tenantId = context.tenantId;
  event.locals.sessionId = context.sessionId;
}

/**
 * Build the mountable `/api/mobile` handler set. Call ONCE per app (module
 * scope) and export the members from the route files — the returned handlers
 * share one lazily-initialized {@link MobileAuthService}.
 */
export function createMobileAuthHandlers(
  options: CreateMobileAuthHandlersOptions,
): MobileAuthHandlers {
  let servicePromise: Promise<MobileAuthService> | null = null;
  const getService = (): Promise<MobileAuthService> => {
    servicePromise ??= MobileAuthService.create(options).catch((error) => {
      // A failed init must not poison every later request.
      servicePromise = null;
      throw error;
    });
    return servicePromise;
  };

  const authStart: MobileRequestHandler = async (event) => {
    try {
      const service = await getService();
      const body = await readJsonBody(event);
      const response = await service.start(parseStartRequest(body));
      return jsonResponse(response);
    } catch (error) {
      return errorResponse(error);
    }
  };

  const authComplete: MobileRequestHandler = async (event) => {
    try {
      const service = await getService();
      const body = await readJsonBody(event);
      const session = await service.complete(parseCompleteRequest(body), {
        userAgent: event.request.headers.get('user-agent') ?? undefined,
        ipAddress: clientAddress(event),
      });
      return jsonResponse(session);
    } catch (error) {
      return errorResponse(error);
    }
  };

  const sessionGet: MobileRequestHandler = async (event) => {
    try {
      const service = await getService();
      const bootstrap = await service.bootstrap(
        event.request.headers.get('authorization'),
      );
      return jsonResponse(bootstrap);
    } catch (error) {
      return errorResponse(error);
    }
  };

  const sessionDelete: MobileRequestHandler = async (event) => {
    try {
      const service = await getService();
      const result = await service.logout(
        event.request.headers.get('authorization'),
      );
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  };

  const withSession: MobileAuthHandlers['withSession'] = async (event, fn) => {
    try {
      const service = await getService();
      const token = readMobileBearerToken(
        event.request.headers.get('authorization'),
      );
      if (!token) {
        throw new MobileAuthError(
          401,
          'missing_bearer_token',
          'Missing mobile bearer token.',
        );
      }
      return await withSessionPermissionContext(
        {
          ...options,
          sessionId: token,
          sessionService: service.getSessionService(),
          enterTenantContext: options.enterTenantContext ?? true,
          postgresRls: options.postgresRls,
        },
        async (context) => {
          if (!context.session) {
            throw new MobileAuthError(
              401,
              'invalid_bearer_token',
              'Invalid or expired mobile bearer token.',
            );
          }
          populateLocals(event, context);
          const response = await fn(event, context);
          // Guarded routes serve per-user authenticated data. Default it to
          // non-cacheable — matching the built-in auth/session responses — so
          // an app handler that forgets cache headers can't leave a user's
          // data cacheable by a browser or intermediary. An app that sets its
          // own Cache-Control (e.g. a deliberately public sub-resource) keeps
          // it.
          return withNoStoreDefault(response);
        },
      );
    } catch (error) {
      return errorResponse(error);
    }
  };

  return {
    authStart,
    authComplete,
    session: { GET: sessionGet, DELETE: sessionDelete },
    withSession,
    guard: (fn) => (event) => withSession(event, fn),
    getService,
  };
}

/**
 * Resolve the dedup key for a mobile multipart upload per the documented
 * contract (`docs/content/architecture/mobile-upload-contract.md`): the
 * `clientCaptureId` form field wins; the `Idempotency-Key` header — which
 * the shared mobile client sets to the durable queue entry's id — is the
 * fallback. Returns `null` when neither is present (the upload then has no
 * dedup guarantee).
 */
export function resolveMobileUploadDedupKey(
  formData: FormData | null,
  headers: Headers,
  fieldName = 'clientCaptureId',
): string | null {
  const field = formData?.get(fieldName);
  if (typeof field === 'string' && field.trim().length > 0) {
    return field.trim();
  }
  const header = headers.get('idempotency-key')?.trim();
  return header && header.length > 0 ? header : null;
}
