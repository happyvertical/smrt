/**
 * SvelteKit glue for {@link PasswordCredentialService} (#3274): browser
 * email + password sign-in that sets the same session cookie
 * `createSessionHandler` reads, and password management for the signed-in
 * person and administrators.
 *
 * ```ts
 * // src/lib/server/password-auth.ts
 * import { createPasswordCredentialHandlers } from '@happyvertical/smrt-users/sveltekit';
 *
 * export const passwordAuth = createPasswordCredentialHandlers({
 *   db: { type: 'postgres', url: DATABASE_URL },
 *   tenantId: () => SHOP_TENANT_ID,          // or (event) => …; omit for tenantless
 *   cookieName: 'sid',                       // must match createSessionHandler
 * });
 *
 * // routes/auth/password/+server.ts         → export const POST = passwordAuth.signIn;
 * // routes/account/password/+server.ts      → export const PUT = passwordAuth.changePassword;
 * //                                            export const POST = passwordAuth.setPassword;
 * //                                            export const DELETE = passwordAuth.clearPassword;
 * // routes/admin/password-reset/+server.ts   → export const POST = passwordAuth.resetPassword;
 * ```
 *
 * Wire contract:
 *
 * - `signIn`: JSON or form body `{ email, password }` (`identifier` is accepted
 *   for `email`) → 200 `{ authenticated: true, userId, tenantId, expiresAt,
 *   mustChange }` and an httpOnly session cookie; any cookie session the
 *   browser held before is revoked. 401 `{ error, code: 'invalid_credentials' }`
 *   for every refusal that is not a rate limit (missing field, unknown email,
 *   no password, wrong password, inactive user, no membership); 429 +
 *   `Retry-After` `{ code: 'rate_limited' }` when the budget is exhausted. The
 *   session id is never in the body.
 * - `setPassword` (`{ userId?, password }`), `changePassword`
 *   (`{ currentPassword, newPassword }`), `resetPassword`
 *   (`{ userId, password, mustChange? }`), `clearPassword`
 *   (`{ userId?, currentPassword? }`): act as the session the host's hook put
 *   in `event.locals` (which must include `authMethod` — `createSessionHandler`
 *   does). 200 `{ revokedSessions }` (`changePassword` adds
 *   `signedOut: true` and clears the cookie when it ended the current
 *   must-change session); 400 `password_policy` with a displayable message;
 *   401 `invalid_credentials` for a wrong current password; 401
 *   `unauthenticated` without a session; 403 `forbidden`; 429 when the
 *   current-password check is rate limited.
 *
 * Sign out with `destroySessionCookie`.
 *
 * @packageDocumentation
 */

// Keeps this subpath self-sufficient when imported in isolation.
import '../__smrt-register__.js';

import { createLogger } from '@happyvertical/logger';
import { LoginRateLimitError } from '../services/LoginAttemptLimiter.js';
import {
  PasswordCredentialError,
  PasswordCredentialForbiddenError,
  PasswordCredentialService,
  type PasswordCredentialServiceOptions,
  PasswordPolicyError,
} from '../services/PasswordCredentialService.js';
import type { SessionContext } from '../services/SessionService.js';

const logger = createLogger({ level: 'info' });

type Cookies = {
  get: (name: string) => string | undefined;
  set: (name: string, value: string, options?: Record<string, unknown>) => void;
  delete: (name: string, options?: Record<string, unknown>) => void;
};

/** The parts of a SvelteKit `RequestEvent` these handlers use. */
export type PasswordRequestEvent = {
  cookies: Cookies;
  getClientAddress?: () => string;
  locals?: Record<string, unknown>;
  request: Request;
  url: URL;
};

export interface CreatePasswordCredentialHandlersOptions
  extends PasswordCredentialServiceOptions {
  /**
   * Tenant a sign-in enters; the person must hold an active membership in
   * it. A value or a per-request resolver. Null/omitted signs in with no
   * tenant context.
   */
  tenantId?:
    | string
    | null
    | ((
        event: PasswordRequestEvent,
      ) => string | null | undefined | Promise<string | null | undefined>);
  /** Session cookie name; must match `createSessionHandler`. Default `sid`. */
  cookieName?: string;
  cookiePath?: string;
  cookieDomain?: string;
  /** Default: secure when the request is https. */
  cookieSecure?: boolean;
  cookieSameSite?: 'strict' | 'lax' | 'none';
}

export interface PasswordCredentialHandlers {
  signIn: (event: PasswordRequestEvent) => Promise<Response>;
  setPassword: (event: PasswordRequestEvent) => Promise<Response>;
  changePassword: (event: PasswordRequestEvent) => Promise<Response>;
  resetPassword: (event: PasswordRequestEvent) => Promise<Response>;
  clearPassword: (event: PasswordRequestEvent) => Promise<Response>;
  /** The lazily created service, for form actions and admin screens. */
  service: () => Promise<PasswordCredentialService>;
}

const NO_STORE_HEADERS: Record<string, string> = {
  'cache-control': 'private, no-store',
  pragma: 'no-cache',
};

function json(
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const invalidCredentials = () =>
  json(
    { error: 'Invalid credentials.', code: 'invalid_credentials' },
    401,
    NO_STORE_HEADERS,
  );

const unauthenticated = () =>
  json(
    { error: 'Unauthenticated.', code: 'unauthenticated' },
    401,
    NO_STORE_HEADERS,
  );

async function body(
  event: PasswordRequestEvent,
): Promise<Record<string, unknown>> {
  const type = event.request.headers.get('content-type') ?? '';
  if (
    type.includes('application/x-www-form-urlencoded') ||
    type.includes('multipart/form-data')
  ) {
    const form = await event.request.formData().catch(() => null);
    if (!form) return {};
    const fields: Record<string, unknown> = {};
    for (const [key, value] of form.entries()) {
      if (typeof value === 'string') fields[key] = value;
    }
    return fields;
  }
  const parsed = (await event.request.json().catch(() => null)) as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Translate service errors into responses that do not enumerate accounts. */
function errorResponse(error: unknown): Response {
  if (error instanceof LoginRateLimitError) {
    return json(
      { error: 'Too many attempts. Try again later.', code: 'rate_limited' },
      429,
      { ...NO_STORE_HEADERS, 'retry-after': String(error.retryAfterSeconds) },
    );
  }
  if (error instanceof PasswordCredentialError) return invalidCredentials();
  if (error instanceof PasswordCredentialForbiddenError) {
    return json(
      { error: 'Not permitted.', code: 'forbidden' },
      403,
      NO_STORE_HEADERS,
    );
  }
  if (error instanceof PasswordPolicyError) {
    return json(
      { error: error.message, code: 'password_policy' },
      400,
      NO_STORE_HEADERS,
    );
  }
  // Only the error's class: a message could carry request data.
  logger.error('Password credential handler error', {
    error: error instanceof Error ? error.name : 'unknown',
  });
  return json(
    { error: 'Internal error.', code: 'internal' },
    500,
    NO_STORE_HEADERS,
  );
}

/**
 * The actor for management calls: the session the host's hook resolved into
 * `event.locals`, *including* `authMethod`. An actor whose channel is unknown
 * is refused rather than assumed first-class, so the "a device PIN session
 * never manages passwords" guarantee cannot be lost by a host hook that
 * forgot to copy the field.
 */
function resolveActor(event: PasswordRequestEvent): SessionContext | null {
  const locals = event.locals ?? {};
  const user = locals.user as SessionContext['user'] | null | undefined;
  const sessionId = locals.sessionId as string | null | undefined;
  if (!user || !sessionId) return null;
  if (!('authMethod' in locals)) return null;
  return {
    user,
    membership: (locals.membership as SessionContext['membership']) ?? null,
    permissions: Array.isArray(locals.permissions)
      ? (locals.permissions as string[])
      : [],
    tenantId: (locals.tenantId as string | null | undefined) ?? null,
    sessionId,
    authMethod: (locals.authMethod as SessionContext['authMethod']) ?? null,
    parent: (locals.sessionParent as SessionContext['parent']) ?? null,
  };
}

export function createPasswordCredentialHandlers(
  options: CreatePasswordCredentialHandlersOptions,
): PasswordCredentialHandlers {
  const {
    tenantId: tenantOption,
    cookieName = 'sid',
    cookiePath = '/',
    cookieDomain,
    cookieSecure,
    cookieSameSite = 'lax',
    ...serviceOptions
  } = options;
  let servicePromise: Promise<PasswordCredentialService> | null = null;
  const service = () => {
    servicePromise ??= PasswordCredentialService.create(serviceOptions);
    return servicePromise;
  };
  const resolveTenant = async (event: PasswordRequestEvent) =>
    (typeof tenantOption === 'function'
      ? await tenantOption(event)
      : tenantOption) ?? null;
  const clearCookie = (event: PasswordRequestEvent) =>
    event.cookies.delete(cookieName, {
      path: cookiePath,
      domain: cookieDomain,
    });

  const management =
    (
      run: (
        svc: PasswordCredentialService,
        actor: SessionContext,
        input: Record<string, unknown>,
        event: PasswordRequestEvent,
      ) => Promise<Record<string, unknown>>,
    ) =>
    async (event: PasswordRequestEvent): Promise<Response> => {
      const actor = resolveActor(event);
      if (!actor) return unauthenticated();
      try {
        const input = await body(event);
        const result = await run(await service(), actor, input, event);
        return json(result, 200, NO_STORE_HEADERS);
      } catch (error) {
        return errorResponse(error);
      }
    };

  return {
    service,

    signIn: async (event) => {
      try {
        const input = await body(event);
        // A request missing a field goes through the service like any other:
        // it is reserved against the limiter and refused with the same 401.
        const result = await (await service()).signIn({
          identifier: str(input.email) || str(input.identifier),
          password: str(input.password),
          tenantId: await resolveTenant(event),
          ipAddress: event.getClientAddress?.(),
          userAgent: event.request.headers.get('user-agent') ?? undefined,
          replaceSessionId: event.cookies.get(cookieName) ?? null,
        });
        event.cookies.set(cookieName, result.sessionId, {
          path: cookiePath,
          // undefined => SvelteKit scopes the cookie to the request host.
          domain: cookieDomain,
          httpOnly: true,
          secure: cookieSecure ?? event.url.protocol === 'https:',
          sameSite: cookieSameSite,
          maxAge: Math.max(
            1,
            Math.floor((Date.parse(result.expiresAt) - Date.now()) / 1000),
          ),
        });
        return json(
          {
            authenticated: true,
            userId: result.userId,
            tenantId: result.tenantId,
            expiresAt: result.expiresAt,
            mustChange: result.mustChange,
          },
          200,
          NO_STORE_HEADERS,
        );
      } catch (error) {
        return errorResponse(error);
      }
    },

    setPassword: management((svc, actor, input, event) =>
      svc.setPassword({
        actor,
        userId: str(input.userId).trim() || (actor.user.id ?? ''),
        password: str(input.password),
        ipAddress: event.getClientAddress?.(),
      }),
    ),

    changePassword: management(async (svc, actor, input, event) => {
      const result = await svc.changePassword({
        actor,
        currentPassword: str(input.currentPassword),
        newPassword: str(input.newPassword),
        ipAddress: event.getClientAddress?.(),
      });
      if (result.endedCurrentSession) {
        clearCookie(event);
        return { revokedSessions: result.revokedSessions, signedOut: true };
      }
      return { revokedSessions: result.revokedSessions };
    }),

    resetPassword: management((svc, actor, input, event) =>
      svc.resetPassword({
        actor,
        userId: str(input.userId).trim(),
        password: str(input.password),
        mustChange:
          typeof input.mustChange === 'boolean'
            ? input.mustChange
            : input.mustChange === 'false'
              ? false
              : undefined,
        ipAddress: event.getClientAddress?.(),
      }),
    ),

    clearPassword: management((svc, actor, input, event) =>
      svc.clearPassword({
        actor,
        userId: str(input.userId).trim() || (actor.user.id ?? ''),
        currentPassword: str(input.currentPassword) || undefined,
        ipAddress: event.getClientAddress?.(),
      }),
    ),
  };
}
