/**
 * VideoCompositionCollection - Collection manager for VideoComposition instances
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { VideoComposition } from './video-composition.js';

export class VideoCompositionCollection extends SmrtCollection<VideoComposition> {
  static readonly _itemClass = VideoComposition;

  /** Find compositions by render status */
  async findByRenderStatus(renderStatus: string): Promise<VideoComposition[]> {
    return (await this.list({
      where: { renderStatus },
    })) as VideoComposition[];
  }

  /** Find compositions that are ready for publishing */
  async findReady(): Promise<VideoComposition[]> {
    return (await this.list({
      where: { renderStatus: 'ready' },
    })) as VideoComposition[];
  }
}
