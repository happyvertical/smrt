/**
 * `GET /api/shell/limit-notices`: what refused someone's request lately (a cap
 * of the app, the plan's request cap, a route limit), newest first. Owner only.
 * -> { notices: [{ kind: 'cap' | 'route' | 'period', cap?, message, count, lastAt }] }
 * `DELETE` (no body): the owner has seen them. -> { notices: [] }
 */

import { shellProfile } from '$lib/server/host';
import { guarded, json, ownerOf } from '$lib/server/http';
import {
  dismissLimitNotices,
  readLimitNotices,
} from '$lib/server/limit-notices';
import type { RequestHandler } from './$types';

async function keyOf(tenantId: string): Promise<string | null> {
  return (await shellProfile()) === 'cloud' ? tenantId : null;
}

export const GET: RequestHandler = guarded(async (event) => {
  const owner = await ownerOf(event);
  return json({ notices: readLimitNotices(await keyOf(owner.tenantId)) });
});

export const DELETE: RequestHandler = guarded(async (event) => {
  const owner = await ownerOf(event);
  dismissLimitNotices(await keyOf(owner.tenantId));
  return json({ notices: [] });
});
