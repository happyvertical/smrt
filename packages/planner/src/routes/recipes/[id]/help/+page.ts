import { error } from '@sveltejs/kit';
import { getRecipe, recipes } from '$lib/recipes/index.ts';
import type { EntryGenerator, PageLoad } from './$types';

export const entries: EntryGenerator = () =>
  recipes.map((recipe) => ({ id: recipe.id }));

export const load: PageLoad = ({ params }) => {
  if (!getRecipe(params.id)) error(404, `Unknown recipe ${params.id}`);
  return { id: params.id };
};
