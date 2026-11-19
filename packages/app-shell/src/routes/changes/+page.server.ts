import { DEPENDS } from '$lib/ui/events';
import { needOwner } from '$lib/ui/load';
import type { PageServerLoad } from './$types';

/** The changes themselves come from the layout (one source for the count). */
export const load: PageServerLoad = async ({ parent, depends }) => {
  depends(DEPENDS.changes);
  needOwner((await parent()).description);
  return {};
};
