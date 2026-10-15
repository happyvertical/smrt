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
  const descriptor = await host.descriptor(context);
  return {
    hostId: host.id,
    drilldownColumnIds: host.drilldownColumnIds,
    page: await host.query(context, {
      version: 1, requestId: `materialized:${host.id}`, mode: 'rows',
      projection: [descriptor.identityField, ...descriptor.dataTable.columns.map((column) => column.id)],
      page: { kind: 'offset', offset: 0, limit: 50 },
    }),
    descriptor,
  };
};
