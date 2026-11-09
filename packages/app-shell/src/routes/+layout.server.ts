import { createSessionLayoutLoad } from '@happyvertical/smrt-app-runtime/sveltekit';
import { DEPENDS } from '$lib/ui/events';
import { loadDescription } from '$lib/ui/load';
import type { LayoutServerLoad } from './$types';

/**
 * Server-owned session summary (whether a user is signed in, the tenant the
 * session authorizes) plus the app's description for the owner. The menu, the
 * approvals badge and every page read the description from here; the live
 * store invalidates `smrt:shell` when it changes.
 */
const sessionLoad = createSessionLayoutLoad();

export const load: LayoutServerLoad = async (event) => {
  event.depends(DEPENDS.shell);
  const { session } = sessionLoad(event);
  if (!session.authenticated) return { session, description: null };
  const result = await loadDescription(event.fetch);
  return { session, description: result.ok ? result.description : null };
};
