/**
 * Personality Profile Model
 *
 * Manages virtual personality profiles for AI-powered video production.
 * Each personality profile combines a visual identity with a voice profile.
 */

import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import { foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { VoiceProfile } from '@happyvertical/smrt-voice';

/**
 * Personality profile status
 */
export type PersonalityProfileStatus = 'pending' | 'ready';

/**
 * Branding configuration for video overlays
 */
export interface BrandingConfig {
  /**
   * Asset ID for logo overlay
   */
  logoAssetId?: string | null;

  /**
   * Primary brand color (hex)
   */
  primaryColor?: string | null;

  /**
   * Background color (hex)
   */
  backgroundColor?: string | null;

  /**
   * Lower-third template name
   */
  lowerThirdTemplate?: string | null;

  /**
   * Font family for text overlays
   */
  fontFamily?: string | null;

  /**
   * Whether to show news ticker
   */
  tickerEnabled?: boolean;
}

/**
 * Personality profile creation options
 */
export interface PersonalityProfileOptions extends SmrtObjectOptions {
  /**
   * Human-readable name for the personality
   */
  name?: string;

  /**
   * Description of the personality persona
   */
  description?: string | null;

  /**
   * Asset ID of the seed image for image-to-video generation
   */
  imageAssetId?: string | null;

  /**
   * Asset ID of pre-baked base motion video
   */
  baseMotionAssetId?: string | null;

  /**
   * Voice profile ID for speech synthesis
   */
  voiceProfileId?: string | null;

  /**
   * Branding configuration for video overlays
   */
  brandingKit?: BrandingConfig;

  /**
   * Personality profile status
   * @default 'pending'
   */
  status?: PersonalityProfileStatus;

  /**
   * Tenant ID for multi-tenant isolation
   */
  tenantId?: string | null;
}

/**
 * Virtual personality profile for AI-powered video production
 *
 * PersonalityProfile represents a virtual personality combining:
 * - Visual identity: Seed image for I2V (image-to-video) generation
 * - Voice identity: Link to a VoiceProfile for TTS
 * - Branding: Logo overlays, lower-thirds, colors
 *
 * @example
 * ```typescript
 * import { PersonalityProfile } from '@happyvertical/smrt-video';
 *
 * const personality = new PersonalityProfile({
 *   name: 'Bentley News Anchor',
 *   description: 'Professional news anchor for local broadcasts',
 *   imageAssetId: 'asset-123', // Seed image
 *   voiceProfileId: 'voice-456', // Voice profile
 *   brandingKit: {
 *     logoAssetId: 'asset-789',
 *     primaryColor: '#1a73e8',
 *     lowerThirdTemplate: 'news-standard',
 *     tickerEnabled: true,
 *   },
 * });
 * await personality.save();
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
export class PersonalityProfile extends SmrtObject {
  /**
   * Tenant ID for multi-tenant isolation
   */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * Human-readable name for the personality
   */
  name: string = '';

  /**
   * Description of the personality persona
   */
  description: string | null = null;

  /**
   * Asset ID of the seed image for I2V generation
   * Should be a high-quality portrait image
   */
  imageAssetId: string | null = null;

  /**
   * Asset ID of pre-baked base motion video
   * Optional - can be generated on demand
   */
  baseMotionAssetId: string | null = null;

  /**
   * Voice profile ID for speech synthesis
   */
  @foreignKey(() => VoiceProfile)
  voiceProfileId: string | null = null;

  /**
   * Branding configuration for video overlays
   */
  brandingKit: BrandingConfig = {};

  /**
   * Personality profile status
   * - pending: Profile created but not yet ready
   * - ready: Profile is ready for video generation
   */
  status: PersonalityProfileStatus = 'pending';

  constructor(options: PersonalityProfileOptions = {}) {
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
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
  }

  /**
   * Check if the profile has a pre-baked base motion video
   */
  get hasBaseMotion(): boolean {
    return this.baseMotionAssetId !== null;
  }

  /**
   * Check if the profile is complete and ready for video generation
   */
  get isComplete(): boolean {
    return (
      this.imageAssetId !== null &&
      this.voiceProfileId !== null &&
      this.status === 'ready'
    );
  }
}
