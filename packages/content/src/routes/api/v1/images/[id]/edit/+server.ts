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

// Mock AI Variation
export const POST: RequestHandler = async ({ locals, params, request }) => {
  establishTenantContext(locals);
  await getCollection<Asset>('@happyvertical/smrt-assets:Asset');
  const collection = await getCollection<Image>(
    '@happyvertical/smrt-images:Image',
  );
  const readScope = tenantReadScope();
  const image = await collection.get(
    readScope ? { id: params.id, ...readScope } : params.id,
  );

  if (!image) throw error(404, 'Image not found');

  const { prompt } = await request.json();

  if (!prompt) throw error(400, 'Prompt is required for variation');

  // Instead of actually calling OpenAI, we create a dummy "AI Generated" variation
  // using an Unsplash placeholder so the developer can verify the UI flow.
  const newImage = await collection.create({
    name: `${image.name}-variation`,
    sourceUri: `https://images.unsplash.com/photo-1542281286-9e0a16bb7366?auto=format&fit=crop&w=1000&q=80`, // placeholder variation image
    mimeType: 'image/jpeg',
    width: image.width,
    height: image.height,
    alt: `Variant of ${image.name}: ${prompt}`,
    sourceAssetId: image.id,
    description: `AI Edited: ${prompt}`,
    typeSlug: 'image',
  });

  // Return the created variation matching what ImageUploader expects
  return json({ image: newImage });
};
