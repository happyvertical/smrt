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

// Side-effect import: register prompts at module load time so tenant
// overrides resolve correctly via @happyvertical/smrt-prompts.
import './prompts.js';

// Operations. Services that need sharp, node:fs, or the AI SDK graph
// (ImageEditor, ImageCategorizer, ImageDeriver, ImageMetadataExtractor,
// applyImageAdjustments) are Node-only and ship from
// '@happyvertical/smrt-images/node' so this root stays browser-safe (#3628).
export {
  type AppliedImageAdjustments,
  decodeImageAdjustments,
  describeImageAdjustments,
  encodeImageAdjustments,
  IMAGE_ADJUST_OPERATIONS,
  type ImageAdjustments,
  type ImageAdjustOperation,
  type ImageAdjustOutputFormat,
  type ImageAdjustVariant,
  type ImageFocus,
  type ImageRegion,
  imageAdjustVariants,
  isEmptyImageAdjustments,
  isImageAdjustOperation,
  isImageFocus,
  normalizeImageAdjustments,
  regionForFocus,
  regionToPixels,
} from './adjust';
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
export { smrtImagesGenerateAltTextPrompt } from './prompts';
export { ImageSearch } from './search';
// Types
export type {
  CategorizedImageLabel,
  CategoryResult,
  DeriveOptions,
  DetailedCategoryResult,
  ImageCategorizationDecisionDetail,
  ImageCategorizerOptions,
  ImageLabelVocabulary,
  ImageLabelVocabularyEntry,
  ImageLabelVocabularyResolver,
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
