import type { ModelAccessRow } from '$lib/server/access-settings';
import { loadError, ownerOf } from '$lib/server/http';
import { api } from '$lib/ui/api';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  await ownerOf(event).catch(loadError);
  const { fetch } = event;
  return (
    await api<{ models: ModelAccessRow[] }>('/api/shell/access', {
      fetch,
      target: null,
    })
  ).data;
};
