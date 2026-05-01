import { describe, expect, it } from 'vitest';
import {
  type ImageMediaBundleInspectionLike,
  type PersistImageMediaBundleAssetInput,
  type PersistImageMediaBundleAssociationInput,
  persistImageMediaBundleInspection,
} from './media-bundle-persistence';

describe('persistImageMediaBundleInspection', () => {
  it('persists a primary, hidden retained support files, metadata, and primary GPS track', async () => {
    const assets: PersistImageMediaBundleAssetInput[] = [];
    const associations: PersistImageMediaBundleAssociationInput[] = [];
    const gpsTracks: Array<{ assetId: string; count: number }> = [];
    const inspection: ImageMediaBundleInspectionLike = {
      handlerId: 'generic-image',
      handlerVersion: '1.0.0',
      formatFamily: 'generic-image',
      primary: {
        path: '/capture/photo.jpg',
        mimeType: 'image/jpeg',
      },
      supportFiles: [
        {
          file: {
            path: '/capture/photo.xmp',
            mimeType: 'application/rdf+xml',
          },
          role: 'support',
          relationship: 'metadata-sidecar',
          metadata: {
            raw: {
              xmp: true,
            },
          },
        },
      ],
      metadata: {
        width: 4000,
        height: 3000,
        gpsTrack: [
          {
            tSeconds: 0,
            latitude: 52.47,
            longitude: -113.73,
          },
        ],
      },
      capabilities: ['gps-track', 'image-metadata'],
      warnings: [],
      errors: [],
    };

    const result = await persistImageMediaBundleInspection(
      {
        async upsertAsset(input) {
          assets.push(input);
          return {
            id: input.role === 'primary' ? 'primary-asset' : 'support-asset',
          };
        },
        async associateSupportFile(input) {
          associations.push(input);
        },
        async writeMetadataArtifact() {
          return { id: 'metadata-json' };
        },
        async replaceGpsTrack(assetId, points) {
          gpsTracks.push({ assetId, count: points.length });
        },
      },
      inspection,
      {
        primaryTypeSlug: 'source-image',
        supportTypeSlug: 'source-sidecar',
      },
    );

    expect(result).toEqual({
      primaryAssetId: 'primary-asset',
      supportAssetIds: ['support-asset'],
      metadataArtifactId: 'metadata-json',
      gpsTrackPointCount: 1,
      warnings: [],
    });
    expect(assets).toHaveLength(2);
    expect(assets[0]).toMatchObject({
      role: 'primary',
      typeSlug: 'source-image',
    });
    expect(assets[1]).toMatchObject({
      role: 'support',
      typeSlug: 'source-sidecar',
      parentAssetId: 'primary-asset',
      relationship: 'metadata-sidecar',
      visibility: 'hidden-retained',
    });
    expect(associations).toEqual([
      expect.objectContaining({
        primaryAssetId: 'primary-asset',
        supportAssetId: 'support-asset',
        relationship: 'metadata-sidecar',
        visibility: 'hidden-retained',
      }),
    ]);
    expect(gpsTracks).toEqual([{ assetId: 'primary-asset', count: 1 }]);
  });

  it('drops transient support files and reports zero persisted GPS points without a GPS adapter', async () => {
    const assets: PersistImageMediaBundleAssetInput[] = [];
    const inspection: ImageMediaBundleInspectionLike = {
      handlerId: 'generic-image',
      handlerVersion: '1.0.0',
      formatFamily: 'generic-image',
      primary: {
        path: '/capture/photo.jpg',
        mimeType: 'image/jpeg',
      },
      supportFiles: [
        {
          file: {
            path: '/capture/photo.tmp',
          },
          role: 'support',
          relationship: 'temporary-extract',
          visibility: 'drop-after-extract',
        },
      ],
      metadata: {
        gpsTrack: [
          {
            tSeconds: 0,
            latitude: 52.47,
            longitude: -113.73,
          },
        ],
      },
      capabilities: ['gps-track'],
      warnings: ['source warning'],
      errors: [],
    };

    const result = await persistImageMediaBundleInspection(
      {
        async upsertAsset(input) {
          assets.push(input);
          return { id: `${input.role}-asset` };
        },
      },
      inspection,
    );

    expect(result).toEqual({
      primaryAssetId: 'primary-asset',
      supportAssetIds: [],
      metadataArtifactId: undefined,
      gpsTrackPointCount: 0,
      warnings: ['source warning', 'adapter cannot persist gps track'],
    });
    expect(assets).toHaveLength(1);
  });
});
