/**
 * ProfileCollection - Collection manager for Profile objects
 *
 * Provides advanced querying and batch operations for Profile entities.
 */

import type { Asset } from '@happyvertical/smrt-assets';
import { SmrtCollection } from '@happyvertical/smrt-core';
import { Profile } from '../models/Profile';

export class ProfileCollection extends SmrtCollection<Profile> {
  static readonly _itemClass = Profile;

  /**
   * Find a profile by email address
   *
   * @param email - The email address to search for
   * @returns The matching profile or null
   */
  async findByEmail(email: string): Promise<Profile | null> {
    const normalizedEmail = email.toLowerCase();
    const profiles = await this.list({
      where: { email: normalizedEmail },
      limit: 1,
    });
    return profiles.length > 0 ? profiles[0] : null;
  }

  /**
   * Find profiles by type slug
   *
   * @param typeSlug - The profile type slug to filter by
   * @returns Array of matching profiles
   */
  async findByType(typeSlug: string): Promise<Profile[]> {
    // Will use eager loading when available
    const allProfiles = await this.list({});

    const filtered: Profile[] = [];
    for (const profile of allProfiles) {
      const slug = await profile.getTypeSlug();
      if (slug === typeSlug) {
        filtered.push(profile);
      }
    }

    return filtered;
  }

  /**
   * Batch get metadata for multiple profiles
   *
   * @param profileIds - Array of profile UUIDs
   * @returns Map of profile ID to metadata object
   */
  async batchGetMetadata(
    profileIds: string[],
  ): Promise<Map<string, Record<string, any>>> {
    const result = new Map<string, Record<string, any>>();

    for (const profileId of profileIds) {
      const profile = await this.get({ id: profileId });
      if (profile) {
        const metadata = await profile.getMetadata();
        result.set(profileId, metadata);
      }
    }

    return result;
  }

  /**
   * Batch update metadata for multiple profiles
   *
   * @param updates - Array of { profileId, data } objects
   */
  async batchUpdateMetadata(
    updates: Array<{ profileId: string; data: Record<string, any> }>,
  ): Promise<void> {
    for (const update of updates) {
      const profile = await this.get({ id: update.profileId });
      if (profile) {
        await profile.updateMetadata(update.data);
      }
    }
  }

  /**
   * Find related profiles for a given profile
   *
   * @param profileId - The profile UUID
   * @param relationshipSlug - Optional filter by relationship type
   * @returns Array of related profiles
   */
  async findRelated(
    profileId: string,
    relationshipSlug?: string,
  ): Promise<Profile[]> {
    const profile = await this.get({ id: profileId });
    if (!profile) return [];

    return await profile.getRelatedProfiles(relationshipSlug);
  }

  async getAssets(profileId: string, relationship?: string): Promise<Asset[]> {
    const profile = await this.get({ id: profileId });
    if (!profile) return [];

    return profile.getAssets(relationship);
  }

  async addAsset(
    profileId: string,
    asset: Asset,
    relationship = 'attachment',
    sortOrder = 0,
  ): Promise<void> {
    const profile = await this.get({ id: profileId });
    if (!profile) {
      throw new Error(`Profile '${profileId}' not found`);
    }

    await profile.addAsset(asset, relationship, sortOrder);
  }

  async removeAsset(
    profileId: string,
    assetId: string,
    relationship?: string,
  ): Promise<void> {
    const profile = await this.get({ id: profileId });
    if (!profile) {
      throw new Error(`Profile '${profileId}' not found`);
    }

    await profile.removeAsset(assetId, relationship);
  }

  /**
   * Get the relationship network for a profile up to a maximum depth
   *
   * @param profileId - The starting profile UUID
   * @param options - Configuration options
   * @returns Map of profile ID to depth level
   */
  async getRelationshipNetwork(
    profileId: string,
    options: { maxDepth?: number } = {},
  ): Promise<Map<string, number>> {
    const maxDepth = options.maxDepth || 2;
    const network = new Map<string, number>();
    const visited = new Set<string>();
    const queue: Array<{ id: string; depth: number }> = [
      { id: profileId, depth: 0 },
    ];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        break;
      }

      if (visited.has(current.id) || current.depth > maxDepth) {
        continue;
      }

      visited.add(current.id);
      network.set(current.id, current.depth);

      if (current.depth < maxDepth) {
        const related = await this.findRelated(current.id);
        for (const profile of related) {
          if (profile.id && !visited.has(profile.id)) {
            queue.push({ id: profile.id, depth: current.depth + 1 });
          }
        }
      }
    }

    return network;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Tenant-scoped helper methods
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Find all profiles belonging to a specific tenant
   *
   * @param tenantId - The tenant UUID to filter by
   * @returns Array of profiles for this tenant
   */
  async findByTenant(tenantId: string): Promise<Profile[]> {
    return this.list({ where: { tenantId } });
  }

  /**
   * Find all global profiles (without a tenant)
   *
   * @returns Array of profiles with null tenantId
   */
  async findGlobal(): Promise<Profile[]> {
    return this.list({ where: { tenantId: null } });
  }

  /**
   * Find profiles belonging to a tenant plus all global profiles
   *
   * @param tenantId - The tenant UUID to include
   * @returns Array of tenant-specific and global profiles
   */
  async findWithGlobals(tenantId: string): Promise<Profile[]> {
    return this.query(
      `SELECT * FROM ${this.tableName} WHERE tenant_id = ? OR tenant_id IS NULL`,
      [tenantId],
    );
  }
}
