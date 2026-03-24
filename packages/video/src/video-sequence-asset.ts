/**
 * VideoSequenceAsset - legacy STI asset subclass for VideoSequence-owned assets
 *
 * @deprecated VideoSequence now uses inherited Content asset helpers backed by
 * `content_assets`. This legacy subtype remains readable during migration.
 */

import { Asset, type AssetOptions } from '@happyvertical/smrt-assets';
import { foreignKey, smrt } from '@happyvertical/smrt-core';
import { VideoSequence } from './video-sequence.js';

/** Roles a video sequence asset can play */
export type VideoSequenceAssetRole = 'video' | 'audio' | 'thumbnail';

export interface VideoSequenceAssetOptions extends AssetOptions {
  /** VideoSequence this asset belongs to */
  videoSequenceId?: string | null;
  /** Role of this asset for the sequence */
  role?: VideoSequenceAssetRole;
}

@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class VideoSequenceAsset extends Asset {
  @foreignKey(() => VideoSequence)
  videoSequenceId: string | null = null;

  role: VideoSequenceAssetRole = 'video';

  constructor(options: VideoSequenceAssetOptions = {}) {
    super(options);
    if (options.videoSequenceId !== undefined)
      this.videoSequenceId = options.videoSequenceId;
    if (options.role !== undefined) this.role = options.role;
  }
}
