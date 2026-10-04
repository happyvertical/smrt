import { createOwnerSetupPage } from '@happyvertical/smrt-app-runtime/sveltekit';

import { runtime } from '$lib/server/smrt';

/**
 * Local-profile, loopback-only, single-use owner bootstrap. The runtime
 * removes the `pnpm app:setup` onboarding hand-off files once the claim commits.
 */
export const { load, actions } = createOwnerSetupPage(runtime);
