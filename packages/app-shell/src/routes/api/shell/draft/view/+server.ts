/**
 * The owner's view choice: which copy the content shows while a draft is open.
 * Saved per owner. It is what the SERVER uses when it must choose a copy for
 * the owner (the assistant's record tools); every request from the UI still
 * names its copy with `target`.
 *
 * `GET /api/shell/draft/view` -> { view: 'live' | 'draft' } ('live' whenever
 *   no draft is open)
 * `PUT /api/shell/draft/view` body `{ view: 'live' | 'draft' }` -> { view }.
 *   'draft' with no usable draft open is 409.
 */

import { guarded, json, ownerOf, readJson } from '$lib/server/http';
import { readView, writeView } from '$lib/server/view';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = guarded(async (event) => {
  const owner = await ownerOf(event);
  return json({ view: await readView(owner) });
});

export const PUT: RequestHandler = guarded(async (event) => {
  const owner = await ownerOf(event);
  const body = await readJson(event.request);
  return json({ view: await writeView(owner, body.view) });
});
