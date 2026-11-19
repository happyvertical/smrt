/**
 * `POST /api/shell/changes/restore` (no body needed): "Put them back" after a
 * discard. 409 when other changes are waiting; 404 when nothing was discarded.
 * -> ChangesState.
 */

import { restoreDiscardedChanges } from '$lib/server/changes';
import { guarded, json, ownerOf, readOptionalJson } from '$lib/server/http';
import { runAs } from '$lib/server/owner';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = guarded(async (event) => {
  const owner = await ownerOf(event);
  const body = await readOptionalJson(event.request);
  return json(
    await runAs(owner, () =>
      restoreDiscardedChanges({ generation: body.generation }),
    ),
  );
});
