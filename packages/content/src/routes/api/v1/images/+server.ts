import { json } from '@sveltejs/kit';
import { seedImages } from '$lib/server/seed-images';
import { getCollection } from '$lib/server/smrt';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
  try {
    await seedImages();

    // Ensure base tables are created before STI queries
    await getCollection<any>('@happyvertical/smrt-assets:Asset');
    await getCollection<any>('@happyvertical/smrt-assets:AssetAssociation');

    const collection = await getCollection<any>(
      '@happyvertical/smrt-images:Image',
    );
    const items = await collection.list({});

    return json({
      items: items,
      meta: { total: items.length },
    });
  } catch (err: any) {
    console.error('GET Images Error:', err);
    return json({ error: err.message, stack: err.stack }, { status: 500 });
  }
};

export const POST: RequestHandler = async ({ request }) => {
  // Ensure base tables are created before STI setup
  await getCollection<any>('@happyvertical/smrt-assets:Asset');
  await getCollection<any>('@happyvertical/smrt-assets:AssetAssociation');

  const collection = await getCollection<any>(
    '@happyvertical/smrt-images:Image',
  );
  const data = await request.json();

  const newItem = await collection.create(data);
  return json(newItem);
};
