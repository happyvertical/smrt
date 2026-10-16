import { error } from '@sveltejs/kit';
import { catalog, exposedModels, getModel } from '$lib/catalog/index.ts';
import type { EntryGenerator, PageLoad } from './$types';

export const entries: EntryGenerator = () =>
  catalog.packages.flatMap((pkg) =>
    exposedModels(pkg).map((model) => ({
      package: pkg.id,
      model: model.name,
    })),
  );

export const load: PageLoad = ({ params }) => {
  if (!getModel(params.package, params.model)) {
    error(404, `Unknown model ${params.package}/${params.model}`);
  }
  return { packageId: params.package, modelName: params.model };
};
