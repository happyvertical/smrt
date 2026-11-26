/**
 * The one CORS policy for generated and runtime routes (#5195).
 *
 * The runtime REST handler (`rest.ts`) and the generated SvelteKit routes
 * answer a cross-origin request the same way, by calling this module:
 *
 * - an origin is allowed only when it appears, verbatim, in an explicit
 *   allow-list; there is no wildcard, so `*` is never echoed and a `*` entry
 *   in the list is discarded;
 * - an allowed origin is echoed (never `*`) with `Vary: Origin`;
 * - `Access-Control-Allow-Credentials: true` accompanies only an allowed,
 *   echoed origin, and only when `allowCredentials` is set. An empty
 *   allow-list therefore never carries credentials;
 * - a disallowed or absent origin gets no `Access-Control-Allow-Origin`, so the
 *   route stays same-origin only (the default when nothing is configured);
 * - a preflight answers with the allowed methods and headers.
 *
 * CORS never authorizes: it only lets an allow-listed browser's cookies and
 * headers reach the route's own sign-in and permission decision
 * (`route-authz.ts`).
 *
 * Everything here is pure: configuration and a request origin in, header sets
 * out. The only `Request`/`Response` helpers wrap those header sets.
 */

/** A CORS posture. Nothing configured means no CORS surface. */
export interface CorsConfig {
  /**
   * Explicit origin allow-list (`https://app.example.com`). A request's
   * `Origin` is echoed only when it appears here. Never `*`.
   */
  allowedOrigins?: readonly string[];
  /**
   * Add `Access-Control-Allow-Credentials: true` for an allowed origin so a
   * cross-origin browser client may send cookies. Ignored without a non-empty
   * allow-list.
   */
  allowCredentials?: boolean;
}

/** Methods a preflight and a CORS response advertise. */
export const CORS_ALLOWED_METHODS = 'GET,POST,PUT,PATCH,DELETE,OPTIONS';

/**
 * Request headers a preflight and a CORS response advertise. `Last-Event-ID`
 * lets a fetch-based cross-origin SSE client resume the `_events` stream from a
 * cursor; it is harmless on routes that ignore it.
 */
export const CORS_ALLOWED_HEADERS = 'Content-Type,Authorization,Last-Event-ID';

/** Seconds a browser may cache a preflight answer. */
export const CORS_MAX_AGE = '86400';

/**
 * Trim, de-duplicate and clean a configured allow-list: non-strings, empty
 * entries and `*` are dropped, so the result can never name a wildcard.
 */
export function normalizeCorsOrigins(origins: unknown): string[] {
  if (!Array.isArray(origins)) return [];
  const cleaned = new Set<string>();
  for (const origin of origins) {
    if (typeof origin !== 'string') continue;
    const trimmed = origin.trim();
    if (trimmed.length > 0 && trimmed !== '*') cleaned.add(trimmed);
  }
  return [...cleaned];
}

/** Whether a configuration produces any CORS surface at all. */
export function isCorsEnabled(config: CorsConfig | undefined): boolean {
  return normalizeCorsOrigins(config?.allowedOrigins).length > 0;
}

/**
 * The origin to echo as `Access-Control-Allow-Origin`: the request's `Origin`
 * when it is on the allow-list, otherwise `null`. Never `*`.
 */
export function resolveCorsOrigin(
  requestOrigin: string | null | undefined,
  config: CorsConfig | undefined,
): string | null {
  if (!requestOrigin) return null;
  const allowed = normalizeCorsOrigins(config?.allowedOrigins);
  return allowed.includes(requestOrigin) ? requestOrigin : null;
}

/**
 * Headers for an actual (non-preflight) response to `requestOrigin`. Empty when
 * the origin is not allowed.
 */
export function corsResponseHeaders(
  requestOrigin: string | null | undefined,
  config: CorsConfig | undefined,
): Record<string, string> {
  const origin = resolveCorsOrigin(requestOrigin, config);
  if (!origin) return {};
  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
    'Access-Control-Allow-Methods': CORS_ALLOWED_METHODS,
    'Access-Control-Allow-Headers': CORS_ALLOWED_HEADERS,
  };
  if (config?.allowCredentials === true) {
    headers['Access-Control-Allow-Credentials'] = 'true';
  }
  return headers;
}

/**
 * Headers for a preflight answer to `requestOrigin`. The method and header
 * lists are always present; the origin, `Vary` and credentials only for an
 * allowed origin.
 */
export function corsPreflightHeaders(
  requestOrigin: string | null | undefined,
  config: CorsConfig | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': CORS_ALLOWED_METHODS,
    'Access-Control-Allow-Headers': CORS_ALLOWED_HEADERS,
    'Access-Control-Max-Age': CORS_MAX_AGE,
  };
  const origin = resolveCorsOrigin(requestOrigin, config);
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers.Vary = 'Origin';
    if (config?.allowCredentials === true) {
      headers['Access-Control-Allow-Credentials'] = 'true';
    }
  }
  return headers;
}

/** The preflight response for a request: 200, empty body. */
export function corsPreflightResponse(
  request: Request,
  config: CorsConfig | undefined,
): Response {
  return new Response(null, {
    status: 200,
    headers: corsPreflightHeaders(request.headers.get('origin'), config),
  });
}

/**
 * Add the CORS headers for `request`'s origin to `response`. Returns the
 * response untouched when the origin is not allowed. An existing `Vary` is
 * extended, not replaced.
 */
export function applyCorsHeaders(
  response: Response,
  request: Request,
  config: CorsConfig | undefined,
): Response {
  const cors = corsResponseHeaders(request.headers.get('origin'), config);
  if (Object.keys(cors).length === 0) return response;

  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(cors)) {
    if (name === 'Vary') {
      const existing = headers.get('Vary');
      const tokens = (existing ?? '')
        .split(',')
        .map((token) => token.trim().toLowerCase());
      if (existing && !tokens.includes('origin') && !tokens.includes('*')) {
        headers.set('Vary', `${existing}, ${value}`);
      } else if (!existing) {
        headers.set('Vary', value);
      }
    } else {
      headers.set(name, value);
    }
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
