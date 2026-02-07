/**
 * VideoShot Model
 *
 * The atomic video generation unit. One or more characters + one scene + one pipeline run.
 * This is what ComfyUI produces. Maps to Remotion <Sequence><Video /></Sequence>.
 *
 * Design principle: store frames, compute seconds. seconds = frames / fps.
 */

import { Content, type ContentOptions } from '@happyvertical/smrt-content';
import { foreignKey, smrt } from '@happyvertical/smrt-core';
import { TenantScoped } from '@happyvertical/smrt-tenancy';
import type { WordTiming } from '@happyvertical/smrt-voice';
import { Scene } from './scene.js';
import { VideoSequence } from './video-sequence.js';

/**
 * Video shot status
 */
export type VideoShotStatus =
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
  /** Actual duration in seconds */
  duration?: number;

  /** Video resolution (e.g., "1920x1080") */
  resolution?: string;

  /** Aspect ratio (e.g., "16:9", "9:16") */
  aspectRatio?: string;

  /** Video codec (e.g., "h264", "h265") */
  codec?: string;

  /** Frames per second */
  fps?: number;

  /** File size in bytes */
  fileSize?: number;

  /** Word timing data from TTS for lip-sync */
  wordTimings?: WordTiming[];

  /** ComfyUI prompt ID for tracking */
  comfyPromptId?: string;
}

/**
 * Video shot creation options
 */
export interface VideoShotOptions extends ContentOptions {
  /** Sequence this shot belongs to (nullable — shots can exist standalone) */
  sequenceId?: string | null;

  /** Scene for this shot (nullable) */
  sceneId?: string | null;

  /** Order within sequence */
  position?: number;

  /** Actual frame count of generated clip */
  durationInFrames?: number;

  /** Frames to skip at start (overlap handling) */
  trimBeforeFrames?: number;

  /** Frames to skip at end */
  trimAfterFrames?: number;

  /** Script text to be spoken */
  scriptText?: string;

  /** Word count in the script */
  scriptWordCount?: number;

  /** Target duration in seconds */
  targetDuration?: number;

  /** Video generation status */
  shotStatus?: VideoShotStatus;

  /** Generation progress (0-100) */
  progress?: number;

  /** Error message if status is 'failed' */
  errorMessage?: string | null;

  /** Detailed status message for progress tracking */
  statusMessage?: string | null;

  /** Video metadata */
  videoMetadata?: VideoMetadata;
}

/**
 * Atomic video generation unit
 *
 * VideoShot represents a single pipeline run producing one video clip.
 * It can belong to a VideoSequence (for multi-segment long videos) or
 * exist standalone. Characters are linked via the VideoShotCharacter join model.
 *
 * @example
 * ```typescript
 * import { VideoShot } from '@happyvertical/smrt-video';
 *
 * const shot = new VideoShot({
 *   scriptText: 'Welcome to the evening news.',
 *   targetDuration: 30,
 *   title: 'Evening News - Opening',
 * });
 * await shot.save();
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
export class VideoShot extends Content {
  /** Sequence this shot belongs to */
  @foreignKey(() => VideoSequence)
  sequenceId: string | null = null;

  /** Scene for this shot */
  @foreignKey(() => Scene)
  sceneId: string | null = null;

  /** Order within sequence */
  position: number = 0;

  /** Actual frame count of generated clip */
  durationInFrames: number = 0;

  /** Frames to skip at start (overlap handling) */
  trimBeforeFrames: number = 0;

  /** Frames to skip at end */
  trimAfterFrames: number = 0;

  /** Script text to be spoken */
  scriptText: string = '';

  /** Word count in the script */
  scriptWordCount: number = 0;

  /** Target duration in seconds */
  targetDuration: number = 30;

  /** Video generation status */
  shotStatus: VideoShotStatus = 'draft';

  /** Generation progress (0-100) */
  progress: number = 0;

  /** Error message if status is 'failed' */
  errorMessage: string | null = null;

  /** Detailed status message for progress tracking */
  statusMessage: string | null = null;

  /** Video metadata (duration, resolution, etc.) */
  videoMetadata: VideoMetadata = {};

  constructor(options: VideoShotOptions = {}) {
    super({
      ...options,
      type: 'video-shot',
    });

    if (options.sequenceId !== undefined) this.sequenceId = options.sequenceId;
    if (options.sceneId !== undefined) this.sceneId = options.sceneId;
    if (options.position !== undefined) this.position = options.position;
    if (options.durationInFrames !== undefined)
      this.durationInFrames = options.durationInFrames;
    if (options.trimBeforeFrames !== undefined)
      this.trimBeforeFrames = options.trimBeforeFrames;
    if (options.trimAfterFrames !== undefined)
      this.trimAfterFrames = options.trimAfterFrames;
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
    if (options.shotStatus !== undefined) this.shotStatus = options.shotStatus;
    if (options.progress !== undefined) this.progress = options.progress;
    if (options.errorMessage !== undefined)
      this.errorMessage = options.errorMessage;
    if (options.statusMessage !== undefined)
      this.statusMessage = options.statusMessage;
    if (options.videoMetadata !== undefined)
      this.videoMetadata = options.videoMetadata;
  }

  /** Estimate speech duration based on word count (2.7 words/sec) */
  get estimatedDuration(): number {
    return this.scriptWordCount / 2.7;
  }

  /** Check if the script length matches target duration (+/- 15%) */
  get isScriptLengthValid(): boolean {
    const estimated = this.estimatedDuration;
    const tolerance = this.targetDuration * 0.15;
    return (
      estimated >= this.targetDuration - tolerance &&
      estimated <= this.targetDuration + tolerance
    );
  }

  /** Get the recommended word count for target duration */
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

  /** Effective frame count after trimming */
  get effectiveFrames(): number {
    return Math.max(
      0,
      this.durationInFrames - this.trimBeforeFrames - this.trimAfterFrames,
    );
  }

  /** Check if video generation is in progress */
  get isGenerating(): boolean {
    return this.shotStatus === 'queued' || this.shotStatus === 'processing';
  }

  /** Check if video is ready for publishing */
  get isReady(): boolean {
    return this.shotStatus === 'ready';
  }

  /** Update script text and recalculate word count */
  setScript(text: string): void {
    this.scriptText = text;
    this.scriptWordCount = text.split(/\s+/).filter(Boolean).length;
  }
}
