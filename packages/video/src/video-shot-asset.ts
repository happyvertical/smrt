/**
 * VideoShotAsset - STI asset subclass for VideoShot-owned assets
 */

import { Asset, type AssetOptions } from '@happyvertical/smrt-assets';
import { foreignKey, smrt } from '@happyvertical/smrt-core';
import { VideoShot } from './video-shot.js';

/** Roles a video shot asset can play */
export type VideoShotAssetRole = 'video' | 'audio' | 'thumbnail';

export interface VideoShotAssetOptions extends AssetOptions {
  /** VideoShot this asset belongs to */
  videoShotId?: string | null;
  /** Role of this asset for the shot */
  role?: VideoShotAssetRole;
}

@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class VideoShotAsset extends Asset {
  @foreignKey(() => VideoShot)
  videoShotId: string | null = null;

  role: VideoShotAssetRole = 'video';

  constructor(options: VideoShotAssetOptions = {}) {
    super(options);
    if (options.videoShotId !== undefined)
      this.videoShotId = options.videoShotId;
    if (options.role !== undefined) this.role = options.role;
  }
}
