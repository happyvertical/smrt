import { needOwner } from '$lib/ui/load';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = async ({ parent }) => {
  const description = needOwner((await parent()).description);
  return { target: description.mode };
};
