import { createOwnerSetupPage } from '@happyvertical/smrt-app-runtime/sveltekit';

import { bootstrapCommerceTenant } from '$lib/server/commerce';
import { runtime } from '$lib/server/smrt';

/**
 * Local-profile, loopback-only, single-use owner bootstrap. The runtime
 * removes the `pnpm app:setup` onboarding hand-off files once the claim commits.
 * When the app installs commerce, the claimed tenant is initialized for it.
 */
export const { load, actions } = createOwnerSetupPage(runtime, {
  onOwnerClaimed: async ({ tenantId }) => {
    // The runtime ignores hook errors because the claim has committed, so
    // report a failure here; rerunning the bootstrap is safe.
    try {
      await bootstrapCommerceTenant(
        (await runtime.localRuntime()).db,
        tenantId,
      );
    } catch (error) {
      console.error(`Commerce bootstrap failed for tenant ${tenantId}`, error);
    }
  },
});
