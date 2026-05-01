export type MediaSupportFileVisibility =
  | 'visible'
  | 'hidden-retained'
  | 'drop-after-extract';

export interface MediaBundleFileDescriptor {
  path: string;
  relativePath?: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
  sha256?: string;
  modifiedAt?: Date | string;
  metadata?: Record<string, unknown>;
}

export interface MediaBundleGpsTrackPoint {
  tSeconds: number;
  recordedAt?: Date | string | null;
  latitude: number;
  longitude: number;
  altitude?: number | null;
  heading?: number | null;
  speedMps?: number | null;
  sourceFilePath?: string;
}

export interface MediaBundleNormalizedMetadata {
  captureTime?: Date | string | null;
  width?: number;
  height?: number;
  durationMs?: number;
  mimeType?: string;
  gpsTrack?: MediaBundleGpsTrackPoint[];
  raw?: Record<string, unknown>;
  private?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface MediaBundleSupportFileInspection {
  file: MediaBundleFileDescriptor;
  role: string;
  relationship: string;
  visibility?: MediaSupportFileVisibility;
  metadata?: MediaBundleNormalizedMetadata;
}

export interface MediaBundleInspectionLike {
  handlerId: string;
  handlerVersion: string;
  formatFamily: string;
  primary: MediaBundleFileDescriptor;
  supportFiles: MediaBundleSupportFileInspection[];
  metadata: MediaBundleNormalizedMetadata;
  capabilities: string[];
  warnings: string[];
  errors: string[];
  raw?: Record<string, unknown>;
}

export interface PersistMediaBundleAssetInput {
  file: MediaBundleFileDescriptor;
  role: 'primary' | 'support';
  typeSlug?: string;
  parentAssetId?: string | null;
  relationship?: string;
  visibility?: MediaSupportFileVisibility;
  metadata: MediaBundleNormalizedMetadata;
  inspection: MediaBundleInspectionLike;
}

export interface PersistMediaBundleAssociationInput {
  primaryAssetId: string;
  supportAssetId: string;
  relationship: string;
  visibility: MediaSupportFileVisibility;
  metadata?: MediaBundleNormalizedMetadata;
}

export interface PersistMediaBundleMetadataArtifactInput {
  primaryAssetId: string;
  inspection: MediaBundleInspectionLike;
}

export interface SmrtMediaBundlePersistenceAdapter {
  upsertAsset(input: PersistMediaBundleAssetInput): Promise<{ id: string }>;
  associateSupportFile?(
    input: PersistMediaBundleAssociationInput,
  ): Promise<void>;
  writeMetadataArtifact?(
    input: PersistMediaBundleMetadataArtifactInput,
  ): Promise<{ id: string } | null | undefined>;
  replaceGpsTrack?(
    primaryAssetId: string,
    points: MediaBundleGpsTrackPoint[],
  ): Promise<void>;
}

export interface PersistMediaBundleInspectionOptions {
  primaryTypeSlug?: string;
  supportTypeSlug?: string;
  supportVisibility?: MediaSupportFileVisibility;
  writeGpsTrack?: boolean;
  writeMetadataArtifact?: boolean;
}

export interface PersistMediaBundleInspectionResult {
  primaryAssetId: string;
  supportAssetIds: string[];
  metadataArtifactId?: string;
  gpsTrackPointCount: number;
  warnings: string[];
}

export async function persistMediaBundleInspection(
  adapter: SmrtMediaBundlePersistenceAdapter,
  inspection: MediaBundleInspectionLike,
  options: PersistMediaBundleInspectionOptions = {},
): Promise<PersistMediaBundleInspectionResult> {
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

    if (adapter.associateSupportFile) {
      await adapter.associateSupportFile({
        primaryAssetId: primary.id,
        supportAssetId: supportAsset.id,
        relationship: support.relationship,
        visibility,
        metadata: support.metadata,
      });
    }
  }

  let metadataArtifactId: string | undefined;
  if (
    options.writeMetadataArtifact !== false &&
    adapter.writeMetadataArtifact
  ) {
    const artifact = await adapter.writeMetadataArtifact({
      primaryAssetId: primary.id,
      inspection,
    });
    metadataArtifactId = artifact?.id;
  }

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
    metadataArtifactId,
    gpsTrackPointCount,
    warnings,
  };
}
