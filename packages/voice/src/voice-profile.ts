/**
 * Voice Profile Model
 *
 * Manages voice profiles for AI-powered voice synthesis and cloning.
 * Supports voice design via natural language descriptions and voice
 * cloning from audio samples.
 */

import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

/**
 * Voice profile status
 */
export type VoiceProfileStatus = 'pending' | 'processing' | 'ready' | 'failed';

/**
 * Voice gender classification
 */
export type VoiceGender = 'male' | 'female' | 'neutral';

/**
 * Voice profile creation options
 */
export interface VoiceProfileOptions extends SmrtObjectOptions {
  /**
   * Human-readable name for the voice profile
   */
  name?: string;

  /**
   * Description of the voice characteristics
   */
  description?: string | null;

  /**
   * ISO language code (e.g., 'en-US', 'zh-CN')
   */
  language?: string;

  /**
   * Voice gender classification
   * @default 'neutral'
   */
  gender?: VoiceGender;

  /**
   * Natural language description for voice design
   * Used when creating a voice from scratch
   */
  designPrompt?: string | null;

  /**
   * Asset ID of the audio sample for voice cloning
   * Should be at least 3 seconds of clear speech
   */
  sampleAssetId?: string | null;

  /**
   * Provider-specific voice data (ID, embedding, etc.)
   * Stored after voice creation/cloning
   */
  voiceData?: Record<string, any> | null;

  /**
   * Default speech speed multiplier
   * @default 1.0
   */
  defaultSpeed?: number;

  /**
   * Default pitch adjustment in semitones
   * @default 0
   */
  defaultPitch?: number;

  /**
   * Voice profile status
   * @default 'pending'
   */
  status?: VoiceProfileStatus;

  /**
   * TTS provider that created this voice
   * @default 'qwen3-tts'
   */
  provider?: string;

  /**
   * Error message if status is 'failed'
   */
  errorMessage?: string | null;

  /**
   * Tenant ID for multi-tenant isolation
   * Null for global/default voices
   */
  tenantId?: string | null;
}

/**
 * Voice profile for AI-powered speech synthesis
 *
 * VoiceProfile represents a configured voice identity that can be used
 * for text-to-speech synthesis. Voices can be created through:
 * - Voice design: Natural language description of desired voice characteristics
 * - Voice cloning: 3+ second audio sample for voice replication
 *
 * @example
 * ```typescript
 * import { VoiceProfile } from '@happyvertical/smrt-voice';
 *
 * // Create a designed voice
 * const anchorVoice = new VoiceProfile({
 *   name: 'News Anchor',
 *   description: 'Professional news anchor voice with clear enunciation',
 *   language: 'en-US',
 *   gender: 'male',
 *   designPrompt: 'Warm, authoritative male voice with slight gravitas, suitable for news broadcasts',
 *   provider: 'qwen3-tts',
 * });
 *
 * // Create a cloned voice
 * const clonedVoice = new VoiceProfile({
 *   name: 'Custom Voice',
 *   description: 'Cloned from user sample',
 *   language: 'en-US',
 *   sampleAssetId: 'asset-123',
 *   provider: 'qwen3-tts',
 * });
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
export class VoiceProfile extends SmrtObject {
  /**
   * Tenant ID for multi-tenant isolation
   * Nullable to support global/default voices
   */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * Human-readable name for the voice profile
   */
  name: string = '';

  /**
   * Description of the voice characteristics
   */
  description: string | null = null;

  /**
   * ISO language code (e.g., 'en-US', 'zh-CN')
   */
  language: string = 'en-US';

  /**
   * Voice gender classification
   */
  gender: VoiceGender = 'neutral';

  /**
   * Natural language description for voice design
   * Used when creating a voice from scratch via AI
   */
  designPrompt: string | null = null;

  /**
   * Asset ID of the audio sample for voice cloning
   * Should be at least 3 seconds of clear speech
   */
  sampleAssetId: string | null = null;

  /**
   * Provider-specific voice data (ID, embedding, etc.)
   * Stored after voice creation/cloning is complete
   */
  voiceData: Record<string, any> | null = null;

  /**
   * Default speech speed multiplier (0.5 - 2.0)
   * 1.0 = normal speed
   */
  defaultSpeed: number = 1.0;

  /**
   * Default pitch adjustment in semitones (-20 to 20)
   * 0 = no adjustment
   */
  defaultPitch: number = 0;

  /**
   * Voice profile status
   * - pending: Profile created but voice not yet generated
   * - processing: Voice generation/cloning in progress
   * - ready: Voice is ready for use
   * - failed: Voice generation failed
   */
  status: VoiceProfileStatus = 'pending';

  /**
   * TTS provider that created/manages this voice
   */
  provider: string = 'qwen3-tts';

  /**
   * Error message if status is 'failed'
   */
  errorMessage: string | null = null;

  constructor(options: VoiceProfileOptions = {}) {
    super(options);

    if (options.name !== undefined) this.name = options.name;
    if (options.description !== undefined)
      this.description = options.description;
    if (options.language !== undefined) this.language = options.language;
    if (options.gender !== undefined) this.gender = options.gender;
    if (options.designPrompt !== undefined)
      this.designPrompt = options.designPrompt;
    if (options.sampleAssetId !== undefined)
      this.sampleAssetId = options.sampleAssetId;
    if (options.voiceData !== undefined) this.voiceData = options.voiceData;
    if (options.defaultSpeed !== undefined)
      this.defaultSpeed = options.defaultSpeed;
    if (options.defaultPitch !== undefined)
      this.defaultPitch = options.defaultPitch;
    if (options.status !== undefined) this.status = options.status;
    if (options.provider !== undefined) this.provider = options.provider;
    if (options.errorMessage !== undefined)
      this.errorMessage = options.errorMessage;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
  }

  /**
   * Check if this voice profile uses voice cloning
   */
  get isCloned(): boolean {
    return this.sampleAssetId !== null;
  }

  /**
   * Check if this voice profile uses voice design
   */
  get isDesigned(): boolean {
    return this.designPrompt !== null && !this.isCloned;
  }

  /**
   * Check if the voice is ready for use
   */
  get isReady(): boolean {
    return this.status === 'ready';
  }

  /**
   * Check if this is a global (default) voice
   */
  get isGlobal(): boolean {
    return this.tenantId === null;
  }
}
