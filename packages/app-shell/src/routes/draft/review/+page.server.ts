import { redirect } from '@sveltejs/kit';
import { api } from '$lib/ui/api';
import { DEPENDS } from '$lib/ui/events';
import { needOwner } from '$lib/ui/load';
import type { DraftInfo } from '$lib/ui/types';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, depends, fetch }) => {
  depends(DEPENDS.shell);
  const description = needOwner((await parent()).description);
  // Parent data can predate a start finishing (or a discard in another tab).
  // Only mount the preview after the current server state confirms a draft.
  const { data } = await api<{ draft: DraftInfo | null }>('/api/shell/draft', {
    fetch,
  });
  if (!data.draft) redirect(303, '/');
  return { description: { ...description, draft: data.draft } };
};
