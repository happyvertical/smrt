/**
 * ProfileMetafieldCollection - Collection manager for ProfileMetafield objects
 *
 * Provides querying for profile metafield lookup table.
 */

import { SmrtCollection } from '@smrt/core';
import { ProfileMetafield } from '../models/ProfileMetafield';
import type { ValidationSchema } from '../types';

export class ProfileMetafieldCollection extends SmrtCollection<ProfileMetafield> {
  static readonly _itemClass = ProfileMetafield;

  /**
   * Get metafield by slug
   *
   * @param slug - The slug to search for
   * @returns ProfileMetafield instance or null
   */
  async getBySlug(slug: string): Promise<ProfileMetafield | null> {
    return await this.get({ slug });
  }

  /**
   * Get or create a metafield by slug
   *
   * @param slug - The slug to search for
   * @param defaults - Default values if creating
   * @returns ProfileMetafield instance
   */
  async getOrCreateBySlug(
    slug: string,
    defaults: {
      name: string;
      description?: string;
      validation?: ValidationSchema;
    },
  ): Promise<ProfileMetafield> {
    const existing = await this.getBySlug(slug);
    if (existing) return existing;

    const metafield = await this.create({ slug, ...defaults });
    await metafield.save();
    return metafield;
  }
}
