/**
 * Records of one model of the user app (owner session required). The copy is
 * named by `?target=live|draft` (default `live`): live records keep working
 * while a draft is open, and a draft's records are separate test data.
 *
 * `GET  /api/shell/records/<Model>?limit=200&target=` -> { records: object[] }
 * `POST /api/shell/records/<Model>?target=` body = the record's fields (JSON
 *   object) -> 201 the created record
 * Errors: { error, code? } with 400 (bad data), 404 (no such model/record, or
 * target=draft with no draft open).
 */

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
  const limit = Math.min(
    1000,
    Math.max(1, Number(event.url.searchParams.get('limit') ?? 200) || 200),
  );
  const host = await hostFor(targetOf(event));
  return json({
    records: await host.list(ident(event.params.model, 'model'), limit),
  });
});

export const POST: RequestHandler = guarded(async (event) => {
  await ownerOf(event);
  const data = await readJson(event.request);
  const host = await hostFor(targetOf(event));
  return json(await host.create(ident(event.params.model, 'model'), data), 201);
});
