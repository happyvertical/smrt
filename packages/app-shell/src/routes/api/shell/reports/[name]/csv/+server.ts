import { reportCsv } from '@happyvertical/smrt-reports/display';
import { hostFor } from '$lib/server/host';
import {
  callerOf,
  guarded,
  HttpError,
  ident,
  principalOfCaller,
} from '$lib/server/http';
import { reportFailure } from '$lib/server/report-display';
import { assertStaffReport } from '$lib/server/staff-access';
import { reportCell } from '$lib/ui/reports';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = guarded(async (event) => {
  const who = await callerOf(event);
  const host = await hostFor('live');
  const name = ident(event.params.name, 'report');
  if (who.kind === 'staff') await assertStaffReport(who.principal, name);
  if (!Object.hasOwn(host.describe().reports ?? {}, name))
    throw new HttpError(404, 'This report is no longer available.');
  try {
    const result = await host.runReport(
      await principalOfCaller(who, host.def),
      name,
    );
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
