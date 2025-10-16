/**
 * AssetType model - Defines the high-level type of an asset
 *
 * Lookup table for asset type classification (e.g., 'image', 'video', 'document')
 */

import { SmrtObject, smrt } from '@have/smrt';
import type { AssetTypeOptions } from './types';

@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create'] },
  cli: true,
})
export class AssetType extends SmrtObject {
  slug = ''; // Primary key (human-readable identifier, e.g., 'image', 'video')
  name = ''; // Display name (e.g., 'Image', 'Video')
  description = ''; // Optional description

  constructor(options: AssetTypeOptions = {}) {
    super(options);
    if (options.slug) this.slug = options.slug;
    if (options.name) this.name = options.name;
    if (options.description) this.description = options.description;
  }

  /**
   * Get asset type by slug
   *
   * @param slug - The slug to search for
   * @returns AssetType instance or null
   */
  static async getBySlug(slug: string): Promise<AssetType | null> {
    // Will be auto-implemented by SMRT
    return null;
  }
}
