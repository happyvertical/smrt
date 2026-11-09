/**
 * The desktop wrapper's owner link: a fixed, loopback-only route that answers
 * a `GET` with a redirect to the local owner setup page.
 *
 * The wrapper opens its window on this route (the sidecar manifest's
 * `ownerClaimRoute`), so it never sees the one-time token: the `Location`
 * header reaches only the webview. The token comes from the existing
 * bootstrap invitation (`ownerSetupLocation()`); this module issues,
 * stores, logs and returns nothing else, and single use stays enforced by
 * `claimOwner()`.
 */

import type { RequestHandler } from '@sveltejs/kit';
import { isLoopbackAddress, isLoopbackHostname } from './owner-setup.js';
import type { SmrtSvelteKitRuntime } from './runtime.js';

/**
 * The route the desktop wrapper opens (`ownerClaimRoute` in the sidecar
 * manifest and `sidecar.ownerClaimRoute` in `smrt-desktop.json`). Mount it as
 * `src/routes/api/_runtime/owner-link/+server.ts`.
 */
export const OWNER_LINK_ROUTE = '/api/_runtime/owner-link';

const NO_STORE = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
} as const;

/**
 * True only for a request from this device, addressed to the app's own origin:
 * a loopback peer, a loopback `Host` that is exactly the app's host, no
 * foreign `Origin`, and no cross-site fetch metadata.
 */
function isOwnOriginLoopbackRequest(event: {
  readonly url: URL;
  readonly request: Request;
  getClientAddress(): string;
}): boolean {
  let address: string;
  try {
    address = event.getClientAddress();
  } catch {
    return false;
  }
  if (!isLoopbackAddress(address) || !isLoopbackHostname(event.url.hostname)) {
    return false;
  }
  const host = event.request.headers.get('host');
  if (host !== null && host.trim().toLowerCase() !== event.url.host) {
    return false;
  }
  const origin = event.request.headers.get('origin');
  if (origin !== null && origin !== event.url.origin) return false;
  const site = event.request.headers.get('sec-fetch-site');
  return site !== 'cross-site' && site !== 'same-site';
}

/**
 * Mount as `src/routes/api/_runtime/owner-link/+server.ts`:
 * `export const GET = createOwnerLinkHandler(runtime);`
 *
 * `GET` only (other methods answer 405 through SvelteKit). A request that is
 * not a same-origin loopback request answers 403 with an empty body. Otherwise
 * it answers `302` to `/setup?token=<one-time token>` while the local owner is
 * unclaimed and to `/` in every other case (claimed, deployed profile, nothing
 * issuable). The body is always empty, the response is never cached, and the
 * token appears nowhere but the `Location` header.
 */
export function createOwnerLinkHandler(
  runtime: Pick<SmrtSvelteKitRuntime, 'ownerSetupLocation'>,
): RequestHandler {
  return async (event) => {
    if (!isOwnOriginLoopbackRequest(event)) {
      return new Response(null, { status: 403, headers: NO_STORE });
    }
    let location = '/';
    try {
      location = await runtime.ownerSetupLocation();
    } catch {
      // Fall back to the home page; never surface the error text.
    }
    return new Response(null, {
      status: 302,
      headers: { ...NO_STORE, location },
    });
  };
}
