/**
 * Generated `_inference` HTTP route (#4757).
 *
 * `GET {basePath}/_inference[?tier=<tier>]` returns the ambient principal's
 * {@link InferenceStatus} (`{ available, mode, reason?, tier? }`) so a
 * settings page or a feature flag can hide AI actions. It never returns a
 * key, endpoint or model, never calls a model, and records no usage.
 *
 * When the app configures `authMiddleware` the route runs it as
 * `('_inference', 'status')` and returns its refusal; without one the route
 * answers for the tenant-less app configuration (the per-user resolver
 * finds no principal), which reveals only whether AI is configured.
 */

import type { InferenceStatus } from '../inference-availability.js';
import { inferenceStatusResponse } from '../inference-status.js';

/** Path segment the route is served at, under the API base path. */
export const INFERENCE_STATUS_ROUTE_SEGMENT = '_inference';

/** Structural copy of `APIConfig['authMiddleware']` (from `rest.ts`). */
type InferenceStatusAuthMiddleware = (
  objectName: string,
  action: string,
) => (req: Request) => Promise<Request | Response>;

export interface InferenceStatusRouteOptions {
  authMiddleware?: InferenceStatusAuthMiddleware;
}

export type { InferenceStatus };

/** Handle one `_inference` request. */
export async function handleInferenceStatusRoute(
  req: Request,
  options: InferenceStatusRouteOptions = {},
): Promise<Response> {
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        allow: 'GET',
      },
    });
  }
  let request = req;
  if (options.authMiddleware) {
    const result = await options.authMiddleware(
      INFERENCE_STATUS_ROUTE_SEGMENT,
      'status',
    )(req);
    if (result instanceof Response) return result;
    request = result;
  }
  return inferenceStatusResponse({ url: new URL(request.url), request });
}
