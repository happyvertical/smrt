/**
 * Records of one model of the user app (owner session required).
 *
 * `GET  /api/shell/records/<Model>?limit=200` -> { records: object[] }
 * `POST /api/shell/records/<Model>` body = the record's fields (JSON object)
 *   -> 201 the created record
 * Errors: { error, code? } with 400 (bad data), 404 (no such model/record).
 */

import { getHost } from '$lib/server/host';
import { guarded, ident, json, ownerOf, readJson } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = guarded(async (event) => {
  await ownerOf(event);
  const limit = Math.min(
    1000,
    Math.max(1, Number(event.url.searchParams.get('limit') ?? 200) || 200),
  );
  const host = await getHost();
  return json({
    records: await host.list(ident(event.params.model, 'model'), limit),
  });
});

export const POST: RequestHandler = guarded(async (event) => {
  await ownerOf(event);
  const data = await readJson(event.request);
  const host = await getHost();
  return json(await host.create(ident(event.params.model, 'model'), data), 201);
});
