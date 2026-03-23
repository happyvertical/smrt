import { error, json } from '@sveltejs/kit';
import { getCollection } from '$lib/server/smrt';
import type { RequestHandler } from './$types';

const MUTABLE_IMAGE_FIELDS = new Set([
  'name',
  'sourceUri',
  'mimeType',
  'description',
  'typeSlug',
  'statusSlug',
  'sourceType',
  'externalId',
  'width',
  'height',
  'alt',
]);

async function ensureImageBaseTables() {
  await getCollection<any>('@happyvertical/smrt-assets:Asset');
}

function pickMutableImageFields(data: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(data).filter(([key]) => MUTABLE_IMAGE_FIELDS.has(key)),
  );
}

export const GET: RequestHandler = async ({ params }) => {
  await ensureImageBaseTables();

  const collection = await getCollection<any>(
    '@happyvertical/smrt-images:Image',
  );
  const item = await collection.get(params.id);
  if (!item) throw error(404, 'Not found');
  return json(item);
};

export const PUT: RequestHandler = async ({ params, request }) => {
  await ensureImageBaseTables();

  const collection = await getCollection<any>(
    '@happyvertical/smrt-images:Image',
  );
  const item = await collection.get(params.id);
  if (!item) throw error(404, 'Not found');

  const data = pickMutableImageFields(await request.json());
  Object.assign(item, data);
  await item.save();

  return json(item);
};

export const DELETE: RequestHandler = async ({ params }) => {
  await ensureImageBaseTables();

  const collection = await getCollection<any>(
    '@happyvertical/smrt-images:Image',
  );
  const item = await collection.get(params.id);
  if (!item) throw error(404, 'Not found');

  await item.delete();
  return json({ success: true });
};
