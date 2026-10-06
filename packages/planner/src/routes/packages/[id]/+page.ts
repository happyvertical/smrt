import { error } from '@sveltejs/kit';
import { catalog, getPackage } from '$lib/catalog/index.ts';
import type { EntryGenerator, PageLoad } from './$types';

export const entries: EntryGenerator = () =>
  catalog.packages.map((pkg) => ({ id: pkg.id }));

export const load: PageLoad = ({ params }) => {
  if (!getPackage(params.id)) error(404, `Unknown package ${params.id}`);
  return { id: params.id };
};
