import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
  if (!locals.user?.id || !locals.tenantId) error(401, 'Sign in required');
  return {
    currentUserId: locals.user.id,
    currentUserLabel: locals.user.email,
    clientScope: locals.tenantId,
    canArchive: locals.permissions.includes('runtimereports.create'),
  };
};
