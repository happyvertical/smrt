/**
 * VideoShotCollection - Collection manager for VideoShot instances
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { VideoShot, type VideoShotStatus } from './video-shot.js';

export class VideoShotCollection extends SmrtCollection<VideoShot> {
  static readonly _itemClass = VideoShot;

  /** Find shots belonging to a specific sequence, ordered by position */
  async findBySequence(sequenceId: string): Promise<VideoShot[]> {
    return (await this.list({
      where: { sequenceId },
      orderBy: 'position ASC',
    })) as VideoShot[];
  }

  /** Find shots by status */
  async findByStatus(shotStatus: VideoShotStatus): Promise<VideoShot[]> {
    return (await this.list({ where: { shotStatus } })) as VideoShot[];
  }

  /** Find standalone shots (not in any sequence) */
  async findStandalone(): Promise<VideoShot[]> {
    return (await this.list({ where: { sequenceId: null } })) as VideoShot[];
  }
}
