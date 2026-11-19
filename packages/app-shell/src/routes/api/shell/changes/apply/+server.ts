/**
 * `POST /api/shell/changes/apply` body `{ expect: string, generation?, source? }`: the
 * owner's own Apply click, in one step. `expect` is required: the `digest` of
 * the ChangesState the owner reviewed. The server re-runs the exact checks and
 * refuses unless they pass and still produce that digest (409, review again);
 * a refusal carries `reason`: `'blocked'` with `blockers` (`[{code, message,
 * cardId?}]`, "Can't apply yet": nothing is applied however the client
 * behaves) or `'changed'` (the digest, a card revision or the generation no
 * longer matches what was reviewed). Overwrite counts are in the digest but
 * never block;
 * then an `apply-batch` Approval is recorded and decided by the same owner at
 * once (`applyOwnBatch`), and the engine publishes exactly that chain or
 * refuses. -> 200 `{ id, status: 'approved', result }`; 400 no `expect`; 404
 * nothing waiting; 409 not applicable (blockers, changed, stale `generation`).
 *
 * `source: 'chat'` (the chat reply's "Apply now") adds one rule: the server
 * re-decides `applyNowEligible` itself from the batch and the fresh check and
 * ignores the claim; a batch that is not eligible is refused 409 `reason:
 * 'review_first'`. It is still this one route and the owner's own click.
 *
 * Owner session cookie and same origin only (`ownerOf`): an agent's MCP token
 * is never a session here. No tool, the assistant, `/mcp` or generated REST
 * can apply.
 */

import { applyOwnBatch } from '$lib/server/approvals';
import { guarded, json, ownerOf, readJson } from '$lib/server/http';
import { runAs } from '$lib/server/owner';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = guarded(async (event) => {
  const owner = await ownerOf(event);
  const body = await readJson(event.request);
  return json(
    await runAs(owner, () =>
      applyOwnBatch(body.expect, {
        generation: body.generation,
        source: body.source,
      }),
    ),
  );
});
