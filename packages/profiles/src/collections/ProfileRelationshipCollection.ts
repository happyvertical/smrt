/**
 * ProfileRelationshipCollection - Collection manager for ProfileRelationship objects
 *
 * Provides querying for relationships between profiles.
 */

import { SmrtCollection } from '@smrt/core';
import { ProfileRelationship } from '../models/ProfileRelationship';

export class ProfileRelationshipCollection extends SmrtCollection<ProfileRelationship> {
  static readonly _itemClass = ProfileRelationship;

  /**
   * Get all relationships from a profile
   *
   * @param fromProfileId - The origin profile UUID
   * @param typeId - Optional filter by relationship type UUID
   * @returns Array of ProfileRelationship instances
   */
  async getFromProfile(
    fromProfileId: string,
    typeId?: string,
  ): Promise<ProfileRelationship[]> {
    const where: any = { fromProfileId };
    if (typeId) where.typeId = typeId;

    return await this.list({ where });
  }

  /**
   * Get all relationships to a profile
   *
   * @param toProfileId - The target profile UUID
   * @param typeId - Optional filter by relationship type UUID
   * @returns Array of ProfileRelationship instances
   */
  async getToProfile(
    toProfileId: string,
    typeId?: string,
  ): Promise<ProfileRelationship[]> {
    const where: any = { toProfileId };
    if (typeId) where.typeId = typeId;

    return await this.list({ where });
  }

  /**
   * Get all relationships for a profile (both directions)
   *
   * @param profileId - The profile UUID
   * @param typeId - Optional filter by relationship type UUID
   * @returns Array of ProfileRelationship instances
   */
  async getForProfile(
    profileId: string,
    typeId?: string,
  ): Promise<ProfileRelationship[]> {
    const fromRelationships = await this.getFromProfile(profileId, typeId);
    const toRelationships = await this.getToProfile(profileId, typeId);

    return [...fromRelationships, ...toRelationships];
  }

  /**
   * Check if a relationship exists between two profiles
   *
   * @param fromProfileId - The origin profile UUID
   * @param toProfileId - The target profile UUID
   * @param typeId - The relationship type UUID
   * @returns True if relationship exists
   */
  async exists(
    fromProfileId: string,
    toProfileId: string,
    typeId: string,
  ): Promise<boolean> {
    const matches = await this.list({
      where: { fromProfileId, toProfileId, typeId },
      limit: 1,
    });

    return matches.length > 0;
  }
}
