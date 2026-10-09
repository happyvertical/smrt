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
    name: 'character-cutout.png',
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
  const authorize = vi.fn(async () => options.authorize ?? true);
  const store = new PhotoCutoutProfileStore({
    runtime,
    getProfile: vi.fn(async () => profile),
    authorize,
    now: () => new Date('2026-10-07T12:00:00.000Z'),
  });
  const input = {
    actorProfileId: options.actorProfileId ?? 'profile-owner',
    profileId: 'profile-owner',
    tenantId: 'tenant-a',
  };
  return { asset, authorize, input, linked, profile, remove, runtime, store };
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

function persistedRig() {
  const persisted = structuredClone(rig);
  for (const layer of persisted.layers) {
    if ('assetId' in layer) layer.assetId = 'character_cutout';
  }
  return persisted;
}

function savedAsset(
  id: string,
  savedAt: string,
  overrides: Partial<Asset> = {},
): Asset {
  return {
    id,
    name: `${id}.png`,
    ownerProfileId: 'profile-owner',
    tenantId: 'tenant-a',
    typeSlug: 'photo-cutout',
    metadata: JSON.stringify({
      photoCutout: { version: 1, savedAt, rig: persistedRig() },
    }),
    ...overrides,
  } as Asset;
}

describe('PhotoCutoutProfileStore', () => {
  it('persists durable owner-bound bytes and reloads a versioned asset-id rig', async () => {
    const { asset, input, runtime, store } = setup();
    const bytes = await png();
    vi.mocked(runtime.store.readById).mockResolvedValue({
      data: bytes,
      asset,
    });

    const saved = await store.save({ ...input, png: bytes, rig });
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
    expect(loaded?.png).toEqual(bytes);
  });

  it('lists profile-linked saved setups and selects either one while preserving latest load compatibility', async () => {
    const { asset, input, linked, runtime, store } = setup();
    const older = savedAsset('cutout-older', '2026-10-06T12:00:00.000Z', {
      name: 'Older portrait',
    });
    const newer = savedAsset('cutout-newer', '2026-10-07T12:00:00.000Z', {
      name: 'Newer portrait',
    });
    linked.push(older, newer);
    const bytes = await png();
    vi.mocked(runtime.store.readById).mockResolvedValue({ data: bytes, asset });

    await expect(store.list(input)).resolves.toEqual([
      {
        assetId: 'cutout-newer',
        savedAt: '2026-10-07T12:00:00.000Z',
        name: 'Newer portrait',
      },
      {
        assetId: 'cutout-older',
        savedAt: '2026-10-06T12:00:00.000Z',
        name: 'Older portrait',
      },
    ]);
    await expect(store.load(input)).resolves.toMatchObject({
      assetId: 'cutout-newer',
    });
    await expect(
      store.load({ ...input, assetId: 'cutout-older' }),
    ).resolves.toMatchObject({ assetId: 'cutout-older' });
  });

  it('does not expose unlinked, cross-owner, cross-tenant, or unknown assets', async () => {
    const { input, linked, runtime, store } = setup();
    const linkedAsset = savedAsset('linked', '2026-10-07T12:00:00.000Z');
    const unlinkedAsset = savedAsset('unlinked', '2026-10-08T12:00:00.000Z');
    linked.push(
      linkedAsset,
      savedAsset('other-owner', '2026-10-08T12:00:00.000Z', {
        ownerProfileId: 'other-profile',
      }),
      savedAsset('other-tenant', '2026-10-08T12:00:00.000Z', {
        tenantId: 'tenant-b',
      }),
    );

    await expect(store.list(input)).resolves.toEqual([
      {
        assetId: 'linked',
        savedAt: '2026-10-07T12:00:00.000Z',
        name: 'linked.png',
      },
    ]);
    await expect(
      store.load({ ...input, assetId: 'unknown-asset' }),
    ).resolves.toBeNull();
    await expect(
      store.load({ ...input, assetId: unlinkedAsset.id as string }),
    ).resolves.toBeNull();
    expect(runtime.store.readById).not.toHaveBeenCalled();
  });

  it('uses load authorization, omits corrupt gallery manifests, and fails closed for selected corrupt manifests or unavailable bytes', async () => {
    const { authorize, input, linked, runtime, store } = setup();
    linked.push(savedAsset('valid', '2026-10-07T12:00:00.000Z'));
    await expect(store.list(input)).resolves.toHaveLength(1);
    expect(authorize).toHaveBeenLastCalledWith(
      expect.objectContaining({ operation: 'load' }),
    );
    expect(runtime.store.readById).not.toHaveBeenCalled();

    linked[0].metadata = '{bad json';
    await expect(store.list(input)).resolves.toEqual([]);
    await expect(store.load({ ...input, assetId: 'valid' })).rejects.toThrow(
      'manifest is malformed',
    );

    linked.push(savedAsset('other-valid', '2026-10-08T12:00:00.000Z'));
    await expect(store.list(input)).resolves.toEqual([
      {
        assetId: 'other-valid',
        savedAt: '2026-10-08T12:00:00.000Z',
        name: 'other-valid.png',
      },
    ]);

    linked[0] = savedAsset('valid', '2026-10-07T12:00:00.000Z');
    vi.mocked(runtime.store.readById).mockResolvedValue(null);
    await expect(store.load(input)).rejects.toThrow('bytes are unavailable');

    vi.mocked(runtime.store.readById).mockResolvedValue({
      data: Buffer.from('not a png'),
      asset: linked[0],
    });
    await expect(store.load(input)).rejects.toThrow('must be a PNG');
  });

  it('denies listing when the host declines read authorization', async () => {
    const { input, runtime, store } = setup({ authorize: false });
    await expect(store.list(input)).rejects.toThrow('authorization denied');
    expect(runtime.store.readById).not.toHaveBeenCalled();
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
