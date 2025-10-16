/**
 * ProfileTypeCollection - Collection manager for ProfileType objects
 *
 * Provides querying for profile type lookup table.
 */

import { SmrtCollection } from '@smrt/core';
import { ProfileType } from '../models/ProfileType';

export class ProfileTypeCollection extends SmrtCollection<ProfileType> {
  static readonly _itemClass = ProfileType;

  /**
   * Get profile type by slug
   *
   * @param slug - The slug to search for
   * @returns ProfileType instance or null
   */
  async getBySlug(slug: string): Promise<ProfileType | null> {
    return await this.get({ slug });
  }

  /**
   * Get or create a profile type by slug
   *
   * @param slug - The slug to search for
   * @param defaults - Default values if creating
   * @returns ProfileType instance
   */
  async getOrCreateBySlug(
    slug: string,
    defaults: { name: string; description?: string },
  ): Promise<ProfileType> {
    const existing = await this.getBySlug(slug);
    if (existing) return existing;

    const profileType = await this.create({ slug, ...defaults });
    await profileType.save();
    return profileType;
  }
}
