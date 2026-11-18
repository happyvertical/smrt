/**
 * `POST /api/shell/draft/publish` body `{ expect: string }`: the owner's own
 * Publish click on the review page publishes the open draft in one step.
 * `expect` is required: the `digest` of the preview the owner reviewed
 * (`POST /api/shell/draft/preview`). The server takes a fresh preview and
 * refuses unless its digest matches (409, review it again); then the publish
 * Approval (`{ kind: 'publish-draft', draftId, draftName, digest }`) is
 * recorded and decided by the same owner at once (`publishOwnDraft`), and the
 * engine applies exactly that chain or refuses.
 * -> 200 `{ id, status: 'approved', result }`; 400 no `expect`; 404 no draft;
 * 409 the draft changed (review it again) or the publish failed.
 *
 * Owner session cookie and same origin only (`ownerOf`): an agent's MCP
 * token is never a session here. Tools, the assistant and the generated
 * `/api/apps/publishDraft` still only ask (`App.publishDraft`, a pending
 * Approval the owner decides).
 */

import { publishOwnDraft } from '$lib/server/approvals';
import { guarded, json, ownerOf, readJson } from '$lib/server/http';
import { runAs } from '$lib/server/owner';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = guarded(async (event) => {
  const owner = await ownerOf(event);
  const body = await readJson(event.request);
  return json(await runAs(owner, () => publishOwnDraft(body.expect)));
});
