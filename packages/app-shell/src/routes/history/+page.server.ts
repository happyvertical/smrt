import { loadError, ownerOf } from '$lib/server/http';
import { DEPENDS } from '$lib/ui/events';
import { newestFirst } from '$lib/ui/format';
import { load as loadApi, needOwner } from '$lib/ui/load';
import type { VersionInfo } from '$lib/ui/types';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  await ownerOf(event).catch(loadError);
  const { parent, depends, fetch } = event;
  depends(DEPENDS.history);
  const description = needOwner((await parent()).description);
  const { versions } = await loadApi<{ versions: VersionInfo[] }>(
    fetch,
    '/api/shell/history',
    description.mode,
  );
  return { versions: newestFirst(versions) };
};
