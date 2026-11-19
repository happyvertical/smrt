/**
 * `POST /api/shell/changes/undo` body `{ batchId: string, expect: string }`:
 * the owner's Undo of an applied set of changes (`undoOwnBatch`). `expect` is
 * `lastApplied.undoDigest` from `GET /changes`. The applied versions come off;
 * archived values return and records added since stay. The owner's click is
 * the approval. 409 while changes wait ("Apply or discard your N waiting
 * changes first"), when already undone or the app moved on.
 * -> `{ batchId, version, summary }`.
 */

import { undoOwnBatch } from '$lib/server/changes';
import { guarded, json, ownerOf, readJson } from '$lib/server/http';
import { runAs } from '$lib/server/owner';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = guarded(async (event) => {
  const owner = await ownerOf(event);
  const body = await readJson(event.request);
  return json(
    await runAs(owner, () => undoOwnBatch(body.batchId, body.expect)),
  );
});
