/**
 * One record (owner session required).
 *
 * `GET    /api/shell/records/<Model>/<id>` -> the record
 * `PUT    /api/shell/records/<Model>/<id>` body = changed fields -> the record
 * `DELETE /api/shell/records/<Model>/<id>` does NOT delete: it creates an
 *   Approval and answers 202 { status: 'pending_approval', approvalId,
 *   summary, preview }. The record goes only when the owner approves.
 */

import { requestRecordDelete } from '$lib/server/builder';
import { getHost } from '$lib/server/host';
import { guarded, ident, json, ownerOf, readJson } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = guarded(async (event) => {
  await ownerOf(event);
  const host = await getHost();
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
  const host = await getHost();
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
  return json(
    await requestRecordDelete(
      ident(event.params.model, 'model'),
      ident(event.params.id, 'id'),
      owner.id,
    ),
    202,
  );
});
