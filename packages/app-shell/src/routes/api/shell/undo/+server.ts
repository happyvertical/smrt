/**
 * `POST /api/shell/undo` (no body): undo the last change.
 * -> the change result { version, summary, statements, snapshot,
 *    appRestartMs, ... }; 409 when the change was purged by clean up.
 */

import { runCommand } from '$lib/server/builder';
import { guarded, json, ownerOf } from '$lib/server/http';
import { runAs } from '$lib/server/owner';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = guarded(async (event) => {
  const owner = await ownerOf(event);
  return json(await runAs(owner, () => runCommand({ type: 'undo' }, owner.id)));
});
