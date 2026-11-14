/**
 * `GET /api/shell/describe?target=live|draft`: the app now, as one copy
 * (default `live`).
 * -> { mode: 'live' | 'draft', draft: DraftInfo | null, frozen: boolean,
 *      name, version, recipes: string[], models: { [Model]: { kind, label,
 *      table, className, extends, fields: { [name]: FieldDef }, ownFields,
 *      methods } }, pendingApprovals: number }
 * `mode` is the copy described; `draft` is the open draft (the same object
 * for either copy: a view of live shows the draft strip from it) or null;
 * `frozen` is whether THIS copy's structure is frozen (live, while a draft is
 * open). `target=draft` with no draft open is 404.
 */

import { pendingApprovalCount } from '$lib/server/approvals';
import { describeCopy } from '$lib/server/drafts';
import { guarded, json, ownerOf, targetOf } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = guarded(async (event) => {
  await ownerOf(event);
  return json({
    ...(await describeCopy(targetOf(event))),
    pendingApprovals: await pendingApprovalCount(),
  });
});
