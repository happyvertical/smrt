import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getCollection } from '$lib/server/smrt';

export const GET: RequestHandler = async ({ params }) => {
  // Ensure base tables are created before STI queries
  await getCollection<any>('@happyvertical/smrt-assets:Asset');
  await getCollection<any>('@happyvertical/smrt-assets:AssetAssociation');

  const collection = await getCollection<any>(
    '@happyvertical/smrt-images:Image',
  );
  const item = await collection.get(params.id);
  if (!item) throw error(404, 'Not found');
  return json(item);
};

export const PUT: RequestHandler = async ({ params, request }) => {
  const collection = await getCollection<any>(
    '@happyvertical/smrt-images:Image',
  );
  const item = await collection.get(params.id);
  if (!item) throw error(404, 'Not found');

  const data = await request.json();
  Object.assign(item, data);
  await item.save();

  return json(item);
};

export const DELETE: RequestHandler = async ({ params }) => {
  const collection = await getCollection<any>(
    '@happyvertical/smrt-images:Image',
  );
  const item = await collection.get(params.id);
  if (!item) throw error(404, 'Not found');

  await item.delete();
  return json({ success: true });
};
