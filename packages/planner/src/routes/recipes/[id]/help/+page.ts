import { error } from '@sveltejs/kit';
import { getSection, sections } from '$lib/recipes/index.ts';
import type { EntryGenerator, PageLoad } from './$types';

// `id` is a section id: a recipe id, or the group id of several recipes.
export const entries: EntryGenerator = () =>
  sections.map((section) => ({ id: section.id }));

export const load: PageLoad = ({ params }) => {
  if (!getSection(params.id)) error(404, `Unknown recipe section ${params.id}`);
  return { id: params.id };
};
