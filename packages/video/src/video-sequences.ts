/**
 * VideoSequenceCollection - Collection manager for VideoSequence instances
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { VideoSequence } from './video-sequence.js';

export class VideoSequenceCollection extends SmrtCollection<VideoSequence> {
  static readonly _itemClass = VideoSequence;

  /** Find sequences belonging to a composition, ordered by position */
  async findByComposition(compositionId: string): Promise<VideoSequence[]> {
    return (await this.list({
      where: { compositionId },
      orderBy: 'position ASC',
    })) as VideoSequence[];
  }

  /** Find standalone sequences (not in any composition) */
  async findStandalone(): Promise<VideoSequence[]> {
    return (await this.list({
      where: { compositionId: null },
    })) as VideoSequence[];
  }
}
