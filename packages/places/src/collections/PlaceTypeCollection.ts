/**
 * PlaceTypeCollection - Collection manager for PlaceType objects
 *
 * Provides simple lookup and creation for place types.
 */

import { SmrtCollection } from '@smrt/core';
import { PlaceType } from '../models/PlaceType';

export class PlaceTypeCollection extends SmrtCollection<PlaceType> {
  static readonly _itemClass = PlaceType;

  /**
   * Get or create a place type by slug
   *
   * @param slug - PlaceType slug (e.g., 'city', 'building')
   * @param name - Optional display name (defaults to capitalized slug)
   * @returns PlaceType instance
   */
  async getOrCreate(slug: string, name?: string): Promise<PlaceType> {
    // First try to find existing type with this slug
    const existing = await this.get({ slug });

    if (existing) {
      return existing;
    }

    // Create new type with auto-generated name if not provided
    const displayName =
      name || slug.replace(/-/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());

    return await this.create({
      slug,
      name: displayName,
    });
  }

  /**
   * Get a place type by slug
   *
   * @param slug - PlaceType slug to search for
   * @returns PlaceType instance or null if not found
   */
  async getBySlug(slug: string): Promise<PlaceType | null> {
    return await this.get({ slug });
  }

  /**
   * Initialize default place types
   *
   * Creates standard types if they don't exist:
   * - country
   * - region (state/province)
   * - city
   * - address
   * - building
   * - room
   * - zone (for abstract/virtual places)
   *
   * @returns Array of created/existing place types
   */
  async initializeDefaults(): Promise<PlaceType[]> {
    const defaults = [
      { slug: 'country', name: 'Country' },
      { slug: 'region', name: 'Region' },
      { slug: 'city', name: 'City' },
      { slug: 'address', name: 'Address' },
      { slug: 'building', name: 'Building' },
      { slug: 'room', name: 'Room' },
      { slug: 'zone', name: 'Zone' },
      { slug: 'point_of_interest', name: 'Point of Interest' },
    ];

    const types: PlaceType[] = [];
    for (const def of defaults) {
      const type = await this.getOrCreate(def.slug, def.name);
      types.push(type);
    }

    return types;
  }
}
