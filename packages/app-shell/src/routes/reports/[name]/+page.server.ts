import { error } from '@sveltejs/kit';
import { ApiError, api } from '$lib/ui/api';
import { DEPENDS } from '$lib/ui/events';
import { needOwner } from '$lib/ui/load';
import { reportApi } from '$lib/ui/reports';
import type { AppReportResult } from '$lib/ui/types';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = async ({
  parent,
  params,
  fetch,
  depends,
}) => {
  depends(DEPENDS.shell, DEPENDS.records);
  const description = needOwner((await parent()).description);
  const report = Object.hasOwn(description.reports ?? {}, params.name)
    ? description.reports?.[params.name]
    : undefined;
  if (!report) error(404, 'This report is no longer available.');
  let result: AppReportResult | null = null;
  let problem = '';
  try {
    result = (
      await api<AppReportResult>(reportApi(params.name), {
        fetch,
        target: description.mode,
      })
    ).data;
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403))
      error(e.status, 'Sign in as the owner to see this report.');
    problem =
      e instanceof ApiError
        ? e.message
        : 'This report could not run. Try again.';
  }
  return {
    name: params.name,
    report,
    result,
    problem,
    target: description.mode,
  };
};
