import type { SmrtCollectionOptions } from '@happyvertical/smrt-core';
import { withSystemContext } from '@happyvertical/smrt-tenancy';
import type { Asset } from './asset';
import { AssetCollection } from './assets';

export const OWNED_ASSET_RELATIONSHIP_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export interface AssetOwnerRecord {
  getAssets(relationship?: string): Promise<Asset[]>;
  addAsset(
    asset: Asset,
    relationship?: string,
    sortOrder?: number,
  ): Promise<void>;
  removeAsset(assetId: string, relationship?: string): Promise<void>;
}

export interface AssetOwnerCollection<OwnerType extends AssetOwnerRecord> {
  get(where: { id: string }): Promise<OwnerType | null>;
}

export function assertValidOwnedAssetRelationship(relationship: string): void {
  if (!OWNED_ASSET_RELATIONSHIP_PATTERN.test(relationship)) {
    throw new Error(
      `Invalid relationship type "${relationship}"; must start with a letter or underscore and contain only letters, digits, and underscores`,
    );
  }
}

export function assertValidOwnedAssetSortOrder(sortOrder: number): void {
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 2147483647) {
    throw new Error(
      `Invalid sortOrder "${sortOrder}"; must be a non-negative integer`,
    );
  }
}

export async function resolveOwnedAssetsById(
  db: SmrtCollectionOptions['db'],
  assetIds: string[],
  tenantId?: string | null,
): Promise<Asset[]> {
  if (assetIds.length === 0) {
    return [];
  }

  const assets = await AssetCollection.create({ db });
  const resolved = tenantId
    ? await withSystemContext(async () => assets.listByIds(assetIds))
    : await assets.listByIds(assetIds);
  const visibleAssets = tenantId
    ? resolved.filter(
        (asset) => asset.tenantId === tenantId || asset.tenantId === null,
      )
    : resolved;
  const assetsById = new Map(
    visibleAssets
      .filter((asset) => asset.id)
      .map((asset) => [asset.id as string, asset]),
  );

  return assetIds
    .map((assetId) => assetsById.get(assetId))
    .filter(Boolean) as Asset[];
}

async function getOwnerRecord<OwnerType extends AssetOwnerRecord>(
  collection: AssetOwnerCollection<OwnerType>,
  ownerId: string,
): Promise<OwnerType | null> {
  return collection.get({ id: ownerId });
}

export async function getOwnedAssetsFromCollection<
  OwnerType extends AssetOwnerRecord,
>(
  collection: AssetOwnerCollection<OwnerType>,
  ownerId: string,
  relationship?: string,
): Promise<Asset[]> {
  const owner = await getOwnerRecord(collection, ownerId);
  if (!owner) {
    return [];
  }

  return owner.getAssets(relationship);
}

export async function addOwnedAssetFromCollection<
  OwnerType extends AssetOwnerRecord,
>(
  collection: AssetOwnerCollection<OwnerType>,
  ownerType: string,
  ownerId: string,
  asset: Asset,
  relationship = 'attachment',
  sortOrder = 0,
): Promise<void> {
  const owner = await getOwnerRecord(collection, ownerId);
  if (!owner) {
    throw new Error(`${ownerType} '${ownerId}' not found`);
  }

  await owner.addAsset(asset, relationship, sortOrder);
}

export async function removeOwnedAssetFromCollection<
  OwnerType extends AssetOwnerRecord,
>(
  collection: AssetOwnerCollection<OwnerType>,
  ownerType: string,
  ownerId: string,
  assetId: string,
  relationship?: string,
): Promise<void> {
  const owner = await getOwnerRecord(collection, ownerId);
  if (!owner) {
    throw new Error(`${ownerType} '${ownerId}' not found`);
  }

  await owner.removeAsset(assetId, relationship);
}
