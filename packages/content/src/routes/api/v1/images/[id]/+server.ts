import '@happyvertical/smrt-assets';
import type { Asset } from '@happyvertical/smrt-assets';
import '@happyvertical/smrt-images';
import type { Image } from '@happyvertical/smrt-images';
import {
  enterTenantContext,
  hasTenantContext,
  isTenancyEnabled,
} from '@happyvertical/smrt-tenancy';
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

function pickMutableImageFields(data: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(data).filter(([key]) => MUTABLE_IMAGE_FIELDS.has(key)),
  );
}

export const GET: RequestHandler = async ({ locals, params }) => {
  establishTenantContext(locals);
  await ensureImageBaseTables();

  const collection = await getCollection<Image>(
    '@happyvertical/smrt-images:Image',
  );
  const readScope = tenantReadScope();
  const item = await collection.get(
    readScope ? { id: params.id, ...readScope } : params.id,
  );
  if (!item) throw error(404, 'Not found');
  return json(item);
};

export const PUT: RequestHandler = async ({ locals, params, request }) => {
  establishTenantContext(locals);
  await ensureImageBaseTables();

  const collection = await getCollection<Image>(
    '@happyvertical/smrt-images:Image',
  );
  const readScope = tenantReadScope();
  const item = await collection.get(
    readScope ? { id: params.id, ...readScope } : params.id,
  );
  if (!item) throw error(404, 'Not found');

  const data = pickMutableImageFields(await request.json());
  Object.assign(item, data);
  await item.save();

  return json(item);
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
  establishTenantContext(locals);
  await ensureImageBaseTables();

  const collection = await getCollection<Image>(
    '@happyvertical/smrt-images:Image',
  );
  const readScope = tenantReadScope();
  const item = await collection.get(
    readScope ? { id: params.id, ...readScope } : params.id,
  );
  if (!item) throw error(404, 'Not found');

  await item.delete();
  return json({ success: true });
};
