/**
 * `GET /api/shell/describe`: the app now.
 * -> { name, version, recipes: string[], models: { [Model]: { kind, label,
 *      table, className, extends, fields: { [name]: FieldDef }, ownFields,
 *      methods } }, pendingApprovals: number }
 */

import { pendingApprovalCount } from '$lib/server/approvals';
import { getHost } from '$lib/server/host';
import { guarded, json, ownerOf } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = guarded(async (event) => {
  await ownerOf(event);
  const host = await getHost();
  return json({
    ...host.describe(),
    pendingApprovals: await pendingApprovalCount(),
  });
});
