/**
 * ProfileMetadataCollection - Collection manager for ProfileMetadata objects
 *
 * Provides querying and batch operations for profile metadata.
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { ProfileMetadata } from '../models/ProfileMetadata';

export class ProfileMetadataCollection extends SmrtCollection<ProfileMetadata> {
  static readonly _itemClass = ProfileMetadata;

  /**
   * Get all metadata for a profile
   *
   * @param profileId - The profile UUID
   * @returns Array of ProfileMetadata instances
   */
  async getByProfile(profileId: string): Promise<ProfileMetadata[]> {
    return await this.list({ where: { profileId } });
  }

  /**
   * Get metadata as key-value object for a profile
   *
   * @param profileId - The profile UUID
   * @returns Object with metafield slugs as keys
   */
  async getMetadataObject(profileId: string): Promise<Record<string, string>> {
    const metadata = await this.getByProfile(profileId);
    const result: Record<string, string> = {};

    for (const item of metadata) {
      const slug = await item.getMetafieldSlug();
      if (slug) {
        result[slug] = item.value;
      }
    }

    return result;
  }

  /**
   * Find all profiles with a specific metadata key-value pair
   *
   * @param metafieldId - The metafield UUID
   * @param value - The value to match
   * @returns Array of profile UUIDs
   */
  async findProfilesByMetadata(
    metafieldId: string,
    value: unknown,
  ): Promise<string[]> {
    const matches = await this.list({
      where: { metafieldId, value: String(value) },
    });

    return matches
      .map((m) => m.profileId)
      .filter((id) => typeof id === 'string') as string[];
  }
}
