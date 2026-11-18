/**
 * Transport kernel: HTTP adapter (#5158). Owned by K7; the list envelope is
 * switched on here by F10 and the body limit by F11, and nowhere else.
 */
import { notImplemented } from './not-implemented.js';
import type { HttpBinding, HttpHandlers } from './types.js';

/**
 * Read and parse a JSON request body.
 *
 * Contract:
 * - Stops reading at `maxBytes` and throws `REQUEST_TOO_LARGE`; a declared
 *   `Content-Length` over the limit is refused before any byte is read.
 * - A body that is not JSON throws `REQUEST_MALFORMED`; a media type that is
 *   not JSON throws `REQUEST_UNSUPPORTED_MEDIA_TYPE`.
 * - An empty body is `undefined`, not an error.
 * - Never called before the caller is authorised.
 */
export function readJsonBody(
  _request: Request,
  _options?: { readonly maxBytes?: number },
): Promise<unknown> {
  return notImplemented('readJsonBody', 'K7');
}

/**
 * Build the handlers a route file exports for one model.
 *
 * Contract:
 * - Returns web `Response` objects; imports no web framework.
 * - Each handler resolves the principal, calls `executeOperation`, and
 *   renders the result or the `toTransportError` body. Nothing else.
 * - Conditional-GET and cache headers are the adapter's; they never decide
 *   who may read.
 * - `PATCH` and `count` handlers exist for every binding; whether a transport
 *   routes to them is that transport's choice.
 * - While `binding.profile.results` is present, status codes and envelopes
 *   are that transport's.
 */
export function createHttpHandlers(_binding: HttpBinding): HttpHandlers {
  return notImplemented('createHttpHandlers', 'K7');
}
