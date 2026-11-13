import { createOwnerLinkHandler } from '@happyvertical/smrt-app-runtime/sveltekit';

import { runtime } from '$lib/server/smrt';

/**
 * The route the desktop wrapper opens its window on (`ownerClaimRoute` in
 * `smrt-desktop.json`): loopback-only, and only with the per-launch secret the
 * wrapper keeps to itself. That secret already proves the local person, so
 * `autoClaim` signs them in without a form: it creates the local owner on the
 * first launch, issues a new session when the cookie is gone, and redirects to
 * `/`. Outside the desktop wrapper (no secret configured) every request
 * answers 403.
 */
export const GET = createOwnerLinkHandler(runtime, { autoClaim: true });
