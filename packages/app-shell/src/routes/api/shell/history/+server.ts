/**
 * `GET /api/shell/history`
 * -> { versions: { version, parent, author, summary, createdAt, purged,
 *      current }[] }   oldest first
 */

import { getHost } from '$lib/server/host';
import { guarded, json, ownerOf } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = guarded(async (event) => {
  await ownerOf(event);
  return json({ versions: await (await getHost()).versions() });
});
