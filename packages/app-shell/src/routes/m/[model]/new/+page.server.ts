import { redirect } from '@sveltejs/kit';
import { callerOf, loadError } from '$lib/server/http';
import { DEPENDS } from '$lib/ui/events';
import { loadReferences, needModel, needOwner } from '$lib/ui/load';
import { modelHref } from '$lib/ui/menu';
import { parseLinkParam } from '$lib/ui/related';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  // The owner, or staff: the record route re-checks every write per model.
  await callerOf(event).catch(loadError);
  const { params, parent, depends, fetch, url } = event;
  depends(DEPENDS.records);
  const description = needOwner((await parent()).description);
  if (!Object.hasOwn(description.models, params.model)) redirect(303, '/');
  const info = needModel(description, params.model);
  // `?with=field:id` starts the record linked to another one (Add on a
  // record page); finishing returns to that record.
  const link = parseLinkParam(url.searchParams.get('with'), info);
  return {
    model: params.model,
    prefill: link ? { [link.field]: link.id } : {},
    returnTo: link
      ? `${modelHref(link.ref)}/${encodeURIComponent(link.id)}`
      : null,
    references: await loadReferences(
      fetch,
      info.fields,
      description.models,
      description.mode,
    ),
  };
};
