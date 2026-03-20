import { json } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { seedImages } from '$lib/server/seed-images';
import { getCollection } from '$lib/server/smrt';
import type { RequestHandler } from './$types';

async function ensureImageBaseTables() {
  await getCollection<any>('@happyvertical/smrt-assets:Asset');
  await getCollection<any>('@happyvertical/smrt-assets:AssetAssociation');
}

export const GET: RequestHandler = async () => {
  try {
    if (dev || env.SMRT_CONTENT_SEED_IMAGES === 'true') {
      await seedImages();
    }

    await ensureImageBaseTables();

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
    return json(
      {
        error: 'Internal server error',
        ...(dev && err?.stack ? { stack: err.stack } : {}),
      },
      { status: 500 },
    );
  }
};

export const POST: RequestHandler = async ({ request }) => {
  await ensureImageBaseTables();

  const collection = await getCollection<any>(
    '@happyvertical/smrt-images:Image',
  );
  const data = await request.json();

  const newItem = await collection.create(data);
  return json(newItem);
};
