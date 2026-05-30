/**
 * Voice Output Model
 *
 * Represents generated audio output from text-to-speech synthesis.
 * Extends Content to leverage content management features.
 */

import { Content, type ContentOptions } from '@happyvertical/smrt-content';
import { crossPackageRef, foreignKey, smrt } from '@happyvertical/smrt-core';
import { TenantScoped } from '@happyvertical/smrt-tenancy';
import { VoiceProfile } from './voice-profile.js';

/**
 * Word timing information for lip-sync alignment
 */
export interface WordTiming {
  /**
   * The word
   */
  word: string;

  /**
   * Start time in seconds
   */
  start: number;

  /**
   * End time in seconds
   */
  end: number;
}

/**
 * Voice output metadata
 */
export interface VoiceOutputMetadata {
  /**
   * Sample rate in Hz
   */
  sampleRate?: number;

  /**
   * Audio format (e.g., 'wav', 'mp3', 'ogg')
   */
  format?: string;

  /**
   * Number of audio channels
   */
  channels?: number;

  /**
   * Bit depth (e.g., 16, 24, 32)
   */
  bitDepth?: number;

  /**
   * File size in bytes
   */
  fileSize?: number;

  /**
   * TTS provider used
   */
  provider?: string;

  /**
   * Model used for synthesis
   */
  model?: string;

  /**
   * Speech speed used (1.0 = normal)
   */
  speed?: number;

  /**
   * Pitch adjustment used (semitones)
   */
  pitch?: number;
}

/**
 * Voice output creation options
 */
export interface VoiceOutputOptions extends ContentOptions {
  /**
   * Voice profile used for synthesis
   */
  voiceProfileId?: string | null;

  /**
   * Original text that was synthesized
   */
  sourceText?: string;

  /**
   * Asset ID of the generated audio file
   */
  audioAssetId?: string | null;

  /**
   * Duration of the generated audio in seconds
   */
  duration?: number;

  /**
   * Word-level timing information for lip-sync
   */
  wordTimings?: WordTiming[] | null;

  /**
   * Audio metadata
   */
  audioMetadata?: VoiceOutputMetadata;
}

/**
 * Generated audio output from text-to-speech synthesis
 *
 * VoiceOutput extends Content to represent audio generated from
 * text using a VoiceProfile. It includes word-level timing information
 * for lip-sync alignment in video production.
 *
 * @example
 * ```typescript
 * import { VoiceOutput } from '@happyvertical/smrt-voice';
 *
 * const output = new VoiceOutput({
 *   voiceProfileId: 'voice-123',
 *   sourceText: 'Welcome to the evening news broadcast.',
 *   audioAssetId: 'asset-789',
 *   duration: 3.5,
 *   wordTimings: [
 *     { word: 'Welcome', start: 0.0, end: 0.4 },
 *     { word: 'to', start: 0.4, end: 0.5 },
 *     { word: 'the', start: 0.5, end: 0.6 },
 *     { word: 'evening', start: 0.6, end: 1.0 },
 *     { word: 'news', start: 1.0, end: 1.3 },
 *     { word: 'broadcast', start: 1.3, end: 1.9 },
 *   ],
 *   audioMetadata: {
 *     sampleRate: 48000,
 *     format: 'wav',
 *     channels: 1,
 *     provider: 'qwen3-tts',
 *   },
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
export class VoiceOutput extends Content {
  /**
   * Voice profile used for synthesis
   */
  @foreignKey(() => VoiceProfile)
  voiceProfileId: string | null = null;

  /**
   * Original text that was synthesized
   */
  sourceText: string = '';

  /**
   * Asset ID of the generated audio file
   */
  @crossPackageRef('@happyvertical/smrt-assets:Asset')
  audioAssetId: string | null = null;

  /**
   * Duration of the generated audio in seconds
   */
  duration: number = 0;

  /**
   * Word-level timing information for lip-sync alignment
   */
  wordTimings: WordTiming[] | null = null;

  /**
   * Audio metadata (sample rate, format, etc.)
   */
  audioMetadata: VoiceOutputMetadata = {};

  constructor(options: VoiceOutputOptions = {}) {
    super({
      ...options,
      type: 'voice-output',
    });

    if (options.voiceProfileId !== undefined)
      this.voiceProfileId = options.voiceProfileId;
    if (options.sourceText !== undefined) this.sourceText = options.sourceText;
    if (options.audioAssetId !== undefined)
      this.audioAssetId = options.audioAssetId;
    if (options.duration !== undefined) this.duration = options.duration;
    if (options.wordTimings !== undefined)
      this.wordTimings = options.wordTimings;
    if (options.audioMetadata !== undefined)
      this.audioMetadata = options.audioMetadata;
  }

  /**
   * Get the word count of the source text
   */
  get wordCount(): number {
    return this.sourceText.split(/\s+/).filter(Boolean).length;
  }

  /**
   * Get the average words per second rate
   */
  get wordsPerSecond(): number {
    if (this.duration === 0) return 0;
    return this.wordCount / this.duration;
  }

  /**
   * Check if word timing data is available for lip-sync
   */
  get hasWordTimings(): boolean {
    return this.wordTimings !== null && this.wordTimings.length > 0;
  }

  /**
   * Get the word at a specific timestamp
   */
  getWordAtTime(seconds: number): WordTiming | null {
    if (!this.wordTimings) return null;
    return (
      this.wordTimings.find((wt) => seconds >= wt.start && seconds < wt.end) ??
      null
    );
  }
}
