import type {
  MediaBundleFileDescriptor,
  MediaBundleGpsTrackPoint,
  MediaBundleInspection,
  MediaBundleInspectionLike,
  MediaBundleNormalizedMetadata,
  MediaBundleSupportFileInspection,
  PersistMediaBundleAssetInput,
  PersistMediaBundleAssociationInput,
  PersistMediaBundleInspectionOptions,
  PersistMediaBundleInspectionResult,
  PersistMediaBundleMetadataArtifactInput,
  SmrtMediaBundlePersistenceAdapter,
} from '@happyvertical/smrt-assets';

export {
  type MediaSupportFileVisibility,
  persistMediaBundleInspection as persistImageMediaBundleInspection,
} from '@happyvertical/smrt-assets';

export type ImageMediaBundleFileDescriptor = MediaBundleFileDescriptor;
export type ImageMediaBundleGpsTrackPoint = MediaBundleGpsTrackPoint;
export type ImageMediaBundleInspection = MediaBundleInspection;
export type ImageMediaBundleInspectionLike = MediaBundleInspectionLike;
export type ImageMediaBundleNormalizedMetadata = MediaBundleNormalizedMetadata;
export type ImageMediaBundleSupportFileInspection =
  MediaBundleSupportFileInspection;
export type PersistImageMediaBundleAssetInput = PersistMediaBundleAssetInput;
export type PersistImageMediaBundleAssociationInput =
  PersistMediaBundleAssociationInput;
export type PersistImageMediaBundleInspectionOptions =
  PersistMediaBundleInspectionOptions;
export type PersistImageMediaBundleInspectionResult =
  PersistMediaBundleInspectionResult;
export type PersistImageMediaBundleMetadataArtifactInput =
  PersistMediaBundleMetadataArtifactInput;
export type SmrtImageMediaBundlePersistenceAdapter =
  SmrtMediaBundlePersistenceAdapter;
