/**
 * `POST /api/shell/changes/cards/:id/remove-dependents` body `{ generation? }`:
 * "Remove those too". `:id` is a waiting change that needs one the owner
 * removed (its check code is `depends_on_removed`); that change and every other
 * one that needs the same removed change are removed, then the rest are
 * rebuilt and re-checked. "Put it back" is the existing `.../restore` of the
 * removed change named by the check's `cause`. -> ChangesState. 409 when the
 * change is not waiting on a removed one or `generation` is stale; 404 not
 * waiting. Owner session only; no tool, `/mcp` or assistant reaches it.
 */

import { removeDependentCards } from '$lib/server/changes';
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
      removeDependentCards(id, { generation: body.generation }),
    ),
  );
});
