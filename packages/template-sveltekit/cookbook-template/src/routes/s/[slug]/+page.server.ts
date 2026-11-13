import { hasCookbook } from '@happyvertical/smrt-svelte/cookbook/server';
import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/** A section of the cookbook's navigation; the page itself is client-rendered. */
export const load: PageServerLoad = async ({ locals }) => {
  if (!(await hasCookbook())) error(404, 'This app has no cookbook.');
  if (!locals.user) redirect(303, '/setup');
  return {};
};
