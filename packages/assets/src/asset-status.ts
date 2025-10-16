/**
 * AssetStatus model - Defines the lifecycle status of an asset
 *
 * Lookup table for asset status classification (e.g., 'draft', 'published', 'archived')
 */

import { SmrtObject, smrt } from '@smrt/core';
import type { AssetStatusOptions } from './types';

@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create'] },
  cli: true,
})
export class AssetStatus extends SmrtObject {
  slug = ''; // Primary key (human-readable identifier, e.g., 'draft', 'published')
  name = ''; // Display name (e.g., 'Draft', 'Published')
  description = ''; // Optional description

  constructor(options: AssetStatusOptions = {}) {
    super(options);
    if (options.slug) this.slug = options.slug;
    if (options.name) this.name = options.name;
    if (options.description) this.description = options.description;
  }

  /**
   * Get asset status by slug
   *
   * @param slug - The slug to search for
   * @returns AssetStatus instance or null
   */
  static async getBySlug(slug: string): Promise<AssetStatus | null> {
    // Will be auto-implemented by SMRT
    return null;
  }
}
