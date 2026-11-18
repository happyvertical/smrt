import { guarded, HttpError, json, ownerOf, readJson } from '$lib/server/http';
import { importSettings } from '$lib/server/import-settings';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = guarded(async (event) =>
  json(await importSettings(await ownerOf(event))),
);
export const POST: RequestHandler = guarded(async (event) => {
  const owner = await ownerOf(event);
  const body = await readJson(event.request);
  if (
    body.maxCells === undefined ||
    Object.keys(body).some((key) => key !== 'maxCells')
  )
    throw new HttpError(
      400,
      'Choose a whole number of cells from 1,000 to 2,000,000.',
    );
  return json(await importSettings(owner, body.maxCells));
});
