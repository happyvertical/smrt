/**
 * @happyvertical/smrt-images
 *
 * Image asset management with AI-powered categorization, search,
 * editing, and metadata extraction.
 *
 * @packageDocumentation
 */

// Self-register this package's manifest before any @smrt() decorator fires
// downstream. Must come first so the side effect runs ahead of the class
// module loads below. See __smrt-register__.ts for issue #1132 context.
import './__smrt-register__.js';

// Operations
export { ImageCategorizer } from './categorizer';
export { ImageDeriver } from './deriver';
export { ImageEditor } from './editor';
// Model (moved from smrt-assets)
export { Image } from './image';
export { ImageCollection } from './images';
export {
  type ImageMediaBundleFileDescriptor,
  type ImageMediaBundleGpsTrackPoint,
  type ImageMediaBundleInspection,
  type ImageMediaBundleInspectionLike,
  type ImageMediaBundleNormalizedMetadata,
  type ImageMediaBundleSupportFileInspection,
  type MediaSupportFileVisibility,
  type PersistImageMediaBundleAssetInput,
  type PersistImageMediaBundleAssociationInput,
  type PersistImageMediaBundleInspectionOptions,
  type PersistImageMediaBundleInspectionResult,
  type PersistImageMediaBundleMetadataArtifactInput,
  persistImageMediaBundleInspection,
  type SmrtImageMediaBundlePersistenceAdapter,
} from './media-bundle-persistence';
export { ImageMetadataExtractor } from './metadata';
export { ImageSearch } from './search';
// Types
export type {
  CategoryResult,
  DeriveOptions,
  ImageMetadataResult,
  ImageOptions,
  ImageSearchOptions,
} from './types';
export {
  type AssetSourceAdapter,
  type SourceAsset,
  type SourceAssetMetadata,
  UpstreamManager,
} from './upstream';
