import { DEPENDS } from '$lib/ui/events';
import { loadRecords } from '$lib/ui/load';
import type { PageServerLoad } from './$types';

const COUNT_LIMIT = 1000;

export const load: PageServerLoad = async ({ parent, depends, fetch }) => {
  depends(DEPENDS.records);
  const { description } = await parent();
  const counts: Record<string, { count: number; capped: boolean } | null> = {};
  if (description) {
    await Promise.all(
      Object.keys(description.models).map(async (model) => {
        try {
          const rows = await loadRecords(fetch, model, COUNT_LIMIT);
          counts[model] = {
            count: rows.length,
            capped: rows.length >= COUNT_LIMIT,
          };
        } catch {
          counts[model] = null;
        }
      }),
    );
  }
  return { counts };
};
