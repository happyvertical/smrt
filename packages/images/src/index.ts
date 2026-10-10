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

export {
  type AppliedImageAdjustments,
  applyImageAdjustments,
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
// Operations
export { createPhotoCutoutCoordinateGuide } from './photo-cutout-coordinate-guide.js';
export {
  type LoadPhotoCutoutProfileSetupInput,
  type PersistedPhotoCutoutSetup,
  PHOTO_CUTOUT_PERSISTED_ASSET_REF,
  type PhotoCutoutProfileOwner,
  PhotoCutoutProfileStore,
  type PhotoCutoutProfileStoreAuthorization,
  type PhotoCutoutProfileStoreOptions,
  type SavedPhotoCutoutProfileSetup,
  type SavePhotoCutoutProfileSetupInput,
} from './photo-cutout-profile-store.js';
export {
  assembleCanadianSplitRig,
  type FaceOutline,
  faceOutlinePrompt,
  type MouthLandmarks,
  mouthLandmarksPrompt,
  type PhotoCutoutSetupInput,
  parseFaceOutline,
  parseMouthLandmarks,
  parsePhotoCutoutSetup,
  photoCutoutSetupPrompt,
} from './photo-cutout-setup';
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
