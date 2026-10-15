import { error } from '@sveltejs/kit';
import { assertMaterializedReportRead, findMaterializedReportHost } from '@happyvertical/smrt-reports';
import { materializedReportHosts } from '$lib/server/materialized-reports';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
  if (!locals.user?.id || !locals.tenantId) error(401, 'Sign in required');
  const host = findMaterializedReportHost(materializedReportHosts, params.id);
  if (!host) error(404, 'Report not found');
  const context = {
    userId: locals.user.id,
    tenantId: locals.tenantId,
    permissions: locals.permissions ?? [],
  };
  try { assertMaterializedReportRead(host, context); } catch { error(403, 'Report unavailable'); }
  return {
    hostId: host.id,
    page: await host.query(context, { limit: 50, offset: 0 }),
    descriptor: await host.descriptor(context),
  };
};
