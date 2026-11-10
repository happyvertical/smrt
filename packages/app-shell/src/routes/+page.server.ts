import { isDesktopWrapper } from '$lib/server/desktop';
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
          const rows = await loadRecords(
            fetch,
            model,
            COUNT_LIMIT,
            description.mode,
          );
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
  // The signed-out card words its way back in differently under the wrapper.
  return { counts, desktop: isDesktopWrapper() };
};
