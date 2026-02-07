/**
 * VideoComposition Model
 *
 * The publishable output. Defines render spec (fps, width, height).
 * Contains ordered sequences with optional transitions between them.
 * Maps to Remotion <Composition /> + <TransitionSeries>.
 *
 * Design principle: store frames, compute seconds. seconds = frames / fps.
 */

import { Content, type ContentOptions } from '@happyvertical/smrt-content';
import { smrt } from '@happyvertical/smrt-core';
import { TenantScoped } from '@happyvertical/smrt-tenancy';

/**
 * Render status for the composition
 */
export type RenderStatus = 'draft' | 'rendering' | 'ready' | 'failed';

/**
 * VideoComposition creation options
 */
export interface VideoCompositionOptions extends ContentOptions {
  /** Frames per second (e.g., 30) — everything downstream is in frames */
  fps?: number;

  /** Render width in pixels */
  width?: number;

  /** Render height in pixels */
  height?: number;

  /** Computed total: sum of sequences minus transition overlaps */
  durationInFrames?: number;

  /** Render status */
  renderStatus?: RenderStatus;

  /** Render progress (0-100) */
  renderProgress?: number;
}

/**
 * Publishable video composition
 *
 * VideoComposition is the top-level container for a rendered video.
 * It defines the render spec and contains ordered VideoSequences.
 *
 * @example
 * ```typescript
 * import { VideoComposition } from '@happyvertical/smrt-video';
 *
 * const composition = new VideoComposition({
 *   title: 'Evening News - January 25, 2026',
 *   fps: 30,
 *   width: 1920,
 *   height: 1080,
 * });
 * await composition.save();
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
export class VideoComposition extends Content {
  /** Frames per second — everything downstream is in frames */
  fps: number = 30;

  /** Render width in pixels */
  width: number = 1920;

  /** Render height in pixels */
  height: number = 1080;

  /** Computed total: sum of sequences minus transition overlaps */
  durationInFrames: number = 0;

  /** Render status */
  renderStatus: RenderStatus = 'draft';

  /** Render progress (0-100) */
  renderProgress: number = 0;

  constructor(options: VideoCompositionOptions = {}) {
    super({
      ...options,
      type: 'video-composition',
    });

    if (options.fps !== undefined) this.fps = options.fps;
    if (options.width !== undefined) this.width = options.width;
    if (options.height !== undefined) this.height = options.height;
    if (options.durationInFrames !== undefined)
      this.durationInFrames = options.durationInFrames;
    if (options.renderStatus !== undefined)
      this.renderStatus = options.renderStatus;
    if (options.renderProgress !== undefined)
      this.renderProgress = options.renderProgress;
  }

  /** Duration in seconds */
  get durationInSeconds(): number {
    if (this.fps === 0) return 0;
    return this.durationInFrames / this.fps;
  }

  /** Check if the composition is ready for publishing */
  get isReady(): boolean {
    return this.renderStatus === 'ready';
  }

  /** Check if the composition is currently rendering */
  get isRendering(): boolean {
    return this.renderStatus === 'rendering';
  }
}
