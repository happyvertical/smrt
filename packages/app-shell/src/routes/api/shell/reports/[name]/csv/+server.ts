import { reportCsv } from '@happyvertical/smrt-reports/display';
import { hostFor } from '$lib/server/host';
import { guarded, HttpError, ident, ownerOf, targetOf } from '$lib/server/http';
import { reportFailure } from '$lib/server/report-display';
import { reportCell } from '$lib/ui/reports';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = guarded(async (event) => {
  await ownerOf(event);
  const host = await hostFor(targetOf(event));
  const name = ident(event.params.name, 'report');
  if (!Object.hasOwn(host.describe().reports ?? {}, name))
    throw new HttpError(404, 'This report is no longer available.');
  try {
    const result = await host.runReport(name);
    return new Response(reportCsv(result, reportCell), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'cache-control': 'no-store',
        'content-disposition': `attachment; filename="${name}.csv"`,
      },
    });
  } catch (error) {
    throw reportFailure(error);
  }
});
