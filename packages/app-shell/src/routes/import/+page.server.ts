import { api } from '$lib/ui/api';
import type { ImportState } from '$lib/ui/import';
import { needOwner } from '$lib/ui/load';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = async ({ parent, fetch }) => {
  needOwner((await parent()).description);
  return {
    current: (
      await api<{ import: ImportState | null }>('/api/shell/import', { fetch })
    ).data.import,
  };
};
