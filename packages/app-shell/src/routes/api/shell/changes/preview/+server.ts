/**
 * `GET /api/shell/changes/preview`: what Apply would do, from a rehearsal on a
 * copy of the CURRENT live data (live is only read): the SQL, every method's
 * code, definition diff and archive counts. -> `{ changes: ChangesState,
 * preview }`; 404 nothing waiting.
 */

import { previewChanges } from '$lib/server/changes';
import { guarded, json, ownerOf } from '$lib/server/http';
import { runAs } from '$lib/server/owner';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = guarded(async (event) => {
  const owner = await ownerOf(event);
  return json(await runAs(owner, () => previewChanges()));
});
