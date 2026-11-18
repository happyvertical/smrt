import { guarded, json, ownerOf } from '$lib/server/http';
import { shellImports } from '$lib/server/import-runtime';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = guarded(async (event) => {
  const owner = await ownerOf(event);
  return json({ import: await (await shellImports()).current(owner) });
});
export const POST: RequestHandler = guarded(async (event) => {
  const owner = await ownerOf(event);
  return json(await (await shellImports()).start(owner, event.request), 202);
});
