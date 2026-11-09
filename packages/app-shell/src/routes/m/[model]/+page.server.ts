import { DEPENDS } from '$lib/ui/events';
import {
  loadRecords,
  loadReferences,
  needModel,
  needOwner,
} from '$lib/ui/load';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({
  params,
  parent,
  depends,
  fetch,
}) => {
  depends(DEPENDS.records);
  const description = needOwner((await parent()).description);
  const info = needModel(description, params.model);
  const [rows, references] = await Promise.all([
    loadRecords(fetch, params.model),
    loadReferences(fetch, info.fields, description.models),
  ]);
  return { model: params.model, rows, references };
};
