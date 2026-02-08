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

import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import { foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { Profile } from '@happyvertical/smrt-profiles';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { VoiceProfile } from '@happyvertical/smrt-voice';
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
