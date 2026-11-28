import { callerOf, loadError } from '$lib/server/http';
import { needOwner } from '$lib/ui/load';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = async (event) => {
  await callerOf(event).catch(loadError);
  const { parent } = event;
  const description = needOwner((await parent()).description);
  return { target: description.mode };
};
