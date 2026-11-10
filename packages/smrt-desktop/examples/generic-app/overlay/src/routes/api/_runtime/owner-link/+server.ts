import { createOwnerLinkHandler } from '@happyvertical/smrt-app-runtime/sveltekit';

import { runtime } from '$lib/server/smrt';

/**
 * The route the desktop wrapper opens its window on (`ownerClaimRoute`):
 * loopback-only, a redirect to the one-time `/setup?token=...` page while the
 * owner is unclaimed and to `/` afterwards.
 */
export const GET = createOwnerLinkHandler(runtime);
