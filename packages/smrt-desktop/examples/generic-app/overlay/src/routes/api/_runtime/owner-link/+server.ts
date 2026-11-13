import { createOwnerLinkHandler } from '@happyvertical/smrt-app-runtime/sveltekit';

import { runtime } from '$lib/server/smrt';

/**
 * The route the desktop wrapper opens its window on (`ownerClaimRoute`):
 * loopback-only and launch-secret-gated. The secret already proves the local
 * person, so `autoClaim` signs them in without a form: it creates the local
 * owner on the first launch, issues a new session when the cookie is gone, and
 * redirects to `/`.
 */
export const GET = createOwnerLinkHandler(runtime, { autoClaim: true });
