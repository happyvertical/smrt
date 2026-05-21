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
import { withSessionPermissionContext } from '../services/SessionPermissionContext.js';
import { SessionService } from '../services/SessionService.js';

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
    url: { pathname: string };
    request: { headers: Headers };
  };
  resolve: (event: unknown) => Promise<Response>;
};

type Handle = (input: HandleInput) => Promise<Response>;

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
  // Default to secure in production (check for localhost in URL)
  const cookieSecure =
    options.cookieSecure ?? !event.url.pathname.includes('localhost');

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
