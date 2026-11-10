import { createSignOutHandler } from '@happyvertical/smrt-app-runtime/sveltekit';

import { runtime } from '$lib/server/smrt';

/** POST-only, same-origin: destroys the session and clears its cookie. */
export const POST = createSignOutHandler(runtime);
