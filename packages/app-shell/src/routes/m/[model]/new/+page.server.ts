import { redirect } from '@sveltejs/kit';
import { DEPENDS } from '$lib/ui/events';
import { loadReferences, needModel, needOwner } from '$lib/ui/load';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({
  params,
  parent,
  depends,
  fetch,
}) => {
  depends(DEPENDS.records);
  const description = needOwner((await parent()).description);
  if (!Object.hasOwn(description.models, params.model)) redirect(303, '/');
  const info = needModel(description, params.model);
  return {
    model: params.model,
    references: await loadReferences(
      fetch,
      info.fields,
      description.models,
      description.mode,
    ),
  };
};
