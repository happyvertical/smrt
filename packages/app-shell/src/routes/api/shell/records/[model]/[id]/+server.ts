/**
 * One record (owner session required). The copy is named by
 * `?target=live|draft` (default `live`).
 *
 * `GET    /api/shell/records/<Model>/<id>` -> the record
 * `PUT    /api/shell/records/<Model>/<id>` body = changed fields -> the record
 * `DELETE /api/shell/records/<Model>/<id>`
 *   live:  does NOT delete: it creates an Approval and answers 202
 *          { status: 'pending_approval', approvalId, summary, preview }. The
 *          record goes only when the owner approves.
 *   draft: deletes at once (a draft's records are throw-away test data) and
 *          answers 200 { deleted: id }.
 */

import { isPending, requestRecordDelete } from '$lib/server/builder';
import { hostFor } from '$lib/server/host';
import {
  guarded,
  ident,
  json,
  ownerOf,
  readJson,
  targetOf,
} from '$lib/server/http';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = guarded(async (event) => {
  await ownerOf(event);
  const host = await hostFor(targetOf(event));
  return json(
    await host.get(
      ident(event.params.model, 'model'),
      ident(event.params.id, 'id'),
    ),
  );
});

export const PUT: RequestHandler = guarded(async (event) => {
  await ownerOf(event);
  const data = await readJson(event.request);
  const host = await hostFor(targetOf(event));
  return json(
    await host.update(
      ident(event.params.model, 'model'),
      ident(event.params.id, 'id'),
      data,
    ),
  );
});

export const DELETE: RequestHandler = guarded(async (event) => {
  const owner = await ownerOf(event);
  const out = await requestRecordDelete(
    ident(event.params.model, 'model'),
    ident(event.params.id, 'id'),
    owner.id,
    targetOf(event),
  );
  return isPending(out) ? json(out, 202) : json(out);
});
