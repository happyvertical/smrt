import { createLogger } from '@happyvertical/logger';
import type { Asset } from '@happyvertical/smrt-assets';
import type { Image } from '@happyvertical/smrt-images';
import { json } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { seedImages } from '$lib/server/seed-images';
import { getCollection } from '$lib/server/smrt';
import type { RequestHandler } from './$types';

const logger = createLogger({ level: 'info' });

async function ensureImageBaseTables() {
  await getCollection<Asset>('@happyvertical/smrt-assets:Asset');
}

export const GET: RequestHandler = async () => {
  try {
    if (dev || env.SMRT_CONTENT_SEED_IMAGES === 'true') {
      await seedImages();
    }

    await ensureImageBaseTables();

    const collection = await getCollection<Image>(
      '@happyvertical/smrt-images:Image',
    );
    const items = await collection.list({});

    return json({
      items: items,
      meta: { total: items.length },
    });
  } catch (err) {
    logger.error('GET Images Error', { error: err });
    const stack = err instanceof Error ? err.stack : undefined;
    return json(
      {
        error: 'Internal server error',
        ...(dev && stack ? { stack } : {}),
      },
      { status: 500 },
    );
  }
};

export const POST: RequestHandler = async ({ request }) => {
  await ensureImageBaseTables();

  const collection = await getCollection<Image>(
    '@happyvertical/smrt-images:Image',
  );
  const data: Record<string, unknown> = await request.json();

  const newItem = await collection.create(data);
  return json(newItem);
};
