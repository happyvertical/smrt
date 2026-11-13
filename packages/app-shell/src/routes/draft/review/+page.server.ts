import { DEPENDS } from '$lib/ui/events';
import { needOwner } from '$lib/ui/load';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, depends }) => {
  depends(DEPENDS.shell);
  needOwner((await parent()).description);
  return {};
};
