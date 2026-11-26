/**
 * `POST /api/shell/app/receive-link` body `{ ttlSeconds? }`: the signed-in owner
 * mints a link token for the CLI's `POST /api/shell/app/receive` (#5638).
 * Hosted profile only. -> 200 `{ token, expiresAt, scope: 'app.receive' }`: the
 * token is shown this once, is valid for ONE receive into the owner's own
 * tenant, and dies at `expiresAt` (10 minutes by default, 15 at most). A new
 * token revokes the earlier unspent one. Owner session cookie and same origin
 * only; a link token cannot mint another.
 */

import {
  guarded,
  HttpError,
  json,
  ownerOf,
  readOptionalJson,
} from '$lib/server/http';
import { runAs } from '$lib/server/owner';
import {
  mintReceiveLink,
  RECEIVE_LINK_DEFAULT_TTL_SECONDS,
} from '$lib/server/receive-link';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = guarded(async (event) => {
  const owner = await ownerOf(event);
  const body = await readOptionalJson(event.request);
  const ttl = body.ttlSeconds;
  if (ttl !== undefined && typeof ttl !== 'number')
    throw new HttpError(400, 'ttlSeconds must be a number');
  return json(
    await runAs(owner, () =>
      mintReceiveLink(ttl ?? RECEIVE_LINK_DEFAULT_TTL_SECONDS),
    ),
    200,
    { pragma: 'no-cache' },
  );
});
