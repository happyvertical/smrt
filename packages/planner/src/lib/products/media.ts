import type { ModelRecord, RecordWrite } from '../data/source.ts';
import { catalogModels } from '../forms/shared.ts';

/** Canonical records used to attach an image to a product. */
export const ASSET = '@happyvertical/smrt-assets:Asset';
export const PRODUCT_ASSET = '@happyvertical/smrt-products:ProductAsset';
/** The smrt-assets recipe whose library view is the product gallery. */
export const GALLERY_RECIPE = 'assets.library';

export interface ProductImage {
  id: string;
  name: string;
  sourceUri: string;
  mimeType: string;
  description: string;
  sortOrder: number;
}

/** Image rows associated with one product, in the order the product declares. */
export function productImages(
  productId: string,
  assets: readonly ModelRecord[],
  associations: readonly ModelRecord[],
): ProductImage[] {
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  return associations
    .filter((link) => link.productId === productId)
    .flatMap((link) => {
      const asset = byId.get(String(link.assetId));
      const sourceUri = asset?.sourceUri;
      if (!asset || typeof sourceUri !== 'string') return [];
      return [
        {
          id: asset.id,
          name: String(asset.name ?? 'Product image'),
          sourceUri,
          mimeType: String(asset.mimeType ?? 'image/*'),
          description: String(asset.description ?? ''),
          sortOrder: Number(link.sortOrder ?? 0),
        },
      ];
    })
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

/** A single atomic browser-local image selection, stored in canonical records. */
export function planProductImageSave(
  productId: string,
  file: Pick<File, 'name' | 'type'>,
  sourceUri: string,
  sortOrder: number,
): RecordWrite[] {
  return [
    {
      op: 'save',
      as: 'asset',
      model: catalogModels(ASSET),
      values: {
        name: file.name || 'Product image',
        sourceUri,
        mimeType: file.type || 'image/*',
        description: `Image selected for this product in the browser demo.`,
        sourceType: 'browser-demo',
      },
    },
    {
      op: 'save',
      model: catalogModels(PRODUCT_ASSET),
      values: {
        productId,
        assetId: { ref: 'asset' },
        relationship: 'gallery',
        sortOrder,
      },
    },
  ];
}

/** Removing a product removes its browser-demo associations and image rows too. */
export function planProductImageDelete(
  productId: string,
  associations: readonly ModelRecord[],
): RecordWrite[] {
  return associations
    .filter((link) => link.productId === productId)
    .flatMap((link): RecordWrite[] => [
      { op: 'delete', model: catalogModels(PRODUCT_ASSET), id: link.id },
      { op: 'delete', model: catalogModels(ASSET), id: String(link.assetId) },
    ]);
}
