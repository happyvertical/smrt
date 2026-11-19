/**
 * Records of one model of the user app (owner session required). The copy is
 * named by `?target=live|draft` (default `live`): live records keep working
 * while a draft is open, and a draft's records are separate test data.
 *
 * `GET  /api/shell/records/<Model>?limit=200&target=` -> { records: object[] }
 * `GET  ...?field=<link field>&equals=<id>&limit=` -> { records, total,
 *   truncated }: only the records whose field equals the id (the related
 *   records of a record), `total` counting every match among the first
 *   `FILTER_SCAN_LIMIT` (newest) rows, a lower bound when `truncated`: the
 *   model has more rows than were scanned. `records` are newest first by the
 *   model's main date field (else creation time).
 * `POST /api/shell/records/<Model>?target=` body = the record's fields (JSON
 *   object) -> 201 the created record
 * Errors: { error, code? } with 400 (bad data), 404 (no such model/record, or
 * target=draft with no draft open).
 */

import { hostFor } from '$lib/server/host';
import { guarded, ident, json, ownerOf, readJson } from '$lib/server/http';
import { orderRows } from '$lib/ui/columns';
import { FILTER_SCAN_LIMIT, matchLink } from '$lib/ui/related';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = guarded(async (event) => {
  await ownerOf(event);
  const limit = Math.min(
    1000,
    Math.max(1, Number(event.url.searchParams.get('limit') ?? 200) || 200),
  );
  const host = await hostFor('live');
  const model = ident(event.params.model, 'model');
  const field = event.url.searchParams.get('field');
  if (field !== null) {
    // One row past the limit tells a table of exactly the limit from a longer one.
    const all = await host.list(model, FILTER_SCAN_LIMIT + 1);
    // Newest first by the model's main date, so the page the limit keeps is
    // the latest rows, not the first imported.
    const rows = orderRows(
      host.def.models[model],
      all.slice(0, FILTER_SCAN_LIMIT),
    );
    const hits = matchLink(
      rows,
      ident(field, 'field'),
      ident(event.url.searchParams.get('equals') ?? undefined, 'equals'),
      limit,
    );
    return json({ ...hits, truncated: all.length > FILTER_SCAN_LIMIT });
  }
  return json({ records: await host.list(model, limit) });
});

export const POST: RequestHandler = guarded(async (event) => {
  await ownerOf(event);
  const data = await readJson(event.request);
  const host = await hostFor('live');
  return json(await host.create(ident(event.params.model, 'model'), data), 201);
});
