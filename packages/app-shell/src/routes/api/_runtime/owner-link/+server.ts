import { createOwnerLinkHandler } from '@happyvertical/smrt-app-runtime/sveltekit';

import { shellProfile } from '$lib/server/host';
import { runtime } from '$lib/server/smrt';
import type { RequestHandler } from './$types';

const ownerLink = createOwnerLinkHandler(runtime, { autoClaim: true });

/**
 * The route the desktop wrapper opens its window on (`ownerClaimRoute` in
 * `smrt-desktop.json`): loopback-only, and only with the per-launch secret the
 * wrapper keeps to itself. That secret already proves the local person, so
 * `autoClaim` signs them in without a form: it creates the local owner on the
 * first launch, issues a new session when the cookie is gone, and redirects to
 * `/`. Outside the desktop wrapper (no secret configured) every request
 * answers 403.
 *
 * It does not exist in the cloud profile: there a person signs in with their
 * own account, and a request that reaches the host through a proxy must never
 * pass for "the person at this machine". The answer is a plain 404, before
 * the handler (or the runtime's local owner path) is touched.
 */
export const GET: RequestHandler = async (event) => {
  if ((await shellProfile()) !== 'local')
    return new Response('Not found', { status: 404 });
  return ownerLink(event as never);
};
