/**
 * `POST /api/shell/app/receive` body `{ bundle }`: install a desktop user app
 * (`exportUserApp`, `smrt app export`) as the owner's app in the hosted
 * PostgreSQL (#5193). Hosted profile only (404 on the desktop).
 *
 * Two ways in, never mixed:
 * - the owner's session cookie, same origin (the browser); or
 * - `Authorization: Bearer <link token>` (the CLI, #5638): a token the owner
 *   minted at `POST /api/shell/app/receive-link`, scoped to this one action in
 *   the minter's own tenant, short-lived and spent by its first use. With the
 *   header present the cookie is ignored; any refusal of the token is the same
 *   401. No query string is accepted, so a token never rides in a URL.
 *
 * The tenant is the verified owner's (never read from the body); the schema is
 * the host's own for that tenant's app. The tenant's app must never have held
 * content (409 otherwise, nothing is overwritten); a rerun of the same bundle
 * converges (`status: 'already-received'`). -> 200 `{ status, tables, rows,
 * digest, verified: true }` after counts and digests of every table and the
 * version history were compared; 400 a bundle that does not match its own
 * digests; 409 refused. Bodies up to the import ceiling (`IMPORT_MAX_BYTES`).
 */

import { IMPORT_MAX_BYTES } from '$lib/import-limits';
import { guarded, HttpError, json, ownerOf, readJson } from '$lib/server/http';
import { PolicyError, runAs } from '$lib/server/owner';
import {
  ownerOfReceiveLink,
  RECEIVE_LINK_INVALID,
  spendReceiveLink,
  verifyReceiveLink,
} from '$lib/server/receive-link';
import { receiveOwnUserApp } from '$lib/server/receive-user-app';
import type { RequestHandler } from './$types';

const BEARER = /^Bearer ([^\s]+)$/;

export const POST: RequestHandler = guarded(async (event) => {
  const header = event.request.headers.get('authorization');
  if (header !== null) {
    if (event.url.search) throw new HttpError(400, 'no query string');
    const presented = BEARER.exec(header)?.[1];
    const link = presented ? await verifyReceiveLink(presented) : null;
    if (!link) throw new PolicyError(401, RECEIVE_LINK_INVALID);
    const body = await readJson(event.request, IMPORT_MAX_BYTES);
    if (!body.bundle || typeof body.bundle !== 'object')
      throw new HttpError(400, 'send { bundle }');
    // Spent before anything runs: one token, one receive.
    if (!(await spendReceiveLink(link)))
      throw new PolicyError(401, RECEIVE_LINK_INVALID);
    const owner = await ownerOfReceiveLink(link);
    return json(
      await runAs(owner, () => receiveOwnUserApp(body.bundle as never)),
    );
  }
  const owner = await ownerOf(event);
  const body = await readJson(event.request, IMPORT_MAX_BYTES);
  if (!body.bundle || typeof body.bundle !== 'object')
    throw new HttpError(400, 'send { bundle }');
  return json(
    await runAs(owner, () => receiveOwnUserApp(body.bundle as never)),
  );
});
