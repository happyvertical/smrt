import { describe, expect, it } from 'vitest';
import {
  type MediaBundleGpsTrackPoint,
  type MediaBundleInspection,
  type PersistMediaBundleAssetInput,
  type PersistMediaBundleAssociationInput,
  persistMediaBundleInspection,
} from './media-bundle-persistence.js';

describe('persistMediaBundleInspection', () => {
  it('persists primary media, retained support files, metadata, and canonical primary GPS', async () => {
    const assets: PersistMediaBundleAssetInput[] = [];
    const associations: PersistMediaBundleAssociationInput[] = [];
    const gpsTracks: Array<{
      assetId: string;
      points: MediaBundleGpsTrackPoint[];
    }> = [];
    const inspection: MediaBundleInspection = {
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
                latitude: 52.46,
                longitude: -113.72,
              },
            ],
          },
        },
        {
          file: {
            path: '/capture/VID_20260418_173449_10_004.insv',
            mimeType: 'video/mp4',
          },
          role: 'support',
          relationship: 'paired-lens-video',
          visibility: 'visible',
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
            id:
              input.role === 'primary'
                ? 'primary-asset'
                : `support-asset-${assets.length - 1}`,
          };
        },
        async associateSupportFile(input) {
          associations.push(input);
        },
        async writeMetadataArtifact() {
          return { id: 'metadata-json' };
        },
        async replaceGpsTrack(assetId, points) {
          gpsTracks.push({ assetId, points });
          return 1;
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
      supportAssetIds: ['support-asset-1', 'support-asset-2'],
      metadataArtifactId: 'metadata-json',
      gpsTrackPointCount: 1,
      warnings: [],
    });
    expect(assets).toHaveLength(3);
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
    expect(assets[2]).toMatchObject({
      role: 'support',
      relationship: 'paired-lens-video',
      visibility: 'visible',
    });
    expect(associations).toEqual([
      expect.objectContaining({
        primaryAssetId: 'primary-asset',
        supportAssetId: 'support-asset-1',
        relationship: 'proxy-video',
        visibility: 'hidden-retained',
      }),
      expect.objectContaining({
        primaryAssetId: 'primary-asset',
        supportAssetId: 'support-asset-2',
        relationship: 'paired-lens-video',
        visibility: 'visible',
      }),
    ]);
    expect(gpsTracks).toEqual([
      {
        assetId: 'primary-asset',
        points: inspection.metadata.gpsTrack,
      },
    ]);
  });

  it('drops transient support files and warns when primary GPS cannot be persisted', async () => {
    const assets: PersistMediaBundleAssetInput[] = [];
    const associations: PersistMediaBundleAssociationInput[] = [];
    const inspection: MediaBundleInspection = {
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

  it('honors options that skip metadata artifact and GPS writes', async () => {
    const artifactWrites: string[] = [];
    const gpsWrites: string[] = [];
    const inspection: MediaBundleInspection = {
      handlerId: 'generic-image',
      handlerVersion: '1.0.0',
      formatFamily: 'generic-image',
      primary: {
        path: '/capture/photo.jpg',
        mimeType: 'image/jpeg',
      },
      supportFiles: [],
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

    const result = await persistMediaBundleInspection(
      {
        async upsertAsset(input) {
          return { id: `${input.role}-asset` };
        },
        async writeMetadataArtifact(input) {
          artifactWrites.push(input.primaryAssetId);
          return { id: 'metadata-json' };
        },
        async replaceGpsTrack(assetId) {
          gpsWrites.push(assetId);
          return 1;
        },
      },
      inspection,
      {
        writeGpsTrack: false,
        writeMetadataArtifact: false,
      },
    );

    expect(result).toEqual({
      primaryAssetId: 'primary-asset',
      supportAssetIds: [],
      metadataArtifactId: undefined,
      gpsTrackPointCount: 0,
      warnings: [],
    });
    expect(artifactWrites).toEqual([]);
    expect(gpsWrites).toEqual([]);
  });
});
