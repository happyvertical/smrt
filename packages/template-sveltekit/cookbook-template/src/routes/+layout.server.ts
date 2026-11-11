import { host } from '$lib/server/smrt';
import { loadCookbook } from '$lib/server/cookbook';
import type { LayoutServerLoad } from './$types';
export const load: LayoutServerLoad = async (event) => {
  const data = await host.load(event);
  return { ...data, embed: event.url.searchParams.get('embed') === '1',
    cookbookApp: data.session.authenticated ? await loadCookbook({ signedIn: true }) : data.cookbookApp };
};
