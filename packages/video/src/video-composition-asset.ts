/**
 * VideoCompositionAsset - STI asset subclass for VideoComposition-owned assets
 */

import { Asset, type AssetOptions } from '@happyvertical/smrt-assets';
import { foreignKey, smrt } from '@happyvertical/smrt-core';
import { VideoComposition } from './video-composition.js';

/** Roles a video composition asset can play */
export type VideoCompositionAssetRole = 'video' | 'audio' | 'thumbnail';

export interface VideoCompositionAssetOptions extends AssetOptions {
  /** VideoComposition this asset belongs to */
  videoCompositionId?: string | null;
  /** Role of this asset for the composition */
  role?: VideoCompositionAssetRole;
}

@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class VideoCompositionAsset extends Asset {
  @foreignKey(() => VideoComposition)
  videoCompositionId: string | null = null;

  role: VideoCompositionAssetRole = 'video';

  constructor(options: VideoCompositionAssetOptions = {}) {
    super(options);
    if (options.videoCompositionId !== undefined)
      this.videoCompositionId = options.videoCompositionId;
    if (options.role !== undefined) this.role = options.role;
  }
}
