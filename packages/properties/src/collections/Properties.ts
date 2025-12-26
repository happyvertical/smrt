/**
 * PropertyCollection - Collection manager for Property objects
 *
 * Provides querying and management operations for Property entities.
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { Property } from '../models/Property';
import type { PropertyStatus } from '../types';

export class PropertyCollection extends SmrtCollection<Property> {
  static readonly _itemClass = Property;

  /**
   * Find a property by domain
   *
   * @param domain - Domain name
   * @returns Property or null
   */
  async findByDomain(domain: string): Promise<Property | null> {
    const results = await this.list({
      where: { domain },
      limit: 1,
    });
    return results[0] || null;
  }

  /**
   * Find properties by repository ID
   *
   * @param repositoryId - Repository ID
   * @returns Array of properties
   */
  async findByRepository(repositoryId: string): Promise<Property[]> {
    return await this.list({
      where: { repositoryId },
    });
  }

  /**
   * Find properties by owner ID
   *
   * @param ownerId - Owner profile ID
   * @returns Array of properties
   */
  async findByOwner(ownerId: string): Promise<Property[]> {
    return await this.list({
      where: { ownerId },
    });
  }

  /**
   * Find active properties
   *
   * @returns Array of active properties
   */
  async findActive(): Promise<Property[]> {
    return await this.list({
      where: { status: 'active' as PropertyStatus },
    });
  }

  /**
   * Find properties by status
   *
   * @param status - Property status
   * @returns Array of properties with the given status
   */
  async findByStatus(status: PropertyStatus): Promise<Property[]> {
    return await this.list({
      where: { status },
    });
  }

  /**
   * Get or create a property by domain
   *
   * @param domain - Domain name
   * @param defaults - Default values for creation
   * @returns Property (existing or newly created)
   */
  async getOrCreateByDomain(
    domain: string,
    defaults: {
      name?: string;
      url?: string;
      repositoryId?: string | null;
      ownerId?: string | null;
    } = {},
  ): Promise<Property> {
    let property = await this.findByDomain(domain);

    if (!property) {
      property = await this.create({
        domain,
        name: defaults.name || domain,
        url: defaults.url || `https://${domain}`,
        repositoryId: defaults.repositoryId ?? null,
        ownerId: defaults.ownerId ?? null,
        status: 'active',
      });
      await property.save();
    }

    return property;
  }

  /**
   * Count properties by status
   *
   * @returns Object with counts per status
   */
  async countByStatus(): Promise<Record<PropertyStatus, number>> {
    const all = await this.list({});
    const counts: Record<PropertyStatus, number> = {
      active: 0,
      inactive: 0,
      pending: 0,
    };

    for (const prop of all) {
      counts[prop.status]++;
    }

    return counts;
  }
}
