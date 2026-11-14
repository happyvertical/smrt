import { error, redirect } from '@sveltejs/kit';
import { homePath } from '$lib/server/cookbook';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, parent }) => {
  if (!locals.user) redirect(303, '/setup');
  const { cookbookApp } = await parent();
  if (!cookbookApp) error(404, 'This app has no cookbook.');
  if (
    !cookbookApp.cookbook.recipes.length &&
    !cookbookApp.cookbook.features.length
  )
    return { fresh: true };
  redirect(303, homePath(cookbookApp));
};
