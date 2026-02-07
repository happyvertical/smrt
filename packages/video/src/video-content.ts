/**
 * VideoContent - DEPRECATED
 *
 * Use VideoShot instead. This module re-exports VideoShot as VideoContent
 * for backwards compatibility.
 *
 * @deprecated Use {@link VideoShot} from './video-shot.js' instead.
 */

export {
  type VideoMetadata,
  VideoShot as VideoContent,
  type VideoShotOptions as VideoContentOptions,
  type VideoShotStatus as VideoContentStatus,
} from './video-shot.js';
