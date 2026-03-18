import { json } from '@sveltejs/kit';
import { getCollection } from '$lib/server/smrt';
import { seedContents } from '$lib/server/seed-contents';
import { seedImages } from '$lib/server/seed-images';

export async function GET({ request, locals, url }) {
  try {
    // Ensure base tables are created before STI queries
    await getCollection<any>('@happyvertical/smrt-assets:Asset');
    await getCollection<any>('@happyvertical/smrt-assets:AssetAssociation');
    const contentsCollection = await getCollection<any>(
      '@happyvertical/smrt-content:Content',
    );

    // Seed initial data if empty
    await seedImages();
    await seedContents();

    // Extract listing options from query params
    const limit = parseInt(url.searchParams.get('limit') || '50', 10);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    // Allow basic filtering
    const where: any = {};
    const type = url.searchParams.get('type');
    if (type) where.type = type;

    const status = url.searchParams.get('status');
    if (status) where.status = status;

    const state = url.searchParams.get('state');
    if (state) where.state = state;

    // TODO: Advanced search, sorting

    const items = await contentsCollection.list({
      limit,
      offset,
      where,
      orderBy: 'createdAt DESC',
    });

    return json({
      data: items.map((c) => c.toJSON()),
      count: items.length,
      offset,
      limit,
    });
  } catch (err: any) {
    console.error('Error listing contents:', err);
    return json(
      { error: err.message || 'Failed to list contents' },
      { status: 500 },
    );
  }
}

export async function POST({ request, locals }) {
  try {
    const contentsCollection = await getCollection<any>(
      '@happyvertical/smrt-content:Content',
    );
    const body = await request.json();

    // Use the tenant extracted by SMRT auth hooks
    const tenantId = locals.tenantId || '';

    // Create payload
    const payload = {
      name: body.title || body.name || 'Untitled',
      ...body,
      tenantId,
    };

    // If they passed referenceIds, we'll need to handle them after creation
    const referenceIds = payload.referenceIds || [];
    delete payload.referenceIds;

    // Handle initial asset associations
    const assetIds = payload.assetIds || [];
    delete payload.assetIds;
    delete payload.assets;

    const newContent = await contentsCollection.create(payload);

    // Link references if provided
    if (referenceIds.length > 0) {
      for (const refId of referenceIds) {
        try {
          const ref = await contentsCollection.get({ id: refId });
          if (ref) {
            await newContent.addReference(ref);
          }
        } catch (e) {
          console.error(`Failed to link reference ${refId} on create`, e);
        }
      }
    }

    // Link assets if provided
    if (assetIds.length > 0) {
      const assetsCollection = await getCollection<any>(
        '@happyvertical/smrt-assets:Asset',
      );
      for (const assetId of assetIds) {
        try {
          const asset = await assetsCollection.get({ id: assetId });
          if (asset) {
            await newContent.addAsset(asset);
          }
        } catch (e) {
          console.error(`Failed to link asset ${assetId} on create`, e);
        }
      }
    }

    return json({ data: newContent }, { status: 201 });
  } catch (err: any) {
    console.error('Error creating content:', err);
    return json(
      { error: err.message || 'Failed to create content' },
      { status: 500 },
    );
  }
}
