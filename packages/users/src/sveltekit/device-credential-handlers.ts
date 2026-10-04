/**
 * SvelteKit glue for {@link DeviceCredentialService} (#3276).
 *
 * ```ts
 * // src/lib/server/device-auth.ts
 * import { createDeviceCredentialHandlers } from '@happyvertical/smrt-users/sveltekit';
 *
 * export const deviceAuth = createDeviceCredentialHandlers({
 *   db: { type: 'postgres', url: DATABASE_URL },
 *   pin: { pepper: PIN_PEPPER },
 *   assertEnrolledDevice: async (device) => (await devices.findActiveByUserId(device.user.id)) !== null,
 * });
 *
 * // routes/api/device/pin/sign-in/+server.ts  → export const POST = deviceAuth.pinSignIn;
 * // routes/api/device/sign-out/+server.ts     → export const POST = deviceAuth.signOut;
 * // routes/api/device/pin/+server.ts          → export const PUT = deviceAuth.setPin;
 * //                                              export const DELETE = deviceAuth.clearPin;
 * // routes/api/device/pin/reset/+server.ts    → export const POST = deviceAuth.resetPin;
 * ```
 *
 * Wire contract:
 *
 * - `pinSignIn`: `Authorization: Bearer <device token>` + JSON `{ userId, pin }`
 *   → 201 `{ sessionId, userId, tenantId, authMethod, expiresAt, mustReset }`;
 *   401 `{ error, code: 'invalid_credentials' }` for every refusal that is not
 *   a rate limit (not a device, inactive device, unknown user, wrong PIN, no
 *   membership); 429 + `Retry-After` when the budget is exhausted.
 * - `signOut`: `Authorization: Bearer <person token>` → 200 `{ authenticated: false }`
 *   always (does not reveal whether the token was live). Ends only the
 *   person's session.
 * - `setPin` / `resetPin` / `clearPin`: act as the `Authorization: Bearer`
 *   session when present (resolved here), else as the session
 *   the host's hook put in `event.locals` (which must include `authMethod` —
 *   `createSessionHandler` does), JSON
 *   `{ userId, pin, currentPin? }`; 204 on success, 400 on policy, 403 when
 *   the actor may not manage that PIN, 429 on a rate-limited current-PIN
 *   check.
 *
 * @packageDocumentation
 */

// Keeps this subpath self-sufficient when imported in isolation.
import '../__smrt-register__.js';

import { createLogger } from '@happyvertical/logger';
import {
  DeviceCredentialError,
  DeviceCredentialForbiddenError,
  DeviceCredentialPolicyError,
  DeviceCredentialService,
  type DeviceCredentialServiceOptions,
} from '../services/DeviceCredentialService.js';
import { LoginRateLimitError } from '../services/LoginAttemptLimiter.js';
import type { SessionContext } from '../services/SessionService.js';

const logger = createLogger({ level: 'info' });

type RequestEvent = {
  getClientAddress?: () => string;
  locals?: Record<string, unknown>;
  request: Request;
  url: URL;
};

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

function bearer(event: RequestEvent): string | null {
  const match = event.request.headers
    .get('authorization')
    ?.match(/^Bearer\s+(.+)$/iu);
  return match?.[1]?.trim() || null;
}

async function body(event: RequestEvent): Promise<Record<string, unknown>> {
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
  if (error instanceof DeviceCredentialError) {
    return json(
      { error: 'Invalid credentials.', code: 'invalid_credentials' },
      401,
      NO_STORE_HEADERS,
    );
  }
  if (error instanceof DeviceCredentialForbiddenError) {
    return json({ error: error.message, code: 'forbidden' }, 403);
  }
  if (error instanceof DeviceCredentialPolicyError) {
    return json({ error: error.message, code: 'pin_policy' }, 400);
  }
  logger.error('Device credential handler error', { error });
  return json({ error: 'Internal error.', code: 'internal' }, 500);
}

/**
 * The actor for management calls.
 *
 * A bearer header wins and is resolved by the service itself (without
 * extending the session), because that is how a PIN session arrives and the
 * host's cookie hook will not have seen it. Otherwise the host's session hook
 * must have populated `event.locals` *including* `authMethod`: an actor whose
 * channel is unknown is refused rather than assumed first-class, so the
 * "a PIN session can never administer PINs" guarantee cannot be lost by a
 * host hook that forgot to copy the field.
 */
async function resolveActor(
  event: RequestEvent,
  service: DeviceCredentialService,
): Promise<SessionContext | null> {
  const token = bearer(event);
  if (token) return service.resolveActor(token);

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

export interface DeviceCredentialHandlers {
  pinSignIn: (event: RequestEvent) => Promise<Response>;
  signOut: (event: RequestEvent) => Promise<Response>;
  setPin: (event: RequestEvent) => Promise<Response>;
  resetPin: (event: RequestEvent) => Promise<Response>;
  clearPin: (event: RequestEvent) => Promise<Response>;
  /** The lazily created service, for hosts that add their own verifiers. */
  service: () => Promise<DeviceCredentialService>;
}

export function createDeviceCredentialHandlers(
  options: DeviceCredentialServiceOptions,
): DeviceCredentialHandlers {
  let servicePromise: Promise<DeviceCredentialService> | null = null;
  const service = () => {
    servicePromise ??= DeviceCredentialService.create(options);
    return servicePromise;
  };
  const meta = (event: RequestEvent) => ({
    ipAddress: event.getClientAddress?.(),
    userAgent: event.request.headers.get('user-agent') ?? undefined,
  });

  return {
    service,

    pinSignIn: async (event) => {
      const deviceToken = bearer(event);
      const input = await body(event);
      const userId = str(input.userId).trim();
      const pin = str(input.pin);
      // A request missing its token, user id or PIN gets the same 401 the
      // pipeline gives every other refusal, so the response does not reveal
      // which step refused it.
      if (!deviceToken || !userId || !pin) {
        return json(
          { error: 'Invalid credentials.', code: 'invalid_credentials' },
          401,
          NO_STORE_HEADERS,
        );
      }
      try {
        const result = await (await service()).signInWithPin({
          deviceToken,
          userId,
          pin,
          ...meta(event),
        });
        return json(result, 201, NO_STORE_HEADERS);
      } catch (error) {
        return errorResponse(error);
      }
    },

    signOut: async (event) => {
      const token = bearer(event);
      if (token) {
        try {
          await (await service()).signOut(token);
        } catch (error) {
          logger.error('Device credential sign-out error', { error });
        }
      }
      return json({ authenticated: false }, 200, NO_STORE_HEADERS);
    },

    setPin: async (event) => {
      const actor = await resolveActor(event, await service());
      if (!actor)
        return json(
          { error: 'Unauthenticated.', code: 'unauthenticated' },
          401,
        );
      const input = await body(event);
      try {
        await (await service()).setPin({
          actor,
          userId: str(input.userId).trim() || (actor.user.id ?? ''),
          pin: str(input.pin),
          currentPin: str(input.currentPin) || undefined,
          ipAddress: event.getClientAddress?.(),
        });
        return new Response(null, { status: 204, headers: NO_STORE_HEADERS });
      } catch (error) {
        return errorResponse(error);
      }
    },

    resetPin: async (event) => {
      const actor = await resolveActor(event, await service());
      if (!actor)
        return json(
          { error: 'Unauthenticated.', code: 'unauthenticated' },
          401,
        );
      const input = await body(event);
      try {
        const result = await (await service()).resetPin({
          actor,
          userId: str(input.userId).trim(),
          pin: str(input.pin),
          ipAddress: event.getClientAddress?.(),
        });
        return json(result, 200, NO_STORE_HEADERS);
      } catch (error) {
        return errorResponse(error);
      }
    },

    clearPin: async (event) => {
      const actor = await resolveActor(event, await service());
      if (!actor)
        return json(
          { error: 'Unauthenticated.', code: 'unauthenticated' },
          401,
        );
      const input = await body(event);
      try {
        const result = await (await service()).clearPin({
          actor,
          userId: str(input.userId).trim() || (actor.user.id ?? ''),
          ipAddress: event.getClientAddress?.(),
        });
        return json(result, 200, NO_STORE_HEADERS);
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}
