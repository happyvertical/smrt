import { loadError, ownerOf } from '$lib/server/http';
import { DEPENDS } from '$lib/ui/events';
import { needOwner } from '$lib/ui/load';
import type { PageServerLoad } from './$types';

/** The changes themselves come from the layout (one source for the count). */
export const load: PageServerLoad = async (event) => {
  await ownerOf(event).catch(loadError);
  const { parent, depends } = event;
  depends(DEPENDS.changes);
  needOwner((await parent()).description);
  return {};
};
