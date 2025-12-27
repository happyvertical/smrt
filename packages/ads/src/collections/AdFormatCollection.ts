/**
 * AdFormatCollection - Collection manager for AdFormat objects
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { AdFormat } from '../models/AdFormat.js';
import { AdFormatType } from '../types/index.js';

export class AdFormatCollection extends SmrtCollection<AdFormat> {
  static readonly _itemClass = AdFormat;

  /**
   * Find format by dimensions
   *
   * @param width - Width in pixels
   * @param height - Height in pixels
   * @returns Matching format or null
   */
  async findByDimensions(
    width: number,
    height: number,
  ): Promise<AdFormat | null> {
    const results = await this.list({
      where: { width, height },
      limit: 1,
    });
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Find formats by type
   *
   * @param formatType - Format type (banner, native, video)
   * @returns Array of matching formats
   */
  async findByType(formatType: AdFormatType): Promise<AdFormat[]> {
    return await this.list({
      where: { formatType },
      orderBy: 'name ASC',
    });
  }

  /**
   * Find all banner formats
   */
  async findBanners(): Promise<AdFormat[]> {
    return await this.findByType(AdFormatType.BANNER);
  }

  /**
   * Find all native formats
   */
  async findNative(): Promise<AdFormat[]> {
    return await this.findByType(AdFormatType.NATIVE);
  }

  /**
   * Find all video formats
   */
  async findVideo(): Promise<AdFormat[]> {
    return await this.findByType(AdFormatType.VIDEO);
  }
}
