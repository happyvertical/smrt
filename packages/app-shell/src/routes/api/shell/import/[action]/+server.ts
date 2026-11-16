import { guarded, json, ownerOf } from '$lib/server/http';
import { shellImports } from '$lib/server/import-runtime';
import type { RequestHandler } from './$types';
export const POST: RequestHandler = guarded(async (event) => {
  const owner = await ownerOf(event);
  return json(await (await shellImports()).action(owner, event.params.action));
});
