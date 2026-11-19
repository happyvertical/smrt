/**
 * `POST /api/shell/changes/cards/:id/restore` body `{ generation? }`: restore one waiting
 * change; the rest are rebuilt and re-checked. -> ChangesState. 409 when the
 * changes cannot be edited one by one (an adopted draft) or `generation` is
 * stale; 404 not waiting.
 */

import { restoreChangeCard } from '$lib/server/changes';
import {
  guarded,
  ident,
  json,
  ownerOf,
  readOptionalJson,
} from '$lib/server/http';
import { runAs } from '$lib/server/owner';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = guarded(async (event) => {
  const owner = await ownerOf(event);
  const id = ident(event.params.id, 'change');
  const body = await readOptionalJson(event.request);
  return json(
    await runAs(owner, () =>
      restoreChangeCard(id, { generation: body.generation }),
    ),
  );
});
