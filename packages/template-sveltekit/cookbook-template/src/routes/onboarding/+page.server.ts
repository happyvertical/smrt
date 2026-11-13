import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = async ({ locals, parent, url }) => {
  if (!locals.user) redirect(303, '/setup');
  const data = await parent();
  if (
    data.onboarding?.completed &&
    !data.onboarding.rerunning &&
    url.searchParams.get('restart') !== '1'
  )
    redirect(303, '/');
  return { onboarding: data.onboarding };
};
