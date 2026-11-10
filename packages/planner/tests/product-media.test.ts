import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import ProductMedia from '../src/lib/components/ProductMedia.svelte';
import { createPlannerDataSource } from '../src/lib/data/planner-source.ts';
import { catalogModels } from '../src/lib/forms/shared.ts';
import {
  ASSET,
  GALLERY_RECIPE,
  PRODUCT_ASSET,
  planProductImageDelete,
  planProductImageSave,
  productImages,
} from '../src/lib/products/media.ts';
import { recipeState } from '../src/lib/recipes/state.svelte.ts';

const PRODUCT = '@happyvertical/smrt-products:Product';

describe('product media demo', () => {
  it('seeds deterministic canonical Asset and ProductAsset thumbnails', async () => {
    const source = createPlannerDataSource();
    const [product] = await source.list(catalogModels(PRODUCT));
    const assets = await source.list(catalogModels(ASSET));
    const links = await source.list(catalogModels(PRODUCT_ASSET));
    if (!product) throw new Error('product sample missing');

    expect(productImages(product.id, assets, links)[0]).toMatchObject({
      sourceUri: expect.stringMatching(/^data:image\/svg\+xml,/),
      sortOrder: 0,
    });
  });

  it('writes and removes a selected image through canonical records', async () => {
    const source = createPlannerDataSource();
    const [product] = await source.list(catalogModels(PRODUCT));
    if (!product) throw new Error('product sample missing');
    const file = { name: 'mug.png', type: 'image/png' } as File;

    await source.apply(
      planProductImageSave(product.id, file, 'data:image/png;base64,AA==', 1),
    );
    const assets = await source.list(catalogModels(ASSET));
    const links = await source.list(catalogModels(PRODUCT_ASSET));
    expect(productImages(product.id, assets, links)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'mug.png', sortOrder: 1 }),
      ]),
    );

    await source.apply(planProductImageDelete(product.id, links));
    expect(await source.list(catalogModels(PRODUCT_ASSET))).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ productId: product.id }),
      ]),
    );
  });

  it('shows the canonical asset grid only when the cookbook has the Asset library recipe', () => {
    const product = { id: 'p1', name: 'Loaf' };
    const images = new Map([
      [
        'p1',
        [
          {
            id: 'a1',
            name: 'Loaf photo',
            sourceUri: 'data:image/svg+xml,%3Csvg%2F%3E',
            mimeType: 'image/svg+xml',
            description: '',
            sortOrder: 0,
          },
        ],
      ],
    ]);
    const view = () =>
      render(ProductMedia, {
        props: { rows: [product], images, onselect: () => {} },
      }).body.replace(/<!--.*?-->/g, '');
    try {
      recipeState.clear();
      const off = view();
      expect(off).not.toContain('asset-grid');
      expect(off).toContain('Add image for Loaf');
      expect(off).toMatch(/1\s+image\b/);
      recipeState.add(GALLERY_RECIPE);
      const on = view();
      expect(on).toContain('asset-grid');
      expect(on).toContain('Loaf photo');
      expect(on).toContain('Add image for Loaf');
    } finally {
      recipeState.clear();
    }
  });
});
