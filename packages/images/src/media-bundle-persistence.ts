export type MediaSupportFileVisibility =
  | 'visible'
  | 'hidden-retained'
  | 'drop-after-extract';

export interface ImageMediaBundleFileDescriptor {
  path: string;
  relativePath?: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
  sha256?: string;
  modifiedAt?: Date | string;
  metadata?: Record<string, unknown>;
}

export interface ImageMediaBundleGpsTrackPoint {
  tSeconds: number;
  recordedAt?: Date | string | null;
  latitude: number;
  longitude: number;
  altitude?: number | null;
  heading?: number | null;
  speedMps?: number | null;
  sourceFilePath?: string;
}

export interface ImageMediaBundleNormalizedMetadata {
  captureTime?: Date | string | null;
  width?: number;
  height?: number;
  durationMs?: number;
  mimeType?: string;
  gpsTrack?: ImageMediaBundleGpsTrackPoint[];
  raw?: Record<string, unknown>;
  private?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ImageMediaBundleInspectionLike {
  handlerId: string;
  handlerVersion: string;
  formatFamily: string;
  primary: ImageMediaBundleFileDescriptor;
  supportFiles: ImageMediaBundleSupportFileInspection[];
  metadata: ImageMediaBundleNormalizedMetadata;
  capabilities: string[];
  warnings: string[];
  errors: string[];
  raw?: Record<string, unknown>;
}

export interface ImageMediaBundleSupportFileInspection {
  file: ImageMediaBundleFileDescriptor;
  role: string;
  relationship: string;
  visibility?: MediaSupportFileVisibility;
  metadata?: ImageMediaBundleNormalizedMetadata;
}

export interface PersistImageMediaBundleAssetInput {
  file: ImageMediaBundleFileDescriptor;
  role: 'primary' | 'support';
  typeSlug?: string;
  parentAssetId?: string | null;
  relationship?: string;
  visibility?: MediaSupportFileVisibility;
  metadata: ImageMediaBundleNormalizedMetadata;
  inspection: ImageMediaBundleInspectionLike;
}

export interface PersistImageMediaBundleAssociationInput {
  primaryAssetId: string;
  supportAssetId: string;
  relationship: string;
  visibility: MediaSupportFileVisibility;
  metadata?: ImageMediaBundleNormalizedMetadata;
}

export interface PersistImageMediaBundleMetadataArtifactInput {
  primaryAssetId: string;
  inspection: ImageMediaBundleInspectionLike;
}

export interface SmrtImageMediaBundlePersistenceAdapter {
  upsertAsset(
    input: PersistImageMediaBundleAssetInput,
  ): Promise<{ id: string }>;
  associateSupportFile?(
    input: PersistImageMediaBundleAssociationInput,
  ): Promise<void>;
  writeMetadataArtifact?(
    input: PersistImageMediaBundleMetadataArtifactInput,
  ): Promise<{ id: string } | null | undefined>;
  replaceGpsTrack?(
    primaryAssetId: string,
    points: ImageMediaBundleGpsTrackPoint[],
  ): Promise<void>;
}

export interface PersistImageMediaBundleInspectionOptions {
  primaryTypeSlug?: string;
  supportTypeSlug?: string;
  supportVisibility?: MediaSupportFileVisibility;
  writeGpsTrack?: boolean;
  writeMetadataArtifact?: boolean;
}

export interface PersistImageMediaBundleInspectionResult {
  primaryAssetId: string;
  supportAssetIds: string[];
  metadataArtifactId?: string;
  gpsTrackPointCount: number;
  warnings: string[];
}

export async function persistImageMediaBundleInspection(
  adapter: SmrtImageMediaBundlePersistenceAdapter,
  inspection: ImageMediaBundleInspectionLike,
  options: PersistImageMediaBundleInspectionOptions = {},
): Promise<PersistImageMediaBundleInspectionResult> {
  const warnings = [...inspection.warnings];
  const primary = await adapter.upsertAsset({
    file: inspection.primary,
    role: 'primary',
    typeSlug: options.primaryTypeSlug,
    metadata: inspection.metadata,
    inspection,
  });
  const supportAssetIds: string[] = [];

  for (const support of inspection.supportFiles) {
    const visibility =
      support.visibility ?? options.supportVisibility ?? 'hidden-retained';
    if (visibility === 'drop-after-extract') continue;
    const supportAsset = await adapter.upsertAsset({
      file: support.file,
      role: 'support',
      typeSlug: options.supportTypeSlug,
      parentAssetId: primary.id,
      relationship: support.relationship,
      visibility,
      metadata: support.metadata ?? {},
      inspection,
    });
    supportAssetIds.push(supportAsset.id);
    await adapter.associateSupportFile?.({
      primaryAssetId: primary.id,
      supportAssetId: supportAsset.id,
      relationship: support.relationship,
      visibility,
      metadata: support.metadata,
    });
  }

  const artifact =
    options.writeMetadataArtifact !== false && adapter.writeMetadataArtifact
      ? await adapter.writeMetadataArtifact({
          primaryAssetId: primary.id,
          inspection,
        })
      : null;

  let gpsTrackPointCount = 0;
  const gpsTrack = inspection.metadata.gpsTrack ?? [];
  if (options.writeGpsTrack !== false && gpsTrack.length > 0) {
    if (adapter.replaceGpsTrack) {
      await adapter.replaceGpsTrack(primary.id, gpsTrack);
      gpsTrackPointCount = gpsTrack.length;
    } else {
      warnings.push('adapter cannot persist gps track');
    }
  }

  return {
    primaryAssetId: primary.id,
    supportAssetIds,
    metadataArtifactId: artifact?.id,
    gpsTrackPointCount,
    warnings,
  };
}
