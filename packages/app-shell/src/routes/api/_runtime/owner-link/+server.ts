import { createOwnerLinkHandler } from '@happyvertical/smrt-app-runtime/sveltekit';

import { runtime } from '$lib/server/smrt';

/**
 * The route the desktop wrapper opens its window on (`ownerClaimRoute` in
 * `smrt-desktop.json`): loopback-only, and only with the per-launch secret the
 * wrapper keeps to itself. It redirects to the one-time `/setup?token=...` page
 * while the owner is unclaimed and to `/` afterwards. Outside the desktop
 * wrapper (no secret configured) every request answers 403.
 */
export const GET = createOwnerLinkHandler(runtime);
