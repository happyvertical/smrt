import { error } from '@sveltejs/kit';
import { assertMaterializedReportRead, findMaterializedReportHost } from '@happyvertical/smrt-reports';
import { materializedReportHosts } from '$lib/server/materialized-reports';
import type { PageServerLoad } from './$types';

function pageValue(value: string | null, fallback: number, maximum: number): number {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) error(400, 'Invalid report page');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) error(400, 'Invalid report page');
  return parsed;
}

export const load: PageServerLoad = async ({ locals, params, url }) => {
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
  const offset = pageValue(url.searchParams.get('offset'), 0, 100_000);
  const limit = pageValue(url.searchParams.get('limit'), 50, 100);
  if (limit < 1) error(400, 'Invalid report page');
  const result = await host.query(context, {
    version: 1, requestId: `materialized:${host.id}`, mode: 'rows',
    projection: [descriptor.identityField, ...descriptor.dataTable.columns.map((column) => column.id)],
    page: { kind: 'offset', offset, limit },
  });
  if (result.page?.kind !== 'offset' || result.total.kind === 'unavailable')
    error(500, 'Report page unavailable');
  return {
    hostId: host.id,
    drilldownColumnIds: host.drilldownColumnIds,
    page: {
      descriptor,
      rows: result.rows,
      totalRows: result.total.value,
      offset: result.page.offset,
      limit: result.page.limit,
    },
  };
};
