/**
 * `POST /api/shell/app/receive` body `{ bundle }`: install a desktop user app
 * (`exportUserApp`, `smrt app export`) as the signed-in owner's app in the
 * hosted PostgreSQL (#5193). Hosted profile only (404 on the desktop).
 *
 * The tenant is the verified owner's (never read from the body); the schema is
 * the host's own for that tenant's app. The tenant's app must never have held
 * content (409 otherwise, nothing is overwritten); a rerun of the same bundle
 * converges (`status: 'already-received'`). -> 200 `{ status, tables, rows,
 * digest, verified: true }` after counts and digests of every table and the
 * version history were compared; 400 a bundle that does not match its own
 * digests; 409 refused. Owner session cookie and same origin only (`ownerOf`).
 * Bodies up to the import ceiling (`IMPORT_MAX_BYTES`).
 */

import { IMPORT_MAX_BYTES } from '$lib/import-limits';
import { guarded, HttpError, json, ownerOf, readJson } from '$lib/server/http';
import { runAs } from '$lib/server/owner';
import { receiveOwnUserApp } from '$lib/server/receive-user-app';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = guarded(async (event) => {
  const owner = await ownerOf(event);
  const body = await readJson(event.request, IMPORT_MAX_BYTES);
  if (!body.bundle || typeof body.bundle !== 'object')
    throw new HttpError(400, 'send { bundle }');
  return json(
    await runAs(owner, () => receiveOwnUserApp(body.bundle as never)),
  );
});
