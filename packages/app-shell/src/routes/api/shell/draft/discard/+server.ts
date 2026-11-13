/**
 * `POST /api/shell/draft/discard` body `{ draftId?: string }`: throw the open
 * draft away NOW. This is the owner's direct action from the UI (the UI asks
 * "Discard this draft?" first); the same act asked by a tool is an Approval
 * (`app_discarddraft`). The live app is not changed and thaws.
 * -> { discarded: <draft name> }; 404 no draft; 409 when `draftId` is not the
 * open draft. Also the way out of a draft that cannot be published.
 */

import { discardNow } from '$lib/server/drafts';
import { guarded, json, ownerOf, readOptionalJson } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = guarded(async (event) => {
  await ownerOf(event);
  const body = await readOptionalJson(event.request);
  return json(
    await discardNow(
      typeof body.draftId === 'string' ? body.draftId : undefined,
    ),
  );
});
