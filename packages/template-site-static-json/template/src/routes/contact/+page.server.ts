import type { PageServerLoad } from './$types';

export const prerender = true;

export const load: PageServerLoad = async ({ parent }) => {
  const { siteConfig } = await parent();
  return { siteConfig };
};
