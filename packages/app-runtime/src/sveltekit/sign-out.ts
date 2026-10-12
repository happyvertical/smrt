/**
 * Sign-out route handler: destroys the current session and clears its cookie
 * with the same cookie attributes the owner-setup action used to set it.
 */

import { destroySessionCookie } from '@happyvertical/smrt-users/sveltekit';
import { type RequestHandler, redirect } from '@sveltejs/kit';
import type { SmrtSvelteKitRuntime } from './runtime.js';

/** True when the browser says the request came from this origin. */
function isSameOriginRequest(request: Request, url: URL): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site !== null) return site === 'same-origin';
  const origin = request.headers.get('origin');
  return origin !== null && origin === url.origin;
}

/**
 * Mount as `src/routes/sign-out/+server.ts`:
 * `export const POST = createSignOutHandler(runtime);`
 *
 * `POST` only (other methods answer 405) and same-origin only (403 otherwise).
 * The session row is destroyed best-effort and the cookie is cleared even when
 * the row is already gone. Answers 204, or a 303 to `/` when the request
 * accepts HTML so a no-JS form post lands on the home page.
 */
export function createSignOutHandler(
  runtime: Pick<SmrtSvelteKitRuntime, 'sessionCookie' | 'classOptions'>,
): RequestHandler {
  return async (event) => {
    if (event.request.method !== 'POST') {
      return new Response('Method not allowed', {
        status: 405,
        headers: { allow: 'POST' },
      });
    }
    if (!isSameOriginRequest(event.request, event.url)) {
      return new Response('Forbidden', { status: 403 });
    }
    const cookie = runtime.sessionCookie;
    await destroySessionCookie(
      event as unknown as Parameters<typeof destroySessionCookie>[0],
      {
        ...runtime.classOptions('Session'),
        cookieName: cookie.name,
        cookiePath: cookie.path,
        ...(cookie.domain ? { cookieDomain: cookie.domain } : {}),
      },
    );
    // `delete` omits the Secure flag the setup action used; re-issue the
    // expiry with the same attributes so browsers match and drop the cookie.
    event.cookies.set(cookie.name, '', {
      path: cookie.path,
      ...(cookie.domain ? { domain: cookie.domain } : {}),
      httpOnly: true,
      secure: cookie.secure ?? event.url.protocol === 'https:',
      sameSite: cookie.sameSite,
      maxAge: 0,
    });
    if (event.request.headers.get('accept')?.includes('text/html')) {
      redirect(303, '/');
    }
    return new Response(null, { status: 204 });
  };
}
