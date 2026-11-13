import { DEPENDS } from '$lib/ui/events';
import { load as loadApi, needOwner } from '$lib/ui/load';
import type { ApprovalView } from '$lib/ui/types';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, depends, fetch }) => {
  depends(DEPENDS.approvals);
  const description = needOwner((await parent()).description);
  const { approvals } = await loadApi<{ approvals: ApprovalView[] }>(
    fetch,
    '/api/shell/approvals',
    'live',
  );
  return { approvals };
};
