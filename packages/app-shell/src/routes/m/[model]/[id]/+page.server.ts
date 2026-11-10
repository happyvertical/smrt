import { DEPENDS } from '$lib/ui/events';
import {
  load as loadApi,
  loadReferences,
  needModel,
  needOwner,
} from '$lib/ui/load';
import type { RecordRow } from '$lib/ui/types';
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
  const [record, references] = await Promise.all([
    loadApi<RecordRow>(
      fetch,
      `/api/shell/records/${encodeURIComponent(params.model)}/${encodeURIComponent(params.id)}`,
    ),
    loadReferences(fetch, info.fields, description.models),
  ]);
  return { model: params.model, record, references };
};
