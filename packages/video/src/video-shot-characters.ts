/**
 * VideoShotCharacterCollection - Collection manager for VideoShotCharacter instances
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { VideoShotCharacter } from './video-shot-character.js';

export class VideoShotCharacterCollection extends SmrtCollection<VideoShotCharacter> {
  static readonly _itemClass = VideoShotCharacter;

  /** Find all character links for a shot, ordered by position */
  async findByShot(videoShotId: string): Promise<VideoShotCharacter[]> {
    return (await this.list({
      where: { videoShotId },
      orderBy: 'position ASC',
    })) as VideoShotCharacter[];
  }

  /** Find all shot links for a character */
  async findByCharacter(characterId: string): Promise<VideoShotCharacter[]> {
    return (await this.list({
      where: { characterId },
    })) as VideoShotCharacter[];
  }
}
