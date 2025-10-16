/**
 * @have/assets
 *
 * Asset management system with versioning, metadata, and AI-powered operations
 *
 * @packageDocumentation
 */

// Export models
export { AssetType } from './asset-type';
export { AssetStatus } from './asset-status';
export { AssetMetafield } from './asset-metafield';
export { Asset } from './asset';

// Export collections
export { AssetTypeCollection } from './asset-types';
export { AssetStatusCollection } from './asset-statuses';
export { AssetMetafieldCollection } from './asset-metafields';
export { AssetCollection } from './assets';

// Export types
export type {
  AssetTypeOptions,
  AssetStatusOptions,
  AssetMetafieldOptions,
  AssetOptions,
} from './types';
