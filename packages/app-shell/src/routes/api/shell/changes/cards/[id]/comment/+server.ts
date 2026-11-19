/**
 * `POST /api/shell/changes/cards/:id/comment` body `{ text }`: the owner's
 * comment on ONE waiting change. It runs an assistant turn scoped to that
 * change (the `change_revise` tool and read tools only), which may replace
 * that change's command in place (its revision goes up and the changes are
 * re-checked), and the answer is shown on the card. The turn runs to its end
 * before the response: -> ChangesState (the card's `comments` hold the thread).
 * 400 no text; 404 not waiting; 409 not editable, already being worked on, or
 * another assistant turn is running; 503 no assistant connected.
 *
 * The comment never applies anything: Apply stays the owner's own click on
 * `POST /api/shell/changes/apply`. Owner session only; no tool, `/mcp` or the
 * assistant reaches this route.
 */

import { assistantRoutes } from '$lib/server/assistant';
import { guarded, ident, ownerOf, readJson } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = guarded(async (event) => {
  const owner = await ownerOf(event);
  const id = ident(event.params.id, 'change');
  const body = await readJson(event.request);
  return assistantRoutes.comment(event as never, owner, {
    cardId: id,
    text: body.text,
  });
});
