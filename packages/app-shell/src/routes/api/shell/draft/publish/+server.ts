/**
 * `POST /api/shell/draft/publish` body `{ expect?: string }`: ask to publish
 * the open draft. NEVER applies directly: it creates an Approval pinned to
 * the digest of a preview taken now and answers 202
 * `{ status: 'pending_approval', approvalId, summary, preview }` (the
 * Approval's `preview` is the whole publish preview; its `action` is
 * `{ kind: 'publish-draft', draftId, draftName, digest }`). The owner decides
 * it like any Approval (`POST /api/shell/approvals/<id>`); approving applies
 * exactly the reviewed chain and refuses if the draft changed since.
 * `expect` is the digest of the preview the person reviewed; a draft that
 * changed since is 409 ("review it again").
 */

import { requestPublish } from '$lib/server/drafts';
import { guarded, json, ownerOf, readOptionalJson } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = guarded(async (event) => {
  const owner = await ownerOf(event);
  const body = await readOptionalJson(event.request);
  return json(await requestPublish(body.expect, owner.id), 202);
});
