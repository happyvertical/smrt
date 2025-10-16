/**
 * PlaceType model - Defines types/categories of places
 *
 * Examples: 'country', 'city', 'building', 'zone', 'room', 'region'
 */

import { SmrtObject, type SmrtObjectOptions, smrt } from '@have/smrt';
import type { PlaceTypeOptions } from '../types';

@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create'] },
  cli: true,
})
export class PlaceType extends SmrtObject {
  // id and slug are inherited from SmrtObject
  // name is also inherited from SmrtObject
  description = ''; // Optional description

  // Timestamps
  createdAt = new Date();
  updatedAt = new Date();

  constructor(options: PlaceTypeOptions = {}) {
    super(options);
    if (options.description !== undefined)
      this.description = options.description;
    if (options.createdAt) this.createdAt = options.createdAt;
    if (options.updatedAt) this.updatedAt = options.updatedAt;
  }

  /**
   * Convenience method for slug-based lookup
   *
   * @param slug - The slug to search for
   * @returns PlaceType instance or null if not found
   */
  static async getBySlug(slug: string): Promise<PlaceType | null> {
    // Will be auto-implemented by SMRT
    return null;
  }
}
