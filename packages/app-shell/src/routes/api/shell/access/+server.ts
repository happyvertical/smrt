/**
 * Owner only: what staff may do with each model (#5197). Closed unless granted.
 *
 * `GET /api/shell/access`
 * -> { models: { model, label, grantable, read, create, update }[] }
 * `PUT /api/shell/access` { model, action: 'read'|'create'|'update', allowed }
 * -> the same list after the change. `create` and `update` need `read` first
 * (409 otherwise); taking `read` back takes them with it; `delete` and method
 * actions are never grantable (409); an unknown model is 404.
 */
import { accessOverview, setAccess } from '$lib/server/access-settings';
import { guarded, HttpError, json, ownerOf, readJson } from '$lib/server/http';
import { runAs } from '$lib/server/owner';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = guarded(async (event) => {
  const owner = await ownerOf(event);
  return json({ models: await runAs(owner, () => accessOverview()) });
});

export const PUT: RequestHandler = guarded(async (event) => {
  const owner = await ownerOf(event);
  const body = await readJson(event.request);
  if (
    typeof body.model !== 'string' ||
    typeof body.action !== 'string' ||
    typeof body.allowed !== 'boolean' ||
    Object.keys(body).some((k) => !['model', 'action', 'allowed'].includes(k))
  )
    throw new HttpError(400, 'send { model, action, allowed }');
  const { model, action, allowed } = body;
  return json({
    models: await runAs(owner, () => setAccess(model, action, allowed)),
  });
});
