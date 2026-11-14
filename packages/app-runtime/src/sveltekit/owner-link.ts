/**
 * The desktop wrapper's owner link: a fixed, loopback-only route that answers
 * a `GET` with a redirect to the local owner setup page.
 *
 * The wrapper opens its window on this route (the sidecar manifest's
 * `ownerClaimRoute`) with `?launch=<per-launch secret>`, so it never sees the
 * one-time token: the `Location` header reaches only the webview. The wrapper
 * generates the secret on every sidecar start and passes it only in the
 * sidecar's environment (`SMRT_DESKTOP_OWNER_LINK_SECRET`); without it, any
 * other process or OS user on the machine could fetch the link first. The token comes from the existing
 * bootstrap invitation (`ownerSetupLocation()`); this module issues,
 * stores, logs and returns nothing else, and single use stays enforced by
 * `claimOwner()`.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from '@sveltejs/kit';
import { isLoopbackAddress, isLoopbackHostname } from './owner-setup.js';
import type { SmrtSvelteKitRuntime } from './runtime.js';

/**
 * The route the desktop wrapper opens (`ownerClaimRoute` in the sidecar
 * manifest and `sidecar.ownerClaimRoute` in `smrt-desktop.json`). Mount it as
 * `src/routes/api/_runtime/owner-link/+server.ts`.
 */
export const OWNER_LINK_ROUTE = '/api/_runtime/owner-link';

/**
 * The environment variable the desktop wrapper sets, on the sidecar only, to
 * this launch's random secret.
 */
export const OWNER_LINK_SECRET_ENV = 'SMRT_DESKTOP_OWNER_LINK_SECRET';

/** The query parameter that carries the secret on the wrapper's first URL. */
export const OWNER_LINK_SECRET_PARAM = 'launch';

export interface OwnerLinkHandlerOptions {
  /**
   * The launch secret the `launch` query value must equal. Defaults to the
   * `SMRT_DESKTOP_OWNER_LINK_SECRET` environment variable, read per request.
   * When none is configured (an empty value counts as none) the route answers
   * 403 to every request.
   */
  readonly launchSecret?: string | null;
  /**
   * Sign the local person in without a form (opt-in; default false, which
   * keeps the redirect to the one-time `/setup?token=` page). With a valid
   * launch secret the handler creates the local owner when none exists, issues
   * a new session for the sole active owner when the request carries no valid
   * owner session, sets the session cookie and redirects to `/`. See
   * `SmrtSvelteKitRuntime.signInLocalOwner`. Needs a runtime that has it.
   */
  readonly autoClaim?: boolean;
  /**
   * Display name of an owner created by `autoClaim`. Defaults to the OS
   * account's user name.
   */
  readonly ownerName?: string;
}

type OwnerLinkRuntime = Pick<SmrtSvelteKitRuntime, 'ownerSetupLocation'> &
  Partial<Pick<SmrtSvelteKitRuntime, 'signInLocalOwner' | 'sessionCookie'>>;

const NO_STORE = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
} as const;

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Constant-time equality: both values are hashed first so lengths do not leak.
 * A missing or empty secret, or a missing or empty candidate, never matches.
 */
function launchSecretMatches(
  expected: string | null | undefined,
  candidate: string | null,
): boolean {
  const equal = timingSafeEqual(
    sha256(expected ?? ''),
    sha256(candidate ?? ''),
  );
  return equal && Boolean(expected) && Boolean(candidate);
}

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
 * not a same-origin loopback request, or that does not carry the launch secret
 * as `?launch=`, answers 403 with an empty body; with no secret configured
 * (the app is not running under the desktop wrapper) every request does.
 * Otherwise it answers `302` to `/setup?token=<one-time token>` while the local
 * owner is unclaimed and to `/` in every other case (claimed, deployed profile,
 * nothing issuable). With `autoClaim` it signs the local person in instead (see
 * {@link OwnerLinkHandlerOptions.autoClaim}) and always answers `302` to `/`. The body is always empty, the response is never cached,
 * and the token appears nowhere but the `Location` header. The secret and the
 * query string are never logged or echoed.
 */
export function createOwnerLinkHandler(
  runtime: OwnerLinkRuntime,
  options: OwnerLinkHandlerOptions = {},
): RequestHandler {
  if (
    options.autoClaim &&
    (!runtime.signInLocalOwner || !runtime.sessionCookie)
  ) {
    throw new Error(
      'createOwnerLinkHandler({ autoClaim: true }) needs a runtime with signInLocalOwner and sessionCookie.',
    );
  }
  return async (event) => {
    const secret =
      options.launchSecret !== undefined
        ? options.launchSecret
        : process.env[OWNER_LINK_SECRET_ENV];
    if (
      !isOwnOriginLoopbackRequest(event) ||
      !launchSecretMatches(
        secret,
        event.url.searchParams.get(OWNER_LINK_SECRET_PARAM),
      )
    ) {
      return new Response(null, { status: 403, headers: NO_STORE });
    }
    let location = '/';
    if (
      options.autoClaim &&
      runtime.signInLocalOwner &&
      runtime.sessionCookie
    ) {
      try {
        const current = (event.locals as { user?: { id?: unknown } | null })
          .user?.id;
        const result = await runtime.signInLocalOwner({
          ...(options.ownerName ? { name: options.ownerName } : {}),
          currentUserId: typeof current === 'string' ? current : null,
          userAgent: event.request.headers.get('user-agent') || undefined,
          ipAddress: event.getClientAddress(),
        });
        if (result?.sessionId) {
          const cookie = runtime.sessionCookie;
          event.cookies.set(cookie.name, result.sessionId, {
            path: cookie.path,
            ...(cookie.domain ? { domain: cookie.domain } : {}),
            httpOnly: true,
            secure: cookie.secure ?? event.url.protocol === 'https:',
            sameSite: cookie.sameSite,
            maxAge: cookie.maxAgeSeconds,
          });
        }
      } catch {
        // No or several active owners, or a store failure: no session is
        // issued and the person lands on the signed-out page.
      }
      return new Response(null, {
        status: 302,
        headers: { ...NO_STORE, location: '/' },
      });
    }
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
