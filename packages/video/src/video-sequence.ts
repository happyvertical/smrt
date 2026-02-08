/**
 * VideoSequence Model
 *
 * A thematic section of a video: "top story", "weather", "interview".
 * Groups VideoShots. Maps to Remotion <TransitionSeries.Sequence>.
 *
 * Design principle: store frames, compute seconds. seconds = frames / fps.
 */

import { Content, type ContentOptions } from '@happyvertical/smrt-content';
import { foreignKey, smrt } from '@happyvertical/smrt-core';
import { TenantScoped } from '@happyvertical/smrt-tenancy';

/**
 * Transition type to the next sequence
 */
export type TransitionType = 'none' | 'fade' | 'slide' | 'wipe';

/**
 * VideoSequence creation options
 */
export interface VideoSequenceOptions extends ContentOptions {
  /** Composition this sequence belongs to (nullable — can exist standalone) */
  compositionId?: string | null;

  /** Order within composition */
  position?: number;

  /** Computed duration: sum of shot frames */
  durationInFrames?: number;

  /** Transition type to the next sequence */
  transitionType?: TransitionType;

  /** Overlap frames with next sequence for transition */
  transitionDurationFrames?: number;
}

/**
 * Thematic section of a video composition
 *
 * VideoSequence groups VideoShots into a logical section. It can belong
 * to a VideoComposition or exist standalone (e.g., during long-video generation).
 *
 * @example
 * ```typescript
 * import { VideoSequence } from '@happyvertical/smrt-video';
 *
 * const sequence = new VideoSequence({
 *   title: 'Top Story',
 *   position: 0,
 *   transitionType: 'fade',
 *   transitionDurationFrames: 15,
 * });
 * await sequence.save();
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
export class VideoSequence extends Content {
  /** Composition this sequence belongs to */
  @foreignKey('VideoComposition')
  compositionId: string | null = null;

  /** Order within composition */
  position: number = 0;

  /** Computed duration: sum of shot frames */
  durationInFrames: number = 0;

  /** Transition type to the next sequence */
  transitionType: TransitionType = 'none';

  /** Overlap frames with next sequence for transition */
  transitionDurationFrames: number = 0;

  constructor(options: VideoSequenceOptions = {}) {
    super({
      ...options,
      type: 'video-sequence',
    });

    if (options.compositionId !== undefined)
      this.compositionId = options.compositionId;
    if (options.position !== undefined) this.position = options.position;
    if (options.durationInFrames !== undefined)
      this.durationInFrames = options.durationInFrames;
    if (options.transitionType !== undefined)
      this.transitionType = options.transitionType;
    if (options.transitionDurationFrames !== undefined)
      this.transitionDurationFrames = options.transitionDurationFrames;
  }
}
