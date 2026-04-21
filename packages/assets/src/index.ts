/**
 * @have/assets
 *
 * Asset management system with versioning, metadata, folders, associations,
 * and provider-agnostic storage.
 *
 * @packageDocumentation
 */

// Self-register this package's manifest before any @smrt() decorator fires
// downstream. Must come first so the side effect runs ahead of the class
// module loads below. See __smrt-register__.ts for issue #1132 context.
import './__smrt-register__.js';

// Models
export { Asset } from './asset';
export { AssetAssociation } from './asset-association';
// Collections
export { AssetAssociationCollection } from './asset-associations';
export {
  ASSET_EXTRACTION_STATUS,
  ASSET_METADATA_KEYS,
  ASSET_ROLES,
  type AssetExtractionStatus,
  type AssetMetadataKey,
  type AssetRole,
} from './asset-conventions';
export { AssetMetafield } from './asset-metafield';
export { AssetMetafieldCollection } from './asset-metafields';
// Runtime surface
export {
  AssetRuntime,
  type AssetRuntimeDb,
  type AssetRuntimeLike,
  type AssetRuntimeOptions,
  createAssetRuntime,
  type LinkDerivationOptions,
  type StoreDerivedAssetOptions,
} from './asset-runtime';
// Serving contract
export {
  AssetServeError,
  type ResolvedAssetBytes,
  resolveAssetForServing,
  type ServeAssetOptions,
  serveAsset,
} from './asset-serving';
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
