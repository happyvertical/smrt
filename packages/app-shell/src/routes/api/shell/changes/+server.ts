/**
 * Changes waiting (#5178): the structural changes the assistant, an import or
 * the API made that the owner has not applied yet. Owner session required;
 * writes are same-origin JSON. Records are always live and never wait.
 *
 * `GET /api/shell/changes` -> ChangesState (`lib/server/changes.ts`):
 *   { batchId, status: 'none'|'open'|'held', count, generation, digest,
 *     checkState, canApply, blockers, overwrites, held, liveVersion,
 *     baseVersion, cards[], discarded, lastApplied }
 *   `count` is the number of ACTIVE cards (the one number to show); `digest`
 *   is Apply's `expect`; `generation` guards two open windows (send it back as
 *   `generation` on a write: a stale one is 409).
 *   `checkState`: `stale` (a change waits for its check), `checking`, `ok`,
 *   `blocked`, `none`. Checks run a couple of seconds after the last change and
 *   the `changes` event follows; Apply re-checks fresh and never trusts them.
 */

import { changesState } from '$lib/server/changes';
import { guarded, json, ownerOf } from '$lib/server/http';
import { runAs } from '$lib/server/owner';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = guarded(async (event) => {
  const owner = await ownerOf(event);
  return json(await runAs(owner, () => changesState()));
});
