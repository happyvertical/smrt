/**
 * `POST /api/shell/changes/discard` body `{ generation? }`: throw the waiting
 * changes away now. They are kept so `POST /changes/restore` can put them
 * back; the live app is unchanged and thaws. -> ChangesState.
 */

import { discardChanges } from '$lib/server/changes';
import { guarded, json, ownerOf, readOptionalJson } from '$lib/server/http';
import { runAs } from '$lib/server/owner';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = guarded(async (event) => {
  const owner = await ownerOf(event);
  const body = await readOptionalJson(event.request);
  return json(
    await runAs(owner, () => discardChanges({ generation: body.generation })),
  );
});
