import { createLogger } from '@happyvertical/logger';
import '@happyvertical/smrt-assets';
import type { Asset } from '@happyvertical/smrt-assets';
import '@happyvertical/smrt-images';
import type { Image } from '@happyvertical/smrt-images';
import {
  enterTenantContext,
  hasTenantContext,
  isTenancyEnabled,
} from '@happyvertical/smrt-tenancy';
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

function establishTenantContext(locals: unknown): void {
  if (hasTenantContext()) return;
  if (!locals || typeof locals !== 'object') return;
  const l = locals as Record<string, unknown>;
  const user = l.user as Record<string, unknown> | undefined;
  const session = l.session as Record<string, unknown> | undefined;
  const tenantId = l.tenantId ?? user?.tenantId ?? session?.tenantId;
  if (typeof tenantId === 'string' && tenantId) {
    enterTenantContext({ tenantId });
  }
}

function tenantReadScope(): { tenantId: null } | undefined {
  return isTenancyEnabled() && !hasTenantContext()
    ? { tenantId: null }
    : undefined;
}

export const GET: RequestHandler = async ({ locals }) => {
  try {
    establishTenantContext(locals);
    if (dev || env.SMRT_CONTENT_SEED_IMAGES === 'true') {
      await seedImages();
    }

    await ensureImageBaseTables();

    const collection = await getCollection<Image>(
      '@happyvertical/smrt-images:Image',
    );
    const readScope = tenantReadScope();
    const items = await collection.list(readScope ? { where: readScope } : {});

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

export const POST: RequestHandler = async ({ locals, request }) => {
  establishTenantContext(locals);
  await ensureImageBaseTables();

  const collection = await getCollection<Image>(
    '@happyvertical/smrt-images:Image',
  );
  const data: Record<string, unknown> = await request.json();

  const newItem = await collection.create(data);
  return json(newItem);
};
