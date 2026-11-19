/**
 * `POST /api/shell/changes/apply` body `{ expect: string, generation? }`: the
 * owner's own Apply click, in one step. `expect` is required: the `digest` of
 * the ChangesState the owner reviewed. The server re-runs the exact checks and
 * refuses unless they pass and still produce that digest (409, review again);
 * then an `apply-batch` Approval is recorded and decided by the same owner at
 * once (`applyOwnBatch`), and the engine publishes exactly that chain or
 * refuses. -> 200 `{ id, status: 'approved', result }`; 400 no `expect`; 404
 * nothing waiting; 409 not applicable (blockers, changed, stale `generation`).
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
      applyOwnBatch(body.expect, { generation: body.generation }),
    ),
  );
});
