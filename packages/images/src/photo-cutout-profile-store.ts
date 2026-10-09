import { randomUUID } from 'node:crypto';
import {
  type PhotoCutoutRig,
  validatePhotoCutoutRig,
} from '@happyvertical/animation';
import type { Asset, AssetRuntimeLike } from '@happyvertical/smrt-assets';
import sharp from 'sharp';

const RELATIONSHIP = 'character_cutout';
const MANIFEST_VERSION = 1;
/** Stable rig key resolved by the host to the persisted asset bytes. */
export const PHOTO_CUTOUT_PERSISTED_ASSET_REF = 'character_cutout';

export interface PhotoCutoutProfileOwner {
  id?: string;
  tenantId?: string | null;
  getAssets(relationship?: string): Promise<Asset[]>;
  addAsset(
    asset: Asset,
    relationship?: string,
    sortOrder?: number,
  ): Promise<void>;
}

export interface PhotoCutoutProfileStoreAuthorization {
  actorProfileId: string;
  profile: PhotoCutoutProfileOwner;
  tenantId: string | null;
  operation: 'load' | 'save';
}

export interface PhotoCutoutProfileStoreOptions {
  runtime: AssetRuntimeLike;
  getProfile(profileId: string): Promise<PhotoCutoutProfileOwner | null>;
  /** The host verifies its authenticated principal and any app-specific grants. */
  authorize(
    request: PhotoCutoutProfileStoreAuthorization,
  ): Promise<boolean> | boolean;
  now?: () => Date;
}

export interface SavePhotoCutoutProfileSetupInput {
  actorProfileId: string;
  profileId: string;
  tenantId: string | null;
  png: Buffer;
  rig: PhotoCutoutRig;
  name?: string;
}

export interface LoadPhotoCutoutProfileSetupInput {
  actorProfileId: string;
  profileId: string;
  tenantId: string | null;
  /**
   * A photo-cutout asset already linked to this profile. Omitting this keeps
   * the original behavior of loading the most recently saved setup.
   */
  assetId?: string;
}

export interface PersistedPhotoCutoutSetup {
  assetId: string;
  rig: PhotoCutoutRig;
  png: Buffer;
  savedAt: string;
}

/** Metadata for an authorized saved setup, without reading its PNG bytes. */
export interface SavedPhotoCutoutProfileSetup {
  assetId: string;
  savedAt: string;
  name?: string;
}

interface PhotoCutoutManifest {
  version: 1;
  savedAt: string;
  rig: PhotoCutoutRig;
}

class PhotoCutoutManifestError extends Error {}

/**
 * Persists one profile-owned photographic character setup using the canonical
 * AssetRuntime bytes and ProfileAsset link. Authentication stays with the host;
 * this service refuses cross-profile and cross-tenant calls before it writes.
 */
export class PhotoCutoutProfileStore {
  private readonly now: () => Date;

  constructor(private readonly options: PhotoCutoutProfileStoreOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async save(
    input: SavePhotoCutoutProfileSetupInput,
  ): Promise<PersistedPhotoCutoutSetup> {
    await assertPngMatchesRig(input.png, input.rig);
    const profile = await this.requireAuthorizedProfile(input, 'save');
    validatePhotoCutoutRig(input.rig);

    const linkedBefore = new Set(
      (await profile.getAssets(RELATIONSHIP)).flatMap((asset) =>
        asset.id ? [asset.id] : [],
      ),
    );
    const persistenceId = randomUUID();

    const asset = await this.options.runtime.storeSourceAsset(
      input.name ?? 'character-cutout.png',
      input.png,
      {
        mimeType: 'image/png',
        typeSlug: 'photo-cutout',
        metadata: { photoCutoutPersistenceId: persistenceId },
      },
    );
    const assetId = asset.id ? String(asset.id) : null;
    const createdByCall =
      Boolean(assetId) &&
      !linkedBefore.has(assetId as string) &&
      readRecord(asset.metadata).photoCutoutPersistenceId === persistenceId;
    try {
      if (!assetId)
        throw new Error('Stored photo cutout is missing an asset id');
      if (!createdByCall) {
        throw new Error(
          'Asset runtime did not create a new photo cutout asset',
        );
      }
      asset.tenantId = input.tenantId;
      asset.ownerProfileId = input.profileId;
      const rig = bindRigToAsset(input.rig);
      const savedAt = this.now().toISOString();
      asset.metadata = JSON.stringify({
        photoCutout: { version: MANIFEST_VERSION, savedAt, rig },
      });
      await asset.save();
      await profile.addAsset(asset, RELATIONSHIP, 0);
      return { assetId, rig, png: input.png, savedAt };
    } catch (cause) {
      // `storeSourceAsset` writes our unique marker. If a profile link was
      // committed before its adapter threw, retaining the asset is safer than
      // deleting a successful setup or any existing/shared asset.
      const isLinked = (await profile.getAssets(RELATIONSHIP)).some(
        (linked) => String(linked.id) === assetId,
      );
      if (!isLinked && createdByCall) {
        await this.options.runtime.store.remove(asset);
      }
      throw cause;
    }
  }

  async load(
    input: LoadPhotoCutoutProfileSetupInput,
  ): Promise<PersistedPhotoCutoutSetup | null> {
    const profile = await this.requireAuthorizedProfile(input, 'load');
    if (input.assetId) {
      const selected = (await this.readLinkedCandidates(profile, input)).find(
        (candidate) => candidate.assetId === input.assetId,
      );
      if (!selected) return null;
      return this.loadSelected(selected.assetId, readManifest(selected.asset));
    }
    const selected = (await this.readSaved(profile, input))[0];
    if (!selected) return null;
    return this.loadSelected(selected.assetId, selected.manifest);
  }

  private async loadSelected(
    assetId: string,
    manifest: PhotoCutoutManifest,
  ): Promise<PersistedPhotoCutoutSetup> {
    const read = await this.options.runtime.store.readById(assetId);
    if (!read) throw new Error('Saved photo cutout bytes are unavailable');
    await assertPngMatchesRig(read.data, manifest.rig);
    return {
      assetId,
      rig: manifest.rig,
      png: read.data,
      savedAt: manifest.savedAt,
    };
  }

  /**
   * Lists valid, profile-linked saved setups without fetching their image
   * bytes. Authorization deliberately follows `load`: gallery visibility is
   * the same protected read as selecting a setup.
   */
  async list(
    input: LoadPhotoCutoutProfileSetupInput,
  ): Promise<SavedPhotoCutoutProfileSetup[]> {
    const profile = await this.requireAuthorizedProfile(input, 'load');
    return (
      await this.readSaved(profile, input, { omitInvalidManifests: true })
    ).map(({ asset, assetId, manifest }) => ({
      assetId,
      savedAt: manifest.savedAt,
      ...(asset.name ? { name: asset.name } : {}),
    }));
  }

  private async readSaved(
    profile: PhotoCutoutProfileOwner,
    input: Pick<LoadPhotoCutoutProfileSetupInput, 'profileId' | 'tenantId'>,
    options: { omitInvalidManifests?: boolean } = {},
  ) {
    return (await this.readLinkedCandidates(profile, input))
      .flatMap(({ asset, assetId }) => {
        try {
          return [{ asset, assetId, manifest: readManifest(asset) }];
        } catch (cause) {
          if (
            options.omitInvalidManifests &&
            cause instanceof PhotoCutoutManifestError
          ) {
            return [];
          }
          throw cause;
        }
      })
      .sort(
        (a, b) =>
          b.manifest.savedAt.localeCompare(a.manifest.savedAt) ||
          b.assetId.localeCompare(a.assetId),
      );
  }

  private readLinkedCandidates(
    profile: PhotoCutoutProfileOwner,
    input: Pick<LoadPhotoCutoutProfileSetupInput, 'profileId' | 'tenantId'>,
  ) {
    return profile.getAssets(RELATIONSHIP).then((candidates) =>
      candidates.flatMap((asset) => {
        if (
          !asset.id ||
          asset.ownerProfileId !== input.profileId ||
          asset.tenantId !== input.tenantId ||
          asset.typeSlug !== 'photo-cutout'
        ) {
          return [];
        }
        return [{ asset, assetId: asset.id }];
      }),
    );
  }

  private async requireAuthorizedProfile(
    input: LoadPhotoCutoutProfileSetupInput,
    operation: 'load' | 'save',
  ): Promise<PhotoCutoutProfileOwner> {
    const profile = await this.options.getProfile(input.profileId);
    if (!profile?.id) throw new Error('Profile was not found');
    if (profile.id !== input.profileId || profile.tenantId !== input.tenantId) {
      throw new Error('Profile does not belong to the active tenant');
    }
    if (
      !(await this.options.authorize({
        actorProfileId: input.actorProfileId,
        profile,
        tenantId: input.tenantId,
        operation,
      }))
    ) {
      throw new Error('Character setup authorization denied');
    }
    return profile;
  }
}

function bindRigToAsset(rig: PhotoCutoutRig): PhotoCutoutRig {
  const persisted = structuredClone(rig);
  for (const layer of persisted.layers) {
    if ('assetId' in layer) layer.assetId = PHOTO_CUTOUT_PERSISTED_ASSET_REF;
  }
  validatePhotoCutoutRig(persisted);
  return persisted;
}

function readManifest(asset: Asset): PhotoCutoutManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(asset.metadata);
  } catch {
    throw new PhotoCutoutManifestError(
      'Saved photo cutout manifest is malformed',
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PhotoCutoutManifestError(
      'Saved photo cutout manifest is malformed',
    );
  }
  const manifest = (parsed as { photoCutout?: unknown }).photoCutout;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new PhotoCutoutManifestError(
      'Saved photo cutout manifest is malformed',
    );
  }
  const value = manifest as Partial<PhotoCutoutManifest>;
  if (
    value.version !== MANIFEST_VERSION ||
    typeof value.savedAt !== 'string' ||
    Number.isNaN(Date.parse(value.savedAt)) ||
    !value.rig
  ) {
    throw new PhotoCutoutManifestError(
      'Saved photo cutout manifest has an unsupported version',
    );
  }
  try {
    validatePhotoCutoutRig(value.rig);
  } catch {
    throw new PhotoCutoutManifestError(
      'Saved photo cutout manifest rig is invalid',
    );
  }
  if (
    !asset.id ||
    value.rig.layers.some(
      (layer) =>
        'assetId' in layer &&
        layer.assetId !== PHOTO_CUTOUT_PERSISTED_ASSET_REF,
    )
  ) {
    throw new PhotoCutoutManifestError(
      'Saved photo cutout manifest does not match its asset',
    );
  }
  return { version: MANIFEST_VERSION, savedAt: value.savedAt, rig: value.rig };
}

function readRecord(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function assertPngMatchesRig(
  png: Buffer,
  rig: PhotoCutoutRig,
): Promise<void> {
  if (
    !Buffer.isBuffer(png) ||
    png.byteLength < 24 ||
    !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    throw new Error('Photo cutout must be a PNG');
  }
  const metadata = await sharp(png).metadata();
  if (!metadata.width || !metadata.height || metadata.format !== 'png') {
    throw new Error('Photo cutout PNG dimensions are invalid');
  }
  if (
    rig.canvas.width !== metadata.width ||
    rig.canvas.height < metadata.height
  ) {
    throw new Error('Photo cutout rig canvas does not match PNG dimensions');
  }
  for (const layer of rig.layers) {
    if (layer.role === 'mouth-interior') continue;
    const frame = layer.imageFrame;
    if (
      !frame ||
      frame.x !== 0 ||
      frame.y !== 0 ||
      frame.width !== metadata.width ||
      frame.height !== metadata.height
    ) {
      throw new Error(
        'Photo cutout rig image frame does not match PNG dimensions',
      );
    }
  }
}
