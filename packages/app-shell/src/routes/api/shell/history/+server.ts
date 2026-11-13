/**
 * `GET /api/shell/history?target=live|draft` (default `live`)
 * -> { mode, versions: { version, parent, author, summary, createdAt, purged,
 *      current, publish: { draftId, name } | null }[] }   oldest first
 * Live: the versions a published draft created carry `publish` (the same
 * `draftId` and `name` on each), so History can group them as one publish.
 * Draft: only the changes made in the draft; the live version it was copied
 * from is left out.
 */

import { historyFor } from '$lib/server/drafts';
import { guarded, json, ownerOf, targetOf } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = guarded(async (event) => {
  await ownerOf(event);
  const target = targetOf(event);
  return json({ mode: target, versions: await historyFor(target) });
});
