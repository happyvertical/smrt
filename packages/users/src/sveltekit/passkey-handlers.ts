/**
 * SvelteKit glue for {@link PasskeyCredentialService} (#3275): browser passkey
 * sign-in that sets the same session cookie `createSessionHandler` reads, and
 * passkey management for the signed-in person and administrators.
 *
 * ```ts
 * // src/lib/server/passkey-auth.ts
 * import { createPasskeyCredentialHandlers } from '@happyvertical/smrt-users/sveltekit';
 *
 * export const passkeyAuth = createPasskeyCredentialHandlers({
 *   db: { type: 'postgres', url: DATABASE_URL },
 *   relyingParty: { origin: ORIGIN, rpName: 'Acme' },
 *   challengeSecret: PASSKEY_CHALLENGE_SECRET, // required with >1 process
 *   tenantId: () => SHOP_TENANT_ID,            // or (event) => …; omit for tenantless
 *   cookieName: 'sid',                         // must match createSessionHandler
 * });
 *
 * // routes/auth/passkey/options/+server.ts    → export const POST = passkeyAuth.authenticationOptions;
 * // routes/auth/passkey/sign-in/+server.ts    → export const POST = passkeyAuth.signIn;
 * // routes/account/passkeys/options/+server.ts → export const POST = passkeyAuth.registrationOptions;
 * // routes/account/passkeys/+server.ts        → export const GET = passkeyAuth.list;
 * //                                              export const POST = passkeyAuth.register;
 * //                                              export const PATCH = passkeyAuth.rename;
 * //                                              export const DELETE = passkeyAuth.remove;
 * // routes/admin/passkeys/remove-all/+server.ts → export const POST = passkeyAuth.removeAll;
 * ```
 *
 * Wire contract (JSON bodies):
 *
 * - `authenticationOptions`: POST, no body → 200 `{ ceremonyId, options }`
 *   (`options` is the WebAuthn request options; hand it to the browser).
 * - `signIn`: POST `{ ceremonyId, response }` (`response` is the browser's
 *   assertion) → 200 `{ authenticated: true, userId, tenantId, expiresAt }` and
 *   an httpOnly session cookie; any cookie session the browser held before is
 *   revoked. 401 `{ error, code: 'invalid_credentials' }` for every refusal
 *   that is not a rate limit (bad, replayed or expired ceremony, unknown
 *   passkey, failed verification, inactive user, no membership); 429 +
 *   `Retry-After` `{ code: 'rate_limited' }` when the budget is exhausted. The
 *   session id is never in the body.
 * - The management handlers act as the session the host's hook put in
 *   `event.locals` (which must include `authMethod` — `createSessionHandler`
 *   does). 401 `unauthenticated` without a session; 403 `forbidden`; 401
 *   `reauthentication_required` when registering or removing one's own passkey
 *   needs a more recent sign-in; 400 `passkey_registration` with a displayable
 *   message (bad name, limit reached, already registered, not verified).
 *   - `registrationOptions`: POST → 200 `{ ceremonyId, options }`.
 *   - `register`: POST `{ ceremonyId, response, name? }` → 200 `{ passkey }`.
 *   - `list`: GET, `?userId=` for an administrator → 200 `{ passkeys }`.
 *   - `rename`: PATCH `{ passkeyId, name }` → 200 `{ passkey }`.
 *   - `remove`: DELETE or POST `{ passkeyId }` (or `?passkeyId=`) → 200
 *     `{ revokedSessions }`, plus `signedOut: true` and a cleared cookie when
 *     it ended the current session.
 *   - `removeAll`: POST `{ userId }` (administrators) → 200
 *     `{ removed, revokedSessions }`.
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
  PasskeyCredentialError,
  PasskeyCredentialForbiddenError,
  PasskeyCredentialService,
  type PasskeyCredentialServiceOptions,
  PasskeyReauthenticationRequiredError,
  PasskeyRegistrationError,
} from '../services/PasskeyCredentialService.js';
import type { SessionContext } from '../services/SessionService.js';

const logger = createLogger({ level: 'info' });

/**
 * Structural cookie subset. Options are always supplied by this module and
 * match SvelteKit's required cookie path without making it a root dependency.
 */
type CookieOptions = {
  path: string;
  domain?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'strict' | 'lax' | 'none';
  maxAge?: number;
};
type Cookies = {
  get: (name: string) => string | undefined;
  set: (name: string, value: string, options: CookieOptions) => void;
  delete: (name: string, options: CookieOptions) => void;
};

/** The parts of a SvelteKit `RequestEvent` these handlers use. */
export type PasskeyRequestEvent = {
  cookies: Cookies;
  getClientAddress?: () => string;
  locals?: object;
  request: Request;
  url: URL;
};

export interface CreatePasskeyCredentialHandlersOptions
  extends PasskeyCredentialServiceOptions {
  /**
   * Tenant a sign-in enters; the person must hold an active membership in
   * it. A value or a per-request resolver. Null/omitted signs in with no
   * tenant context.
   */
  tenantId?:
    | string
    | null
    | 'unique-active-membership'
    | ((
        event: PasskeyRequestEvent,
      ) =>
        | string
        | null
        | undefined
        | 'unique-active-membership'
        | Promise<string | null | undefined | 'unique-active-membership'>);
  /** Session cookie name; must match `createSessionHandler`. Default `sid`. */
  cookieName?: string;
  cookiePath?: string;
  cookieDomain?: string;
  /** Default: secure when the request is https. */
  cookieSecure?: boolean;
  cookieSameSite?: 'strict' | 'lax' | 'none';
}

export interface PasskeyCredentialHandlers {
  authenticationOptions: (event: PasskeyRequestEvent) => Promise<Response>;
  signIn: (event: PasskeyRequestEvent) => Promise<Response>;
  registrationOptions: (event: PasskeyRequestEvent) => Promise<Response>;
  register: (event: PasskeyRequestEvent) => Promise<Response>;
  list: (event: PasskeyRequestEvent) => Promise<Response>;
  rename: (event: PasskeyRequestEvent) => Promise<Response>;
  remove: (event: PasskeyRequestEvent) => Promise<Response>;
  removeAll: (event: PasskeyRequestEvent) => Promise<Response>;
  /** The lazily created service, for form actions and admin screens. */
  service: () => Promise<PasskeyCredentialService>;
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
  event: PasskeyRequestEvent,
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
  if (error instanceof PasskeyCredentialError) return invalidCredentials();
  if (error instanceof PasskeyReauthenticationRequiredError) {
    return json(
      { error: error.message, code: 'reauthentication_required' },
      401,
      NO_STORE_HEADERS,
    );
  }
  if (error instanceof PasskeyCredentialForbiddenError) {
    return json(
      { error: 'Not permitted.', code: 'forbidden' },
      403,
      NO_STORE_HEADERS,
    );
  }
  if (error instanceof PasskeyRegistrationError) {
    return json(
      { error: error.message, code: 'passkey_registration' },
      400,
      NO_STORE_HEADERS,
    );
  }
  // Only the error's class: a message could carry request data.
  logger.error('Passkey credential handler error', {
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
 * never manages passkeys" guarantee cannot be lost by a host hook that
 * forgot to copy the field.
 */
function resolveActor(event: PasskeyRequestEvent): SessionContext | null {
  const locals = (event.locals ?? {}) as Record<string, unknown>;
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

export function createPasskeyCredentialHandlers(
  options: CreatePasskeyCredentialHandlersOptions,
): PasskeyCredentialHandlers {
  const {
    tenantId: tenantOption,
    cookieName = 'sid',
    cookiePath = '/',
    cookieDomain,
    cookieSecure,
    cookieSameSite = 'lax',
    ...serviceOptions
  } = options;
  let servicePromise: Promise<PasskeyCredentialService> | null = null;
  const service = () => {
    servicePromise ??= PasskeyCredentialService.create(serviceOptions).catch(
      (error) => {
        // A failed start (a bad config, a database not yet up) is retried by
        // the next request rather than cached forever.
        servicePromise = null;
        throw error;
      },
    );
    return servicePromise;
  };
  const resolveTenant = async (event: PasskeyRequestEvent) =>
    (typeof tenantOption === 'function'
      ? await tenantOption(event)
      : tenantOption) ?? null;
  const clearCookie = (event: PasskeyRequestEvent) =>
    event.cookies.delete(cookieName, {
      path: cookiePath,
      domain: cookieDomain,
    });

  const management =
    (
      run: (
        svc: PasskeyCredentialService,
        actor: SessionContext,
        input: Record<string, unknown>,
        event: PasskeyRequestEvent,
      ) => Promise<Record<string, unknown>>,
      { readsBody = true }: { readsBody?: boolean } = {},
    ) =>
    async (event: PasskeyRequestEvent): Promise<Response> => {
      const actor = resolveActor(event);
      if (!actor) return unauthenticated();
      try {
        const input = readsBody ? await body(event) : {};
        const result = await run(await service(), actor, input, event);
        return json(result, 200, NO_STORE_HEADERS);
      } catch (error) {
        return errorResponse(error);
      }
    };

  return {
    service,

    authenticationOptions: async () => {
      try {
        const begun = await (await service()).beginAuthentication();
        return json(begun, 200, NO_STORE_HEADERS);
      } catch (error) {
        return errorResponse(error);
      }
    },

    signIn: async (event) => {
      try {
        const input = await body(event);
        // A request missing a field goes through the service like any other:
        // it is reserved against the limiter and refused with the same 401.
        const result = await (await service()).finishAuthentication({
          ceremonyId: str(input.ceremonyId),
          response: input.response,
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
          },
          200,
          NO_STORE_HEADERS,
        );
      } catch (error) {
        return errorResponse(error);
      }
    },

    registrationOptions: management(
      async (svc, actor) => ({ ...(await svc.beginRegistration({ actor })) }),
      { readsBody: false },
    ),

    register: management(async (svc, actor, input, event) => ({
      ...(await svc.finishRegistration({
        actor,
        ceremonyId: str(input.ceremonyId),
        response: input.response,
        name: str(input.name),
        ipAddress: event.getClientAddress?.(),
      })),
    })),

    list: management(
      async (svc, actor, _input, event) => ({
        passkeys: await svc.listPasskeys({
          actor,
          userId: event.url.searchParams.get('userId')?.trim() || undefined,
        }),
      }),
      { readsBody: false },
    ),

    rename: management(async (svc, actor, input, event) => ({
      ...(await svc.renamePasskey({
        actor,
        passkeyId: str(input.passkeyId).trim(),
        name: str(input.name),
        ipAddress: event.getClientAddress?.(),
      })),
    })),

    remove: management(async (svc, actor, input, event) => {
      const result = await svc.removePasskey({
        actor,
        passkeyId:
          str(input.passkeyId).trim() ||
          event.url.searchParams.get('passkeyId')?.trim() ||
          '',
        ipAddress: event.getClientAddress?.(),
      });
      if (result.endedCurrentSession) {
        clearCookie(event);
        return { revokedSessions: result.revokedSessions, signedOut: true };
      }
      return { revokedSessions: result.revokedSessions };
    }),

    removeAll: management((svc, actor, input, event) =>
      svc.removeAllPasskeys({
        actor,
        userId: str(input.userId).trim(),
        ipAddress: event.getClientAddress?.(),
      }),
    ),
  };
}
