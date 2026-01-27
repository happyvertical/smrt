/**
 * Video Content Model
 *
 * Represents generated video content from AI-powered video production.
 * Extends Content to leverage content management features.
 */

import { Content, type ContentOptions } from '@happyvertical/smrt-content';
import { foreignKey, smrt } from '@happyvertical/smrt-core';
import { TenantScoped } from '@happyvertical/smrt-tenancy';
import type { WordTiming } from '@happyvertical/smrt-voice';
import { PersonalityProfile } from './personality-profile.js';

/**
 * Video content status
 */
export type VideoContentStatus =
  | 'draft'
  | 'queued'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'published';

/**
 * Video metadata
 */
export interface VideoMetadata {
  /**
   * Actual duration in seconds
   */
  duration?: number;

  /**
   * Video resolution (e.g., "1920x1080")
   */
  resolution?: string;

  /**
   * Aspect ratio (e.g., "16:9", "9:16")
   */
  aspectRatio?: string;

  /**
   * Video codec (e.g., "h264", "h265")
   */
  codec?: string;

  /**
   * Frames per second
   */
  fps?: number;

  /**
   * File size in bytes
   */
  fileSize?: number;

  /**
   * Word timing data from TTS for lip-sync
   */
  wordTimings?: WordTiming[];

  /**
   * ComfyUI prompt ID for tracking
   */
  comfyPromptId?: string;
}

/**
 * Video content creation options
 */
export interface VideoContentOptions extends ContentOptions {
  /**
   * Personality profile used for this video
   */
  personalityProfileId?: string | null;

  /**
   * Script text to be spoken
   */
  scriptText?: string;

  /**
   * Word count in the script
   */
  scriptWordCount?: number;

  /**
   * Target duration in seconds
   * @default 30
   */
  targetDuration?: number;

  /**
   * Video generation status
   * @default 'draft'
   */
  videoStatus?: VideoContentStatus;

  /**
   * Generation progress (0-100)
   */
  progress?: number;

  /**
   * Error message if status is 'failed'
   */
  errorMessage?: string | null;

  /**
   * Asset ID of the final video
   */
  videoAssetId?: string | null;

  /**
   * Asset ID of the thumbnail
   */
  thumbnailAssetId?: string | null;

  /**
   * Asset ID of the generated TTS audio
   */
  audioAssetId?: string | null;

  /**
   * Video metadata
   */
  videoMetadata?: VideoMetadata;
}

/**
 * Generated video content from AI-powered production
 *
 * VideoContent extends Content to represent AI-generated video
 * broadcasts. It tracks the generation pipeline status and stores
 * references to generated assets.
 *
 * @example
 * ```typescript
 * import { VideoContent } from '@happyvertical/smrt-video';
 *
 * const video = new VideoContent({
 *   personalityProfileId: 'personality-123',
 *   scriptText: 'Welcome to the evening news. Today we have breaking news from Bentley.',
 *   targetDuration: 30,
 *   title: 'Evening News - January 25, 2026',
 *   description: 'Daily news broadcast for Bentley, Alberta',
 * });
 * await video.save();
 * ```
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  tableStrategy: 'sti',
  api: {
    include: ['list', 'get', 'create', 'update', 'delete'],
  },
  mcp: {
    include: ['list', 'get', 'generate'],
  },
  cli: true,
})
export class VideoContent extends Content {
  /**
   * Personality profile used for this video
   */
  @foreignKey(() => PersonalityProfile)
  personalityProfileId: string | null = null;

  /**
   * Script text to be spoken
   */
  scriptText: string = '';

  /**
   * Word count in the script
   */
  scriptWordCount: number = 0;

  /**
   * Target duration in seconds
   */
  targetDuration: number = 30;

  /**
   * Video generation status
   */
  videoStatus: VideoContentStatus = 'draft';

  /**
   * Generation progress (0-100)
   */
  progress: number = 0;

  /**
   * Error message if status is 'failed'
   */
  errorMessage: string | null = null;

  /**
   * Asset ID of the final video
   */
  videoAssetId: string | null = null;

  /**
   * Asset ID of the generated TTS audio
   */
  audioAssetId: string | null = null;

  /**
   * Video metadata (duration, resolution, etc.)
   */
  videoMetadata: VideoMetadata = {};

  constructor(options: VideoContentOptions = {}) {
    super({
      ...options,
      type: 'video-content',
    });

    if (options.personalityProfileId !== undefined)
      this.personalityProfileId = options.personalityProfileId;
    if (options.scriptText !== undefined) {
      this.scriptText = options.scriptText;
      this.scriptWordCount = this.scriptText
        .split(/\s+/)
        .filter(Boolean).length;
    }
    if (options.scriptWordCount !== undefined)
      this.scriptWordCount = options.scriptWordCount;
    if (options.targetDuration !== undefined)
      this.targetDuration = options.targetDuration;
    if (options.videoStatus !== undefined)
      this.videoStatus = options.videoStatus;
    if (options.progress !== undefined) this.progress = options.progress;
    if (options.errorMessage !== undefined)
      this.errorMessage = options.errorMessage;
    if (options.videoAssetId !== undefined)
      this.videoAssetId = options.videoAssetId;
    if (options.thumbnailAssetId !== undefined)
      this.thumbnailAssetId = options.thumbnailAssetId;
    if (options.audioAssetId !== undefined)
      this.audioAssetId = options.audioAssetId;
    if (options.videoMetadata !== undefined)
      this.videoMetadata = options.videoMetadata;
  }

  /**
   * Estimate speech duration based on word count
   * Uses 2.7 words per second as average speaking rate
   */
  get estimatedDuration(): number {
    return this.scriptWordCount / 2.7;
  }

  /**
   * Check if the script length matches target duration
   * Tolerance: +/- 15%
   */
  get isScriptLengthValid(): boolean {
    const estimated = this.estimatedDuration;
    const tolerance = this.targetDuration * 0.15;
    return (
      estimated >= this.targetDuration - tolerance &&
      estimated <= this.targetDuration + tolerance
    );
  }

  /**
   * Get the recommended word count for target duration
   */
  get recommendedWordCount(): { min: number; max: number; target: number } {
    const wordsPerSecond = 2.7;
    const target = Math.round(this.targetDuration * wordsPerSecond);
    const tolerance = Math.round(target * 0.15);
    return {
      min: target - tolerance,
      max: target + tolerance,
      target,
    };
  }

  /**
   * Check if video generation is in progress
   */
  get isGenerating(): boolean {
    return this.videoStatus === 'queued' || this.videoStatus === 'processing';
  }

  /**
   * Check if video is ready for publishing
   */
  get isReady(): boolean {
    return this.videoStatus === 'ready' && this.videoAssetId !== null;
  }

  /**
   * Update script text and recalculate word count
   */
  setScript(text: string): void {
    this.scriptText = text;
    this.scriptWordCount = text.split(/\s+/).filter(Boolean).length;
  }
}
