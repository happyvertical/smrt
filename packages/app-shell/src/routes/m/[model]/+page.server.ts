import { redirect } from '@sveltejs/kit';
import { callerOf, loadError } from '$lib/server/http';
import { DEPENDS } from '$lib/ui/events';
import {
  loadRecords,
  loadReferences,
  needModel,
  needOwner,
} from '$lib/ui/load';
import { parseLinkParam } from '$lib/ui/related';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  // The owner, or staff: the record route re-checks every read per model.
  await callerOf(event).catch(loadError);
  const { params, parent, depends, fetch, url } = event;
  depends(DEPENDS.records);
  const description = needOwner((await parent()).description);
  if (!Object.hasOwn(description.models, params.model)) redirect(303, '/');
  const info = needModel(description, params.model);
  // `?where=field:id` shows only the records linked to one other record.
  const link = parseLinkParam(url.searchParams.get('where'), info);
  const [rows, references] = await Promise.all([
    loadRecords(fetch, params.model, 500, description.mode, link ?? undefined),
    loadReferences(fetch, info.fields, description.models, description.mode),
  ]);
  return {
    model: params.model,
    rows,
    references,
    filter: link ? { field: link.field, id: link.id, ref: link.ref } : null,
  };
};
