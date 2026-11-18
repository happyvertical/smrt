import { api } from '$lib/ui/api';
import { needOwner } from '$lib/ui/load';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = async ({ parent, fetch }) => {
  needOwner((await parent()).description);
  return (
    await api<{ maxCells: number }>('/api/shell/import/settings', { fetch })
  ).data;
};
