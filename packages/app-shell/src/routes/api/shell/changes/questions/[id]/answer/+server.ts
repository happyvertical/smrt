/**
 * `POST /api/shell/changes/questions/:id/answer` body `{ choice, generation? }`:
 * the owner clicked a choice of one of the assistant's review questions.
 * `choice` is the INDEX into the question's stored choices; nothing in the
 * body is ever a command. A choice that adds something becomes a NEW change
 * (the owner's click; the digest changes, so Apply asks for a fresh look); one
 * that does not just closes the question. -> ChangesState. 400 bad choice; 404
 * not waiting; 409 already answered, the new change does not fit, or
 * `generation` is stale.
 *
 * Never applies anything, and questions never block Apply. Owner session only.
 */

import { answerReviewQuestion } from '$lib/server/changes';
import { guarded, ident, json, ownerOf, readJson } from '$lib/server/http';
import { runAs } from '$lib/server/owner';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = guarded(async (event) => {
  const owner = await ownerOf(event);
  const id = ident(event.params.id, 'question');
  const body = await readJson(event.request);
  return json(
    await runAs(owner, () =>
      answerReviewQuestion(id, body.choice, { generation: body.generation }),
    ),
  );
});
