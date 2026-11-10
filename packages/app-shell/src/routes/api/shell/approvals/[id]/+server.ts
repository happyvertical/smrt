/**
 * `POST /api/shell/approvals/<id>` body `{ "approve": true | false }`: the
 * owner decides. Approve applies the change; deny only records. Goes through
 * `Approval.decide`, the only place the engine's `approved` flag is set.
 * -> { id, status: 'approved' | 'denied' | 'failed', result?, error? }
 * 404 unknown id, 409 already decided.
 */

import { ApprovalCollection } from '$lib/objects/Approval';
import { getShellDb } from '$lib/server/host';
import {
  guarded,
  HttpError,
  ident,
  json,
  ownerOf,
  readJson,
} from '$lib/server/http';
import { runAs } from '$lib/server/owner';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = guarded(async (event) => {
  const owner = await ownerOf(event);
  const id = ident(event.params.id, 'id');
  const body = await readJson(event.request);
  if (typeof body.approve !== 'boolean')
    throw new HttpError(400, '`approve` must be true or false');
  const approval = await (
    await ApprovalCollection.create({ db: await getShellDb() })
  ).get(id);
  if (!approval) throw new HttpError(404, 'approval not found');
  if (approval.status !== 'pending')
    throw new HttpError(409, `approval is already ${approval.status}`);
  return json(
    await runAs(owner, () => approval.decide(body.approve as boolean)),
  );
});
