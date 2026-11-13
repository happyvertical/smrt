import { PreferenceAccessError } from '@happyvertical/smrt-preferences';
import { error, json } from '@sveltejs/kit';

import { hasCookbook } from '@happyvertical/smrt-svelte/cookbook/server';
import { saveCookbookEdits } from '$lib/server/cookbook';
import type { RequestHandler } from './$types';

/**
 * Stores the layout and overview edits `CookbookApp` reports after an edit,
 * as the signed-in person's preferences (or the organization default with
 * `?scope=tenant`, which needs the customize permissions). The body is the
 * cookbook the shell holds; only its `layout` and `overviews` are read, and
 * each is validated before it is stored.
 */
export const POST: RequestHandler = async ({ request, locals, url }) => {
  if (!locals.user) error(401, 'Sign in to save your layout.');
  if (!(await hasCookbook())) error(404, 'This project has no cookbook.');
  const scope = url.searchParams.get('scope') === 'tenant' ? 'tenant' : 'user';
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    error(400, 'The body must be the cookbook as JSON.');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    error(400, 'The body must be the cookbook as JSON.');
  }
  let result: Awaited<ReturnType<typeof saveCookbookEdits>>;
  try {
    result = await saveCookbookEdits(body, scope);
  } catch (cause) {
    if (cause instanceof PreferenceAccessError) {
      error(403, 'You may not change these preferences.');
    }
    throw cause;
  }
  if (result.ok) return json(result);
  const status =
    result.reason === 'not_allowed'
      ? 403
      : result.reason === 'conflict'
        ? 409
        : 400;
  return json(result, { status });
};
