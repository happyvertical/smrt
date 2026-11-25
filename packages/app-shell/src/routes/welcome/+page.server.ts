// The welcome steps differ in the hosted app: no local AI tool, no ChatGPT
// sign-in and no workbook import (the desktop's), so the page asks the profile.
import { shellProfile } from '$lib/server/host';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => ({
  hosted: (await shellProfile()) === 'cloud',
});
