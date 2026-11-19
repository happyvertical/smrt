/**
 * `PATCH /api/shell/changes/cards/:id` body `{ label?, choices?, field?,
 * generation? }`: a quick edit of one waiting change (its label, or the
 * options of a choice field; `field` names which field of a "new model"
 * change). The card's revision goes up and the changes are rebuilt and
 * re-checked. -> ChangesState; 400 nothing to change; 404 not waiting; 409
 * this kind of change cannot be edited or `generation` is stale.
 */

import { editChangeCard } from '$lib/server/changes';
import { guarded, ident, json, ownerOf, readJson } from '$lib/server/http';
import { runAs } from '$lib/server/owner';
import type { RequestHandler } from './$types';

export const PATCH: RequestHandler = guarded(async (event) => {
  const owner = await ownerOf(event);
  const id = ident(event.params.id, 'change');
  const body = await readJson(event.request);
  return json(
    await runAs(owner, () =>
      editChangeCard(
        id,
        {
          label: body.label,
          choices: body.choices,
          field: body.field,
          default: body.default,
        },
        { generation: body.generation },
      ),
    ),
  );
});
