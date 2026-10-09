import { error } from '@sveltejs/kit';
import { getModel } from '$lib/catalog/index.ts';
import { recipeNav, recipes } from '$lib/recipes/index.ts';
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

export const load: PageLoad = ({ params }) => {
  const known = recipes.some((recipe) =>
    recipeNav(recipe).some(
      (e) =>
        e.key === params.view &&
        e.packageId === params.package &&
        e.model.name === params.model,
    ),
  );
  if (!getModel(params.package, params.model) || !known) {
    error(404, `Unknown view ${params.package}/${params.model}/${params.view}`);
  }
  return {
    packageId: params.package,
    modelName: params.model,
    view: params.view,
  };
};
