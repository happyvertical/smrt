import { reportCsv } from '@happyvertical/smrt-reports/display';
import { hostFor } from '$lib/server/host';
import { guarded, HttpError, ident, ownerOf } from '$lib/server/http';
import { principalFor } from '$lib/server/owner';
import { reportFailure } from '$lib/server/report-display';
import { reportCell } from '$lib/ui/reports';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = guarded(async (event) => {
  const owner = await ownerOf(event);
  const host = await hostFor('live');
  const name = ident(event.params.name, 'report');
  if (!Object.hasOwn(host.describe().reports ?? {}, name))
    throw new HttpError(404, 'This report is no longer available.');
  try {
    const result = await host.runReport(principalFor(owner, host.def), name);
    return new Response(reportCsv(result, reportCell), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'cache-control': 'no-store',
        'content-disposition': `attachment; filename="${name}${result.truncated ? '-bounded-sample' : ''}.csv"`,
      },
    });
  } catch (error) {
    throw reportFailure(error, host.def, host.def.reports?.[name]);
  }
});
