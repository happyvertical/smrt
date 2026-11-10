/**
 * `POST /api/shell/undo` (no body): undo the last change.
 * -> the change result { version, summary, statements, snapshot,
 *    appRestartMs, ... }; 409 when the change was purged by clean up.
 *    Undoing a type change would overwrite newer data with the archived
 *    originals, so that one is an Approval: 202
 *    `{ status: 'pending_approval', approvalId, summary, preview }`.
 */

import { isPending, runCommand } from '$lib/server/builder';
import { guarded, json, ownerOf } from '$lib/server/http';
import { runAs } from '$lib/server/owner';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = guarded(async (event) => {
  const owner = await ownerOf(event);
  const out = await runAs(owner, () => runCommand({ type: 'undo' }, owner.id));
  return isPending(out) ? json(out, 202) : json(out);
});
