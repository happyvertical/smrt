/**
 * The draft: a test copy of the app to build in while the live app keeps
 * working. Owner session required; writes are same-origin JSON.
 *
 * `GET  /api/shell/draft`
 *   -> { draft: DraftInfo | null, view: 'live' | 'draft' }
 *   DraftInfo = { id, name, status: 'open', baseVersion, version, changes,
 *     createdAt, createdBy, liveVersion, liveFrozen, publishable, problem,
 *     recovery }. `problem` is set (and `publishable` false) when the draft
 *     cannot be published, e.g. the data folder was restored or moved: the UI
 *     says so and offers Discard. `recovery: 'rolled-back'` means a publish
 *     was interrupted by a restart and undone; publish again.
 *   `view` is the owner's saved choice of which copy the content shows (always
 *   'live' when no draft is open).
 * `POST /api/shell/draft` body `{ name?: string }` -> 201 DraftInfo. Freezes
 *   the live app's structure. 409 when a draft is already open.
 */

import { draftInfo, startDraft } from '$lib/server/drafts';
import { guarded, json, ownerOf, readOptionalJson } from '$lib/server/http';
import { readView } from '$lib/server/view';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = guarded(async (event) => {
  const owner = await ownerOf(event);
  return json({ draft: await draftInfo(), view: await readView(owner) });
});

export const POST: RequestHandler = guarded(async (event) => {
  const owner = await ownerOf(event);
  const body = await readOptionalJson(event.request);
  return json(await startDraft(body.name, owner.id), 201);
});
