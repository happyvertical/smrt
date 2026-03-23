/**
 * @have/assets
 *
 * Asset management system with versioning, metadata, folders, associations,
 * and provider-agnostic storage.
 *
 * @packageDocumentation
 */

// Models
export { Asset } from './asset';
export { AssetAssociation } from './asset-association';
// Collections
export { AssetAssociationCollection } from './asset-associations';
export { AssetMetafield } from './asset-metafield';
export { AssetMetafieldCollection } from './asset-metafields';
export { AssetStatus } from './asset-status';
export { AssetStatusCollection } from './asset-statuses';
// Utilities
export {
  AssetStore,
  type ProviderOptions,
  type StoreOptions,
} from './asset-store';
export { AssetType } from './asset-type';
export { AssetTypeCollection } from './asset-types';
export { AssetCollection } from './assets';
export { Folder } from './folder';
export { FolderCollection } from './folders';
export {
  type AssetOwnerCollection,
  type AssetOwnerRecord,
  addOwnedAssetFromCollection,
  assertValidOwnedAssetRelationship,
  assertValidOwnedAssetSortOrder,
  createOwnedAssetLink,
  deleteOwnedAssetLinks,
  getOwnedAssetsFromCollection,
  listOwnedAssetLinks,
  OWNED_ASSET_RELATIONSHIP_PATTERN,
  removeOwnedAssetFromCollection,
  resolveOwnedAssetsById,
} from './owned-asset-helpers';

// Export types
export type {
  AssetAssociationOptions,
  AssetMetafieldOptions,
  AssetOptions,
  AssetStatusOptions,
  AssetTypeOptions,
  FolderOptions,
} from './types';
