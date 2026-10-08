import type { Asset, AssetRuntimeLike } from '@happyvertical/smrt-assets';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import {
  type PhotoCutoutProfileOwner,
  PhotoCutoutProfileStore,
} from '../photo-cutout-profile-store.js';
import { assembleCanadianSplitRig } from '../photo-cutout-setup.js';

const rig = assembleCanadianSplitRig({
  outline: {
    points: [
      { x: 200, y: 100 },
      { x: 800, y: 100 },
      { x: 940, y: 500 },
      { x: 760, y: 900 },
      { x: 240, y: 900 },
      { x: 60, y: 500 },
    ],
  },
  landmarks: {
    mouthLeft: { x: 350, y: 550 },
    mouthRight: { x: 650, y: 550 },
    chin: { x: 500, y: 850 },
  },
  assetId: 'transient-source',
  width: 100,
  height: 120,
});

function setup(
  options: {
    authorize?: boolean;
    tenantId?: string | null;
    actorProfileId?: string;
    addAsset?: () => Promise<void>;
    throwAfterLink?: boolean;
  } = {},
) {
  const asset = {
    id: 'cutout-asset',
    tenantId: null,
    ownerProfileId: null,
    typeSlug: 'photo-cutout',
    metadata: '',
    save: vi.fn(async () => asset),
  } as unknown as Asset;
  const linked: Asset[] = [];
  const profile: PhotoCutoutProfileOwner = {
    id: 'profile-owner',
    tenantId: options.tenantId ?? 'tenant-a',
    getAssets: vi.fn(async () => linked),
    addAsset: vi.fn(async (next) => {
      await options.addAsset?.();
      linked.push(next);
      if (options.throwAfterLink) throw new Error('link transport failed');
    }),
  };
  const remove = vi.fn(async () => undefined);
  const runtime = {
    storeSourceAsset: vi.fn(async (_name, _data, storeOptions) => {
      asset.metadata = JSON.stringify(storeOptions.metadata);
      return asset;
    }),
    store: {
      remove,
      readById: vi.fn(async () => ({ data: Buffer.from('png'), asset })),
    },
  } as unknown as AssetRuntimeLike;
  const store = new PhotoCutoutProfileStore({
    runtime,
    getProfile: vi.fn(async () => profile),
    authorize: vi.fn(async () => options.authorize ?? true),
    now: () => new Date('2026-10-07T12:00:00.000Z'),
  });
  const input = {
    actorProfileId: options.actorProfileId ?? 'profile-owner',
    profileId: 'profile-owner',
    tenantId: 'tenant-a',
  };
  return { asset, input, linked, profile, remove, runtime, store };
}

async function png() {
  return sharp({
    create: {
      width: 100,
      height: 120,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .png()
    .toBuffer();
}

describe('PhotoCutoutProfileStore', () => {
  it('persists durable owner-bound bytes and reloads a versioned asset-id rig', async () => {
    const { asset, input, store } = setup();

    const saved = await store.save({ ...input, png: await png(), rig });
    const loaded = await store.load(input);

    expect(saved.assetId).toBe('cutout-asset');
    expect(asset.ownerProfileId).toBe('profile-owner');
    expect(asset.tenantId).toBe('tenant-a');
    expect(asset.metadata).toContain('"version":1');
    expect(asset.metadata).not.toContain('sourceUri');
    expect(
      saved.rig.layers.every(
        (layer) =>
          !('assetId' in layer) || layer.assetId === 'character_cutout',
      ),
    ).toBe(true);
    expect(loaded).toMatchObject({
      assetId: 'cutout-asset',
      savedAt: saved.savedAt,
    });
    expect(loaded?.png).toEqual(Buffer.from('png'));
  });

  it('denies an unauthorized different actor before storing bytes', async () => {
    const { input, runtime, store } = setup({
      actorProfileId: 'other-profile',
      authorize: false,
    });
    await expect(
      store.save({ ...input, png: await png(), rig }),
    ).rejects.toThrow('authorization denied');
    expect(runtime.storeSourceAsset).not.toHaveBeenCalled();
  });

  it('allows a host-authorized actor to manage an owned profile', async () => {
    const { input, store } = setup({ actorProfileId: 'profile-manager' });
    await expect(
      store.save({ ...input, png: await png(), rig }),
    ).resolves.toMatchObject({ assetId: 'cutout-asset' });
  });

  it('rejects non-PNG bytes before creating an asset', async () => {
    const { input, runtime, store } = setup();
    await expect(
      store.save({ ...input, png: Buffer.from('not a png'), rig }),
    ).rejects.toThrow('must be a PNG');
    expect(runtime.storeSourceAsset).not.toHaveBeenCalled();
  });

  it('denies a profile from another tenant before storing bytes', async () => {
    const { input, runtime, store } = setup({ tenantId: 'tenant-b' });
    await expect(
      store.save({ ...input, png: await png(), rig }),
    ).rejects.toThrow('active tenant');
    expect(runtime.storeSourceAsset).not.toHaveBeenCalled();
  });

  it('fails closed when the host authorization callback declines', async () => {
    const { input, runtime, store } = setup({ authorize: false });
    await expect(
      store.save({ ...input, png: await png(), rig }),
    ).rejects.toThrow('authorization denied');
    expect(runtime.storeSourceAsset).not.toHaveBeenCalled();
  });

  it('compensates only its newly created unlinked asset when profile linking fails', async () => {
    const { input, remove, store } = setup({
      addAsset: async () => {
        throw new Error('profile link failed');
      },
    });
    await expect(
      store.save({ ...input, png: await png(), rig }),
    ).rejects.toThrow('profile link failed');
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('does not delete a setup when an adapter links it then throws', async () => {
    const { input, remove, store } = setup({ throwAfterLink: true });
    // The real junction may commit before an adapter reports a transport error.
    await expect(
      store.save({ ...input, png: await png(), rig }),
    ).rejects.toThrow('link transport failed');
    expect(remove).not.toHaveBeenCalled();
  });

  it('rejects malformed and unsupported saved manifests on reload', async () => {
    const { asset, input, linked, store } = setup();
    asset.ownerProfileId = 'profile-owner';
    asset.tenantId = 'tenant-a';
    linked.push(asset);
    asset.metadata = '{bad json';
    await expect(store.load(input)).rejects.toThrow('manifest is malformed');

    asset.metadata = JSON.stringify({
      photoCutout: { version: 2, savedAt: 'x', rig },
    });
    await expect(store.load(input)).rejects.toThrow('unsupported version');
  });
});
