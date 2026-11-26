// What the assistant can run on differs in the hosted app (the owner's own API
// key only), so the page asks the profile.
import { shellProfile } from '$lib/server/host';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => ({
  hosted: (await shellProfile()) === 'cloud',
});
