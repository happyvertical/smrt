/**
 * CORS for generated SvelteKit routes (#5195).
 *
 * `sveltekit.cors` is the same explicit allow-list the runtime REST handler
 * takes (`allowedOrigins`, `allowCredentials`), and the emitted routes answer
 * through the same module (`generators/cors.ts`), so one origin gets the same
 * headers on both paths. With nothing configured the routes emit no CORS
 * surface at all: same-origin only, exactly as before.
 *
 * Instead of threading CORS through every `return` in every route template,
 * {@link applyRouteCors} post-processes an emitted route's source: each method
 * handler is renamed and re-exported behind one wrapper that adds the headers
 * to the response, including the response SvelteKit builds from a thrown
 * `error()`, and an `OPTIONS` handler answers the preflight.
 */

import { type CorsConfig, normalizeCorsOrigins } from '../generators/cors.js';

/** The `sveltekit.cors` option. */
export interface SvelteKitCorsOptions {
  /**
   * Explicit origin allow-list. A request's `Origin` is echoed only when it
   * appears here; there is no wildcard. Omit or leave empty for same-origin
   * only (no CORS headers).
   */
  allowedOrigins?: string[];
  /**
   * Add `Access-Control-Allow-Credentials: true` for an allow-listed origin so
   * a cross-origin browser client may send cookies. Ignored without a
   * non-empty `allowedOrigins`.
   */
  allowCredentials?: boolean;
}

/** The cleaned policy, or `undefined` when no CORS surface is configured. */
export function resolveRouteCors(
  cors: SvelteKitCorsOptions | undefined,
): CorsConfig | undefined {
  const allowedOrigins = normalizeCorsOrigins(cors?.allowedOrigins);
  if (allowedOrigins.length === 0) return undefined;
  return { allowedOrigins, allowCredentials: cors?.allowCredentials === true };
}

const METHOD_EXPORT =
  /^export const (GET|POST|PUT|PATCH|DELETE): RequestHandler =/gm;

/**
 * Wrap an emitted route's method handlers in the shared CORS policy and add its
 * `OPTIONS` preflight. Returns the source untouched when no CORS surface is
 * configured, or when the source exports no method handler.
 */
export function applyRouteCors(
  source: string,
  cors: SvelteKitCorsOptions | undefined,
): string {
  const policy = resolveRouteCors(cors);
  if (!policy) return source;

  const methods: string[] = [];
  const renamed = source.replace(METHOD_EXPORT, (_match, method: string) => {
    methods.push(method);
    return `const ${innerName(method)}: RequestHandler =`;
  });
  if (methods.length === 0) return source;

  const exports = methods
    .map(
      (method) =>
        `export const ${method}: RequestHandler = withRouteCors(${innerName(method)});`,
    )
    .join('\n');
  return `${renamed}
import { isHttpError } from '@sveltejs/kit';
import { applyCorsHeaders, corsPreflightResponse } from '@happyvertical/smrt-core';

// Cross-origin access (#5195): the explicit \`sveltekit.cors\` allow-list, decided
// by the same policy as the runtime REST handler. CORS never authorizes; it only
// lets an allow-listed browser's cookies reach the route's own sign-in and
// permission decision above.
const ROUTE_CORS = ${JSON.stringify(policy)};

function withRouteCors(handler: RequestHandler): RequestHandler {
  return async (event) => {
    try {
      return applyCorsHeaders(await handler(event), event.request, ROUTE_CORS);
    } catch (thrown) {
      // \`error()\` throws; SvelteKit would build a response with no CORS
      // headers, so answer it here the way SvelteKit would.
      if (isHttpError(thrown)) {
        return applyCorsHeaders(
          new Response(JSON.stringify(thrown.body), {
            status: thrown.status,
            headers: { 'content-type': 'application/json' },
          }),
          event.request,
          ROUTE_CORS,
        );
      }
      throw thrown;
    }
  };
}

${exports}
export const OPTIONS: RequestHandler = async ({ request }) =>
  corsPreflightResponse(request, ROUTE_CORS);
`;
}

function innerName(method: string): string {
  return `${method}Handler`;
}
