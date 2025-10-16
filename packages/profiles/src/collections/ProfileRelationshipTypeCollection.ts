/**
 * ProfileRelationshipTypeCollection - Collection manager for ProfileRelationshipType objects
 *
 * Provides querying for relationship type lookup table.
 */

import { SmrtCollection } from '@have/smrt';
import { ProfileRelationshipType } from '../models/ProfileRelationshipType';

export class ProfileRelationshipTypeCollection extends SmrtCollection<ProfileRelationshipType> {
  static readonly _itemClass = ProfileRelationshipType;

  /**
   * Get relationship type by slug
   *
   * @param slug - The slug to search for
   * @returns ProfileRelationshipType instance or null
   */
  async getBySlug(slug: string): Promise<ProfileRelationshipType | null> {
    return await this.get({ slug });
  }

  /**
   * Get or create a relationship type by slug
   *
   * @param slug - The slug to search for
   * @param defaults - Default values if creating
   * @returns ProfileRelationshipType instance
   */
  async getOrCreateBySlug(
    slug: string,
    defaults: { name: string; reciprocal?: boolean },
  ): Promise<ProfileRelationshipType> {
    const existing = await this.getBySlug(slug);
    if (existing) return existing;

    const relationshipType = await this.create({ slug, ...defaults });
    await relationshipType.save();
    return relationshipType;
  }

  /**
   * Get all reciprocal relationship types
   *
   * @returns Array of reciprocal ProfileRelationshipType instances
   */
  async getReciprocal(): Promise<ProfileRelationshipType[]> {
    return await this.list({ where: { reciprocal: true } });
  }

  /**
   * Get all directional (non-reciprocal) relationship types
   *
   * @returns Array of directional ProfileRelationshipType instances
   */
  async getDirectional(): Promise<ProfileRelationshipType[]> {
    return await this.list({ where: { reciprocal: false } });
  }
}
