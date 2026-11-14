import { redirect } from '@sveltejs/kit';
import { loadCookbook } from '$lib/server/cookbook';
import { host } from '$lib/server/smrt';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async (event) => {
  const data = await host.load(event);
  if (
    data.onboarding &&
    !data.onboarding.completed &&
    !['/onboarding', '/settings/inference'].includes(event.url.pathname)
  )
    redirect(303, '/onboarding');
  return {
    ...data,
    embed: event.url.searchParams.get('embed') === '1',
    /** The project's cookbook and recipe catalog; `null` without a cookbook. */
    cookbookApp: data.session.authenticated
      ? await loadCookbook({
          signedIn: true,
        })
      : data.cookbookApp,
  };
};
