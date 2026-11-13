/**
 * `POST /api/shell/undo-to?target=live|draft` body `{ "version": n }`: undo
 * every change after version `n` in one step ("undo this publish": send the
 * version before the publish's first one; `publish` on the History rows says
 * which versions a publish made). Default copy `live`.
 * -> the change result { version, summary, undid, statements,
 *    appRestartMs }; 409 when a version in the span was purged by clean up.
 *    When any undone change converted a field's type it is an Approval: 202
 *    `{ status: 'pending_approval', approvalId, summary, preview }`.
 */

import { isPending, runCommand } from '$lib/server/builder';
import {
  guarded,
  HttpError,
  json,
  ownerOf,
  readJson,
  targetOf,
} from '$lib/server/http';
import { runAs } from '$lib/server/owner';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = guarded(async (event) => {
  const owner = await ownerOf(event);
  const target = targetOf(event);
  const body = await readJson(event.request);
  if (typeof body.version !== 'number' || !Number.isInteger(body.version))
    throw new HttpError(400, '`version` must be a whole number');
  const version = body.version;
  const out = await runAs(owner, () =>
    runCommand({ type: 'undoTo', version }, owner.id, target),
  );
  return isPending(out) ? json(out, 202) : json(out);
});
