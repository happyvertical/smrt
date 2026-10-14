import { error } from '@sveltejs/kit';
import { getModel } from '$lib/catalog/index.ts';
import { hasNavKey, recipeNav, recipes } from '$lib/recipes/index.ts';
import type { EntryGenerator, PageLoad } from './$types';

/** A model shown twice in the menu (a keyed entry) has a page per key. */
export const entries: EntryGenerator = () =>
  recipes.flatMap((recipe) =>
    recipeNav(recipe).flatMap((entry) =>
      entry.key
        ? [
            {
              package: entry.packageId,
              model: entry.model.name,
              view: entry.key,
            },
          ]
        : [],
    ),
  );

/**
 * A keyed entry's page is prerendered; any other segment is a record id
 * (`/m/<pkg>/<Model>/<id>/`, the record's view page), served by the static
 * fallback and rendered in the browser from the sample data.
 */
export const load: PageLoad = ({ params }) => {
  if (!getModel(params.package, params.model)) {
    error(404, `Unknown model ${params.package}/${params.model}`);
  }
  if (hasNavKey(params.package, params.model, params.view)) {
    return {
      packageId: params.package,
      modelName: params.model,
      view: params.view,
    };
  }
  return {
    packageId: params.package,
    modelName: params.model,
    recordId: params.view,
    mode: 'view' as const,
  };
};
