import type { SmrtRuntimeLocals } from '@happyvertical/smrt-app-runtime/sveltekit';
import { createRuntimeReportConfirmHandler } from '@happyvertical/smrt-reports';
import { runtime } from '$lib/server/smrt';

const confirm = createRuntimeReportConfirmHandler();

/** Approve a report as the verified session user, on the request's database. */
export const POST = async ({
  request,
  locals,
}: {
  request: Request;
  locals: SmrtRuntimeLocals;
}): Promise<Response> => {
  if (!locals.user?.id || !locals.tenantId) return confirm(request, null);
  const collection = await runtime.getCollection('RuntimeReport');
  return confirm(request, {
    db: collection.db,
    userId: locals.user.id,
    tenantId: locals.tenantId,
    permissions: locals.permissions ?? [],
  });
};
