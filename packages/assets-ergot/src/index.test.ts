import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssetRuntime } from '@happyvertical/smrt-assets';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createErgotAssetProcessor,
  type ErgotConsumerAssetClient,
} from './index';

describe('smrt-assets Ergot adapter', () => {
  let db: DatabaseInterface;
  let storageDir: string;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    storageDir = mkdtempSync(join(tmpdir(), 'smrt-assets-ergot-'));
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
    if (storageDir && existsSync(storageDir)) {
      rmSync(storageDir, { recursive: true, force: true });
    }
  });

  function createClient(): ErgotConsumerAssetClient {
    return {
      listAssets: vi.fn(async () => ({ items: [], nextCursor: null })),
      listNearbyAssets: vi.fn(async () => ({
        items: [
          {
            id: 'ergot-asset-nearby',
            name: 'Nearby photo',
            mimeType: 'image/jpeg',
            typeSlug: 'source-image',
            status: 'ready',
            updatedAt: '2026-05-10T00:00:00.000Z',
            sourceUri: 'mam://nearby',
            parentId: null,
            version: 1,
            width: 100,
            height: 50,
            alt: null,
            thumbnailUri: 'https://ergot.example.test/thumb',
            location: {
              latitude: 52.4,
              longitude: -114.0,
              distanceMeters: 42,
              recordedAt: '2026-05-09T00:00:00.000Z',
            },
          },
        ],
        nextCursor: null,
      })),
      uploadAsset: vi.fn(async () => ({
        id: 'ergot-asset-1',
        name: 'Source photo',
        mimeType: 'image/jpeg',
        typeSlug: 'image',
        status: 'ready',
        updatedAt: '2026-05-10T00:00:00.000Z',
        sourceUri: 'mam://ergot-asset-1',
        parentId: null,
        version: 1,
        width: 0,
        height: 0,
        alt: null,
        thumbnailUri: 'https://ergot.example.test/thumb',
      })),
      submitJob: vi.fn(async () => ({
        job: {
          id: 'job-1',
          status: 'queued',
          outputAssetIds: [],
        },
        idempotent: false,
      })),
    };
  }

  it('idempotently syncs SMRT assets into Ergot by source ref', async () => {
    const client = createClient();
    const runtime = await createAssetRuntime({
      db,
      storage: storageDir,
      capabilityProviders: [createErgotAssetProcessor({ client })],
    });
    const asset = await runtime.storeSourceAsset(
      'Source photo',
      Buffer.from('image-bytes'),
      { mimeType: 'image/jpeg', typeSlug: 'image' },
    );
    asset.tenantId = 'tenant-1';
    await asset.save();

    const result = await runtime.syncExternalAsset(asset);
    const ergotRef = asset.getExternalRef('ergot');

    expect(result).toMatchObject({
      provider: 'ergot',
      status: 'ready',
      externalAssetId: 'ergot-asset-1',
      externalId: `smrt-assets:image:${asset.id}`,
    });
    expect(client.uploadAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        externalId: `smrt-assets:image:${asset.id}`,
        sourceRef: {
          system: 'smrt-assets',
          kind: 'image',
          id: asset.id,
        },
        metadata: expect.objectContaining({
          smrt: expect.objectContaining({
            assetId: asset.id,
            tenantId: 'tenant-1',
          }),
        }),
      }),
    );
    expect(ergotRef).toMatchObject({
      provider: 'ergot',
      assetId: 'ergot-asset-1',
      externalId: `smrt-assets:image:${asset.id}`,
    });
  });

  it('uses an existing Ergot asset instead of uploading again', async () => {
    const client = createClient();
    vi.mocked(client.listAssets).mockResolvedValueOnce({
      items: [
        {
          id: 'ergot-existing',
          name: 'Existing',
          mimeType: 'image/jpeg',
          typeSlug: 'image',
          status: 'ready',
          updatedAt: null,
          sourceUri: 'mam://existing',
          parentId: null,
          version: 1,
          width: 0,
          height: 0,
          alt: null,
        },
      ],
      nextCursor: null,
    });
    const runtime = await createAssetRuntime({
      db,
      storage: storageDir,
      capabilityProviders: [createErgotAssetProcessor({ client })],
    });
    const asset = await runtime.storeSourceAsset(
      'Source photo',
      Buffer.from('image-bytes'),
      { mimeType: 'image/jpeg', typeSlug: 'image' },
    );

    await expect(runtime.syncExternalAsset(asset)).resolves.toMatchObject({
      externalAssetId: 'ergot-existing',
    });
    expect(client.uploadAsset).not.toHaveBeenCalled();
  });

  it('derives external ids from caller-provided source refs', async () => {
    const client = createClient();
    const runtime = await createAssetRuntime({
      db,
      storage: storageDir,
      capabilityProviders: [createErgotAssetProcessor({ client })],
    });
    const asset = await runtime.storeSourceAsset(
      'Source photo',
      Buffer.from('image-bytes'),
      { mimeType: 'image/jpeg', typeSlug: 'image' },
    );

    await runtime.syncExternalAsset(asset, {
      sourceRef: {
        system: 'anytown-site-assets',
        kind: 'site-image',
        id: 'site-asset-1',
      },
    });

    expect(client.listAssets).toHaveBeenCalledWith(
      expect.objectContaining({
        externalId: 'anytown-site-assets:site-image:site-asset-1',
        sourceRef: {
          system: 'anytown-site-assets',
          kind: 'site-image',
          id: 'site-asset-1',
        },
      }),
    );
    expect(client.uploadAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        externalId: 'anytown-site-assets:site-image:site-asset-1',
      }),
    );
  });

  it('delegates nearby search and workflow submission to Ergot', async () => {
    const client = createClient();
    const runtime = await createAssetRuntime({
      db,
      storage: storageDir,
      capabilityProviders: [createErgotAssetProcessor({ client })],
    });
    const asset = await runtime.storeSourceAsset(
      'Source photo',
      Buffer.from('image-bytes'),
      { mimeType: 'image/jpeg', typeSlug: 'image' },
    );
    const reference = await runtime.storeSourceAsset(
      'Reference photo',
      Buffer.from('reference-image-bytes'),
      { mimeType: 'image/jpeg', typeSlug: 'image' },
    );

    await expect(
      runtime.searchNearbyAssets({
        latitude: 52.4,
        longitude: -114,
        radiusMeters: 500,
      }),
    ).resolves.toMatchObject({
      items: [
        {
          assetId: 'ergot-asset-nearby',
          origin: 'ergot',
          distanceMeters: 42,
        },
      ],
    });
    await expect(
      runtime.submitAssetWorkflow(asset, {
        workflowSlug: 'content.image.generate',
        sourceAssetIds: [reference.id!],
        inputSelections: [{ slotKey: 'reference', assetIds: [reference.id!] }],
      }),
    ).resolves.toMatchObject({
      provider: 'ergot',
      jobId: 'job-1',
      status: 'queued',
    });
    expect(client.submitJob).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowSlug: 'content.image.generate',
        sourceAssetIds: ['ergot-asset-1'],
        inputSelections: [
          { slotKey: 'reference', assetIds: ['ergot-asset-1'] },
        ],
        requestContext: expect.objectContaining({
          smrtAssetId: asset.id,
        }),
      }),
    );
  });
});
