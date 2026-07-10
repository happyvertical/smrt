import type { LayoutServerLoad } from './$types';

/**
 * Keep session and tenant state server-owned. The selected tenant is displayed
 * separately from the tenant authorized by the active session.
 */
export const load: LayoutServerLoad = async ({ locals }) => {
  return {
    session: {
      authenticated: Boolean(locals.user),
      activeTenantId: locals.tenantId,
      selectedTenantSlug: locals.selectedTenantSlug,
    },
  };
};
