import { error } from '@sveltejs/kit';
import { getModel } from '$lib/catalog/index.ts';
import { hasNavKey } from '$lib/recipes/index.ts';
import type { PageLoad } from './$types';

// A record's edit page (`/m/<pkg>/<Model>/<id>/edit/`): the ids are sample
// data made in the browser, so nothing can be prerendered. The static
// fallback serves the app shell and this load runs there.
export const prerender = false;

export const load: PageLoad = ({ params }) => {
  if (
    !getModel(params.package, params.model) ||
    hasNavKey(params.package, params.model, params.view)
  ) {
    error(
      404,
      `Unknown record ${params.package}/${params.model}/${params.view}`,
    );
  }
  return {
    packageId: params.package,
    modelName: params.model,
    recordId: params.view,
    mode: 'edit' as const,
  };
};
