/**
 * AssetStatus model - Defines the lifecycle status of an asset
 *
 * Lookup table for asset status classification (e.g., 'draft', 'published', 'archived')
 */

import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import type { AssetStatusOptions } from './types';

@smrt({
  tableStrategy: 'sti',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create'] },
  cli: { skipApiCheck: true },
})
export class AssetStatus extends SmrtObject {
  // slug is inherited as an accessor from SmrtObject
  @field({
    description:
      'The name of this lifecycle stage, such as Draft or Published.',
  })
  name = ''; // Display name (e.g., 'Draft', 'Published')
  @field({
    description: 'Explain when an asset should use this lifecycle stage.',
  })
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
  static async getBySlug(_slug: string): Promise<AssetStatus | null> {
    // Will be auto-implemented by SMRT
    return null;
  }
}
