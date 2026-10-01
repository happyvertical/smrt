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

/**
 * Refuse to link an asset to an owner (place, profile, …) of another tenant.
 *
 * The asset's tenant is read from STORAGE by id under system context, never
 * taken from the caller's object: `new Asset({ id: foreignId })` or a stale
 * copy carries no (or the wrong) tenant and would otherwise pass. Rules:
 *
 * - a tenant owner may link its own assets and global (tenantless) ones;
 * - a global owner may link only global assets — a tenant's asset linked to
 *   a global owner would be listed to every tenant through the global link;
 * - an asset id with no stored row is refused.
 *
 * @param ownerLabel - plain noun for the error ("place", "profile")
 */
export async function assertAssetLinkable(
  db: SmrtCollectionOptions['db'],
  assetId: string,
  ownerTenantId: string | null | undefined,
  ownerLabel: string,
): Promise<void> {
  const assets = await AssetCollection.create({ db });
  const [stored] = await withSystemContext(async () =>
    assets.listByIds([assetId]),
  );
  if (!stored) {
    throw new Error(`Cannot associate asset ${assetId}: it does not exist`);
  }
  const assetTenant = stored.tenantId ? String(stored.tenantId) : null;
  const ownerTenant = ownerTenantId ? String(ownerTenantId) : null;
  if (assetTenant === null || assetTenant === ownerTenant) return;
  throw new Error(
    ownerTenant === null
      ? `Cannot associate a tenant's asset with a shared ${ownerLabel}`
      : `Cannot associate an asset from another tenant with this ${ownerLabel}`,
  );
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
