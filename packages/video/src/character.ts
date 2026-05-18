/**
 * Character Model
 *
 * Manages virtual characters for AI-powered video production.
 * Each character combines a visual identity with a voice profile.
 *
 * Renamed from PersonalityProfile. A Character is the role being played
 * (outfit, voice, branding). A Performer is the physical likeness/face DNA.
 * "A Performer plays Characters."
 */

import type { Asset } from '@happyvertical/smrt-assets';
import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import { foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { Profile } from '@happyvertical/smrt-profiles';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { VoiceProfile } from '@happyvertical/smrt-voice';
import type { CharacterAssetRole } from './character-asset.js';
import {
  assertValidVideoAssetRole,
  assertValidVideoAssetSortOrder,
  legacyVideoAssetMetaTypes,
  listCanonicalOwnedAssetIds,
  listLegacyOwnedAssetIds,
  mergeOwnedAssetIds,
  resolveOwnedAssets,
} from './owned-asset-utils.js';
import { Performer } from './performer.js';
import { Scene } from './scene.js';

/**
 * Character status
 */
export type CharacterStatus = 'pending' | 'ready';

/**
 * Scene-specific configuration for a character
 */
export interface CharacterSceneConfig {
  /** Scene ID */
  sceneId: string;

  /** Preferred viewpoint ID (for 360° scenes) */
  viewpointId?: string;

  /** Anchor point ID for placement */
  anchorPointId?: string;

  /** Character scale in this scene */
  scale: number;

  /** Character position in this scene (normalized 0-1) */
  position: { x: number; y: number };
}

/**
 * Branding configuration for video overlays
 */
export interface BrandingConfig {
  /** Asset ID for logo overlay */
  logoAssetId?: string | null;

  /** Primary brand color (hex) */
  primaryColor?: string | null;

  /** Background color (hex) */
  backgroundColor?: string | null;

  /** Lower-third template name */
  lowerThirdTemplate?: string | null;

  /** Font family for text overlays */
  fontFamily?: string | null;

  /** Whether to show news ticker */
  tickerEnabled?: boolean;
}

/**
 * Character creation options
 */
export interface CharacterOptions extends SmrtObjectOptions {
  /** Human-readable name for the character */
  name?: string;

  /** Description of the character persona */
  description?: string | null;

  /** Asset ID of the seed image for image-to-video generation */
  imageAssetId?: string | null;

  /** Asset ID of pre-baked base motion video */
  baseMotionAssetId?: string | null;

  /** Voice profile ID for speech synthesis */
  voiceProfileId?: string | null;

  /** Branding configuration for video overlays */
  brandingKit?: BrandingConfig;

  /** Character status */
  status?: CharacterStatus;

  /** Linked performer for IP-Adapter face consistency */
  performerId?: string | null;

  /** Default scene for this character */
  defaultSceneId?: string | null;

  /** Scene-specific configurations */
  sceneConfigs?: CharacterSceneConfig[];

  /** 1-1 profile record for this character */
  profileId?: string | null;

  /** Tenant ID for multi-tenant isolation */
  tenantId?: string | null;
}

/**
 * Virtual character for AI-powered video production
 *
 * Character represents a virtual persona combining:
 * - Visual identity: Seed image for I2V (image-to-video) generation
 * - Voice identity: Link to a VoiceProfile for TTS
 * - Branding: Logo overlays, lower-thirds, colors
 *
 * @example
 * ```typescript
 * import { Character } from '@happyvertical/smrt-video';
 *
 * const character = new Character({
 *   name: 'Bentley News Anchor',
 *   description: 'Professional news anchor for local broadcasts',
 *   imageAssetId: 'asset-123',
 *   voiceProfileId: 'voice-456',
 *   brandingKit: {
 *     logoAssetId: 'asset-789',
 *     primaryColor: '#1a73e8',
 *     lowerThirdTemplate: 'news-standard',
 *     tickerEnabled: true,
 *   },
 * });
 * await character.save();
 * ```
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  tableStrategy: 'sti',
  api: {
    include: ['list', 'get', 'create', 'update', 'delete'],
  },
  mcp: {
    include: ['list', 'get'],
  },
  cli: true,
})
export class Character extends SmrtObject {
  /** Tenant ID for multi-tenant isolation */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** Human-readable name for the character */
  name: string = '';

  /** Description of the character persona */
  description: string | null = null;

  /** Asset ID of the seed image for I2V generation */
  imageAssetId: string | null = null;

  /** Asset ID of pre-baked base motion video */
  baseMotionAssetId: string | null = null;

  /** Voice profile ID for speech synthesis */
  @foreignKey(() => VoiceProfile)
  voiceProfileId: string | null = null;

  /** Branding configuration for video overlays */
  brandingKit: BrandingConfig = {};

  /** Character status */
  status: CharacterStatus = 'pending';

  /** Linked performer for IP-Adapter face consistency */
  @foreignKey(() => Performer)
  performerId: string | null = null;

  /** Default scene for this character */
  @foreignKey(() => Scene)
  defaultSceneId: string | null = null;

  /** Scene-specific configurations */
  sceneConfigs: CharacterSceneConfig[] = [];

  /** 1-1 profile record for this character */
  @foreignKey(() => Profile)
  profileId: string | null = null;

  constructor(options: CharacterOptions = {}) {
    super(options);

    if (options.name !== undefined) this.name = options.name;
    if (options.description !== undefined)
      this.description = options.description;
    if (options.imageAssetId !== undefined)
      this.imageAssetId = options.imageAssetId;
    if (options.baseMotionAssetId !== undefined)
      this.baseMotionAssetId = options.baseMotionAssetId;
    if (options.voiceProfileId !== undefined)
      this.voiceProfileId = options.voiceProfileId;
    if (options.brandingKit !== undefined)
      this.brandingKit = options.brandingKit;
    if (options.status !== undefined) this.status = options.status;
    if (options.performerId !== undefined)
      this.performerId = options.performerId;
    if (options.defaultSceneId !== undefined)
      this.defaultSceneId = options.defaultSceneId;
    if (options.sceneConfigs !== undefined)
      this.sceneConfigs = options.sceneConfigs;
    if (options.profileId !== undefined) this.profileId = options.profileId;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
  }

  private async getCharacterAssetCollection() {
    const { CharacterOwnedAssetCollection } = await import(
      './character-assets.js'
    );
    return CharacterOwnedAssetCollection.create({ db: this.db });
  }

  private getLegacyFieldAssetIds(role?: CharacterAssetRole): string[] {
    if (role === 'seed-image') {
      return this.imageAssetId ? [this.imageAssetId] : [];
    }

    if (role === 'base-motion') {
      return this.baseMotionAssetId ? [this.baseMotionAssetId] : [];
    }

    if (role === 'logo') {
      return this.brandingKit.logoAssetId ? [this.brandingKit.logoAssetId] : [];
    }

    return [
      this.imageAssetId,
      this.baseMotionAssetId,
      this.brandingKit.logoAssetId || null,
    ].filter((assetId): assetId is string => Boolean(assetId));
  }

  private setLegacyFieldAssetId(
    role: CharacterAssetRole,
    assetId: string | null,
  ): boolean {
    if (role === 'seed-image') {
      if (this.imageAssetId === assetId) {
        return false;
      }

      this.imageAssetId = assetId;
      return true;
    }

    if (role === 'base-motion') {
      if (this.baseMotionAssetId === assetId) {
        return false;
      }

      this.baseMotionAssetId = assetId;
      return true;
    }

    if ((this.brandingKit.logoAssetId || null) === assetId) {
      return false;
    }

    this.brandingKit = {
      ...this.brandingKit,
      logoAssetId: assetId,
    };
    return true;
  }

  private clearLegacyFieldAssetId(
    assetId: string,
    role?: CharacterAssetRole,
  ): boolean {
    let changed = false;

    if ((!role || role === 'seed-image') && this.imageAssetId === assetId) {
      this.imageAssetId = null;
      changed = true;
    }

    if (
      (!role || role === 'base-motion') &&
      this.baseMotionAssetId === assetId
    ) {
      this.baseMotionAssetId = null;
      changed = true;
    }

    if (
      (!role || role === 'logo') &&
      this.brandingKit.logoAssetId === assetId
    ) {
      this.brandingKit = {
        ...this.brandingKit,
        logoAssetId: null,
      };
      changed = true;
    }

    return changed;
  }

  async getAssets(role?: CharacterAssetRole): Promise<Asset[]> {
    const canonicalAssetIds = this.id
      ? await listCanonicalOwnedAssetIds({
          tableName: 'character_assets',
          loadLinks: async () =>
            (await this.getCharacterAssetCollection()).byLeft(
              this.id as string,
              role ? { role } : {},
            ),
        })
      : [];
    const legacyFieldAssetIds = this.getLegacyFieldAssetIds(role);
    const legacyOwnedAssetIds = this.id
      ? await listLegacyOwnedAssetIds({
          db: this.db,
          ownerColumn: 'character_id',
          ownerId: this.id,
          role,
          metaTypes: legacyVideoAssetMetaTypes('CharacterAsset'),
        })
      : [];

    return resolveOwnedAssets(
      this.db,
      this.tenantId,
      mergeOwnedAssetIds(
        canonicalAssetIds,
        legacyFieldAssetIds,
        legacyOwnedAssetIds,
      ),
    );
  }

  async getAssetByRole(role: CharacterAssetRole): Promise<Asset | null> {
    const assets = await this.getAssets(role);
    return assets[0] || null;
  }

  async addAsset(
    asset: Asset,
    role: CharacterAssetRole = 'seed-image',
    sortOrder = 0,
  ): Promise<void> {
    if (!this.id || !asset.id) {
      throw new Error('Cannot associate unsaved character or asset');
    }

    assertValidVideoAssetRole(role);
    assertValidVideoAssetSortOrder(sortOrder);

    const characterAssets = await this.getCharacterAssetCollection();
    await characterAssets.attach(this.id, asset.id, {
      role,
      sortOrder,
      tenantId: this.tenantId,
    });

    if (this.setLegacyFieldAssetId(role, asset.id)) {
      await this.save();
    }
  }

  async removeAsset(assetId: string, role?: CharacterAssetRole): Promise<void> {
    if (!this.id) {
      return;
    }

    const characterAssets = await this.getCharacterAssetCollection();
    await characterAssets.detach(this.id, assetId, role ? { role } : {});

    if (this.clearLegacyFieldAssetId(assetId, role)) {
      await this.save();
    }
  }

  /**
   * Check if the character has a pre-baked base motion video
   * @deprecated Use getAssetByRole('base-motion') instead
   */
  get hasBaseMotion(): boolean {
    return this.baseMotionAssetId !== null;
  }

  /** Check if the character is complete and ready for video generation */
  get isComplete(): boolean {
    return (
      this.imageAssetId !== null &&
      this.voiceProfileId !== null &&
      this.status === 'ready'
    );
  }
}
