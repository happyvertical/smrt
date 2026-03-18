import { json, type RequestHandler } from '@sveltejs/kit';
import { getCollection } from '$lib/server/smrt';

type ContentRouteLocals = {
  tenantId?: string | null;
};

export const GET: RequestHandler = async ({ params, locals }) => {
  const smrtLocals = locals as ContentRouteLocals;
  const { id } = params;

  if (!id) {
    return json({ error: 'Content ID is required' }, { status: 400 });
  }

  try {
    const contentsCollection = await getCollection<any>(
      '@happyvertical/smrt-content:Content',
    );

    // Check tenant scoping manually if standard API doesn't handle natively
    const tenantId = smrtLocals.tenantId || '';

    const content = await contentsCollection.get({ id });

    if (!content) {
      return json({ error: 'Content not found' }, { status: 404 });
    }

    if (content.tenantId && content.tenantId !== tenantId) {
      return json({ error: 'Unauthorized' }, { status: 403 });
    }

    // Also attach references and assets when returning a single content item
    const references = await content.getReferences();
    const assets = await content.getAssets();
    const data = {
      ...content.toJSON(),
      referenceIds: references.map((r: any) => r.id),
      assetIds: assets.map((a: any) => a.id),
      assets: assets.map((a: any) => a.toJSON()),
    };

    return json({ data });
  } catch (err: any) {
    console.error(`Error fetching content ${id}:`, err);
    return json(
      { error: err.message || 'Failed to fetch content' },
      { status: 500 },
    );
  }
};

export const PUT: RequestHandler = async ({ params, request, locals }) => {
  const smrtLocals = locals as ContentRouteLocals;
  const { id } = params;

  if (!id) {
    return json({ error: 'Content ID is required' }, { status: 400 });
  }

  try {
    const contentsCollection = await getCollection<any>(
      '@happyvertical/smrt-content:Content',
    );

    const tenantId = smrtLocals.tenantId || '';

    const content = await contentsCollection.get({ id });
    if (!content) {
      return json({ error: 'Content not found' }, { status: 404 });
    }

    if (content.tenantId && content.tenantId !== tenantId) {
      return json({ error: 'Unauthorized' }, { status: 403 });
    }

    const payload = await request.json();

    // Manage References manually
    const referenceIds = payload.referenceIds;
    delete payload.referenceIds;

    // Manage Assets manually
    const assetIds = payload.assetIds;
    delete payload.assetIds;
    delete payload.assets;

    delete payload.id;
    delete payload._meta_data;
    delete payload._meta_type;

    // Apply payload to content
    for (const key of Object.keys(payload)) {
      if (key !== 'id' && key !== 'tenantId') {
        content[key] = payload[key];
      }
    }
    await content.save();
    const updated = content;

    // Sync references
    if (Array.isArray(referenceIds)) {
      const existingRefs = await updated.getReferences();
      const existingRefIds = existingRefs.map((r: any) => r.id);

      // Add new ones
      for (const refId of referenceIds) {
        if (!existingRefIds.includes(refId)) {
          try {
            const newRef = await contentsCollection.get({ id: refId });
            if (newRef) {
              await updated.addReference(newRef);
            }
          } catch (e) {
            console.error(`Error adding ref ${refId}`, e);
          }
        }
      }

      // Remove omitted ones
      for (const existingId of existingRefIds) {
        if (!referenceIds.includes(existingId)) {
          try {
            await updated.removeReference(existingId);
          } catch (e) {
            console.error(`Error removing ref ${existingId}`, e);
          }
        }
      }
    }

    // Sync assets
    if (Array.isArray(assetIds)) {
      const existingAssets = await updated.getAssets();
      const existingAssetIds = existingAssets.map((a: any) => a.id);
      const assetsCollection = await getCollection<any>(
        '@happyvertical/smrt-assets:Asset',
      );

      // Add new ones
      for (const assetId of assetIds) {
        if (!existingAssetIds.includes(assetId)) {
          try {
            const newAsset = await assetsCollection.get({ id: assetId });
            if (newAsset) {
              await updated.addAsset(newAsset);
            }
          } catch (e) {
            console.error(`Error adding asset ${assetId}`, e);
          }
        }
      }

      // Remove omitted ones
      for (const existingId of existingAssetIds) {
        if (!assetIds.includes(existingId)) {
          try {
            await updated.removeAsset(existingId);
          } catch (e) {
            console.error(`Error removing asset ${existingId}`, e);
          }
        }
      }
    }

    // Re-fetch the content to get a fully hydrated SMRT object
    // (the in-memory object after save() doesn't have full field metadata for toJSON())
    const freshContent = await contentsCollection.get({ id });
    const finalRefs = await freshContent.getReferences();
    const finalAssets = await freshContent.getAssets();
    const data = {
      ...freshContent.toJSON(),
      referenceIds: finalRefs.map((r: any) => r.id),
      assetIds: finalAssets.map((a: any) => a.id),
      assets: finalAssets.map((a: any) => a.toJSON()),
    };

    return json({ data });
  } catch (err: any) {
    console.error(`Error updating content ${id}:`, err);
    return json(
      { error: err.message || 'Failed to update content' },
      { status: 500 },
    );
  }
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
  const smrtLocals = locals as ContentRouteLocals;
  const { id } = params;

  if (!id) {
    return json({ error: 'Content ID is required' }, { status: 400 });
  }

  try {
    const contentsCollection = await getCollection<any>(
      '@happyvertical/smrt-content:Content',
    );
    const tenantId = smrtLocals.tenantId || '';

    const content = await contentsCollection.get({ id });
    if (!content) {
      return json({ error: 'Content not found' }, { status: 404 });
    }

    if (content.tenantId && content.tenantId !== tenantId) {
      return json({ error: 'Unauthorized' }, { status: 403 });
    }

    await contentsCollection.delete(id);

    return json({ success: true, message: `Content ${id} deleted` });
  } catch (err: any) {
    console.error(`Error deleting content ${id}:`, err);
    return json(
      { error: err.message || 'Failed to delete content' },
      { status: 500 },
    );
  }
};
