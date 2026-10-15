import { json } from '@sveltejs/kit';
import { findMaterializedReportHost } from '@happyvertical/smrt-reports';
import { materializedReportHosts } from '$lib/server/materialized-reports';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, locals, params }) => {
  if (!locals.user?.id || !locals.tenantId)
    return json({ error: 'Sign in required' }, { status: 401 });
  const host = findMaterializedReportHost(materializedReportHosts, params.id);
  if (!host) return json({ error: 'Report not found' }, { status: 404 });
  let body: unknown;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, { status: 400 }); }
  if (!body || typeof body !== 'object') return json({ error: 'Invalid request' }, { status: 400 });
  const { id, columnId } = body as Record<string, unknown>;
  if (typeof id !== 'string' || !id || typeof columnId !== 'string' || !columnId)
    return json({ error: 'Invalid request' }, { status: 400 });
  try {
    return json(await host.drilldown({ userId: locals.user.id, tenantId: locals.tenantId, permissions: locals.permissions ?? [] }, { id, columnId }));
  } catch {
    return json({ error: 'Report drilldown unavailable' }, { status: 404 });
  }
};
