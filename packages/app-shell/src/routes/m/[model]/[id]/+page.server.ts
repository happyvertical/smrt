import { redirect } from '@sveltejs/kit';
import { DEPENDS } from '$lib/ui/events';
import {
  load as loadApi,
  loadRecords,
  loadReferences,
  loadRelated,
  needModel,
  needOwner,
} from '$lib/ui/load';
import {
  columnReferenceModels,
  type RelatedData,
  relatedColumns,
  reverseRelations,
  TAB_ROWS,
} from '$lib/ui/related';
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
  if (!Object.hasOwn(description.models, params.model)) redirect(303, '/');
  const info = needModel(description, params.model);
  const [record, references] = await Promise.all([
    loadApi<RecordRow>(
      fetch,
      `/api/shell/records/${encodeURIComponent(params.model)}/${encodeURIComponent(params.id)}`,
      description.mode,
    ),
    loadReferences(fetch, info.fields, description.models, description.mode),
  ]);
  // One level only: the records that link to this one, never theirs. The
  // routes check the owner and name the copy; counts come from the same
  // filtered records route the table uses.
  const relations = reverseRelations(description.models, params.model);
  const related: RelatedData[] = await Promise.all(
    relations.map(async (r) => {
      const out = await loadRelated(
        fetch,
        r.model,
        TAB_ROWS,
        description.mode,
        { field: r.field, id: record.id },
      );
      return { key: r.key, ...out };
    }),
  );
  // Labels for the link cells those tables show (never this model's own).
  const labelModels = new Set<string>();
  relations.forEach((r, i) => {
    if (related[i].records.length === 0) return;
    for (const m of columnReferenceModels(
      relatedColumns(description.models[r.model], r.field),
    ))
      if (Object.hasOwn(description.models, m)) labelModels.add(m);
  });
  const relatedReferences = Object.fromEntries(
    await Promise.all(
      [...labelModels].map(
        async (m) =>
          [
            m,
            m in references
              ? references[m]
              : await loadRecords(fetch, m, 500, description.mode),
          ] as const,
      ),
    ),
  );
  return {
    model: params.model,
    record,
    references,
    related,
    relatedReferences,
  };
};
