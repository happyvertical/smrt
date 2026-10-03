import { createSessionLayoutLoad } from '@happyvertical/smrt-app-runtime/sveltekit';

/**
 * Server-owned session summary: whether a user is signed in, the tenant the
 * session authorizes, and (display only) the URL-selected tenant candidate.
 */
export const load = createSessionLayoutLoad();
