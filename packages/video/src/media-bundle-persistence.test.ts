import { describe, expect, it } from 'vitest';
import {
  type MediaBundleInspectionLike,
  type PersistMediaBundleAssetInput,
  type PersistMediaBundleAssociationInput,
  persistMediaBundleInspection,
} from './media-bundle-persistence.js';

describe('persistMediaBundleInspection', () => {
  it('persists a primary, hidden retained support files, metadata, and primary GPS track', async () => {
    const assets: PersistMediaBundleAssetInput[] = [];
    const associations: PersistMediaBundleAssociationInput[] = [];
    const gpsTracks: Array<{ assetId: string; count: number }> = [];
    const inspection: MediaBundleInspectionLike = {
      handlerId: 'insta360-insv-lrv',
      handlerVersion: '1.0.0',
      formatFamily: 'insta360',
      primary: {
        path: '/capture/VID_20260418_173449_00_004.insv',
        mimeType: 'video/mp4',
      },
      supportFiles: [
        {
          file: {
            path: '/capture/LRV_20260418_173449_01_004.lrv',
            mimeType: 'video/mp4',
          },
          role: 'metadata',
          relationship: 'proxy-video',
          metadata: {
            gpsTrack: [
              {
                tSeconds: 0,
                latitude: 52.47,
                longitude: -113.73,
              },
            ],
          },
        },
      ],
      metadata: {
        durationMs: 12_000,
        gpsTrack: [
          {
            tSeconds: 0,
            latitude: 52.47,
            longitude: -113.73,
          },
          {
            tSeconds: 10,
            latitude: 52.48,
            longitude: -113.74,
          },
        ],
      },
      capabilities: ['gps-track', 'sidecar-binding'],
      warnings: [],
      errors: [],
    };

    const result = await persistMediaBundleInspection(
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
        primaryTypeSlug: 'source-video',
        supportTypeSlug: 'source-sidecar',
      },
    );

    expect(result).toEqual({
      primaryAssetId: 'primary-asset',
      supportAssetIds: ['support-asset'],
      metadataArtifactId: 'metadata-json',
      gpsTrackPointCount: 2,
      warnings: [],
    });
    expect(assets).toHaveLength(2);
    expect(assets[0]).toMatchObject({
      role: 'primary',
      typeSlug: 'source-video',
    });
    expect(assets[1]).toMatchObject({
      role: 'support',
      typeSlug: 'source-sidecar',
      parentAssetId: 'primary-asset',
      relationship: 'proxy-video',
      visibility: 'hidden-retained',
    });
    expect(associations).toEqual([
      expect.objectContaining({
        primaryAssetId: 'primary-asset',
        supportAssetId: 'support-asset',
        relationship: 'proxy-video',
        visibility: 'hidden-retained',
      }),
    ]);
    expect(gpsTracks).toEqual([{ assetId: 'primary-asset', count: 2 }]);
  });

  it('drops transient support files and reports zero persisted GPS points without a GPS adapter', async () => {
    const assets: PersistMediaBundleAssetInput[] = [];
    const associations: PersistMediaBundleAssociationInput[] = [];
    const inspection: MediaBundleInspectionLike = {
      handlerId: 'test',
      handlerVersion: '1.0.0',
      formatFamily: 'generic-video',
      primary: {
        path: '/capture/clip.mp4',
        mimeType: 'video/mp4',
      },
      supportFiles: [
        {
          file: {
            path: '/capture/clip.tmp',
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

    const result = await persistMediaBundleInspection(
      {
        async upsertAsset(input) {
          assets.push(input);
          return { id: `${input.role}-asset` };
        },
        async associateSupportFile(input) {
          associations.push(input);
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
    expect(associations).toEqual([]);
  });
});
