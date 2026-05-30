/**
 * Voice Sample Model
 *
 * Manages audio samples used for voice cloning.
 * Samples should be at least 3 seconds of clear speech.
 */

import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import {
  crossPackageRef,
  foreignKey,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { VoiceProfile } from './voice-profile.js';

/**
 * Audio sample quality rating
 */
export type SampleQuality = 'low' | 'medium' | 'high';

/**
 * Voice sample creation options
 */
export interface VoiceSampleOptions extends SmrtObjectOptions {
  /**
   * Voice profile this sample belongs to
   */
  voiceProfileId?: string | null;

  /**
   * Asset ID of the audio file
   */
  assetId?: string | null;

  /**
   * Sample duration in seconds
   */
  duration?: number;

  /**
   * Transcription of what was said in the sample
   */
  transcription?: string | null;

  /**
   * Quality rating based on audio analysis
   * @default 'medium'
   */
  quality?: SampleQuality;

  /**
   * Sample rate in Hz (e.g., 44100, 48000)
   */
  sampleRate?: number | null;

  /**
   * Number of audio channels (1 = mono, 2 = stereo)
   */
  channels?: number | null;

  /**
   * Audio format (e.g., 'wav', 'mp3', 'ogg')
   */
  format?: string | null;

  /**
   * Whether this is the primary sample for the voice profile
   * @default false
   */
  isPrimary?: boolean;

  /**
   * Tenant ID for multi-tenant isolation
   */
  tenantId?: string | null;
}

/**
 * Audio sample for voice cloning
 *
 * VoiceSample represents an audio recording used as source material
 * for voice cloning. For best results, samples should be:
 * - At least 3 seconds long
 * - Clear speech without background noise
 * - Single speaker only
 * - High quality (44.1kHz or higher)
 *
 * Multiple samples can be associated with a single VoiceProfile
 * to improve voice cloning quality.
 *
 * @example
 * ```typescript
 * import { VoiceSample } from '@happyvertical/smrt-voice';
 *
 * const sample = new VoiceSample({
 *   voiceProfileId: 'voice-123',
 *   assetId: 'asset-456',
 *   duration: 5.2,
 *   transcription: 'Hello, this is a test recording for voice cloning.',
 *   quality: 'high',
 *   sampleRate: 48000,
 *   channels: 1,
 *   format: 'wav',
 *   isPrimary: true,
 * });
 * ```
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  tableStrategy: 'sti',
  api: {
    include: ['list', 'get', 'create', 'delete'],
  },
  mcp: {
    include: ['list', 'get'],
  },
  cli: true,
})
export class VoiceSample extends SmrtObject {
  /**
   * Tenant ID for multi-tenant isolation
   */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * Voice profile this sample belongs to
   */
  @foreignKey(() => VoiceProfile)
  voiceProfileId: string | null = null;

  /**
   * Asset ID of the audio file
   * References an Asset in smrt-assets
   */
  @crossPackageRef('@happyvertical/smrt-assets:Asset')
  assetId: string | null = null;

  /**
   * Sample duration in seconds
   */
  duration: number = 0;

  /**
   * Transcription of what was said in the sample
   * Used for alignment and quality verification
   */
  transcription: string | null = null;

  /**
   * Quality rating based on audio analysis
   * - low: Noisy or short samples
   * - medium: Acceptable quality
   * - high: Clear audio, good length
   */
  quality: SampleQuality = 'medium';

  /**
   * Sample rate in Hz
   */
  sampleRate: number | null = null;

  /**
   * Number of audio channels
   */
  channels: number | null = null;

  /**
   * Audio format
   */
  format: string | null = null;

  /**
   * Whether this is the primary sample for the voice profile
   */
  isPrimary: boolean = false;

  constructor(options: VoiceSampleOptions = {}) {
    super(options);

    if (options.voiceProfileId !== undefined)
      this.voiceProfileId = options.voiceProfileId;
    if (options.assetId !== undefined) this.assetId = options.assetId;
    if (options.duration !== undefined) this.duration = options.duration;
    if (options.transcription !== undefined)
      this.transcription = options.transcription;
    if (options.quality !== undefined) this.quality = options.quality;
    if (options.sampleRate !== undefined) this.sampleRate = options.sampleRate;
    if (options.channels !== undefined) this.channels = options.channels;
    if (options.format !== undefined) this.format = options.format;
    if (options.isPrimary !== undefined) this.isPrimary = options.isPrimary;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
  }

  /**
   * Check if sample meets minimum duration requirement (3 seconds)
   */
  get meetsMinDuration(): boolean {
    return this.duration >= 3;
  }

  /**
   * Check if sample is high quality and suitable for cloning
   */
  get isSuitableForCloning(): boolean {
    return this.meetsMinDuration && this.quality !== 'low';
  }
}
