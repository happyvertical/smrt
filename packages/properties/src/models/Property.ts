/**
 * Property model - Digital property representation
 *
 * Represents a digital property (website, app, publication) that can contain
 * hierarchical zones for content/ad placement.
 */

import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import type { PropertyOptions, PropertyStatus } from '../types';

@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create'] },
  cli: true,
})
export class Property extends SmrtObject {
  /**
   * Display name of the property
   */
  name: string = '';

  /**
   * Domain name (e.g., "oakcreeknews.com")
   */
  domain: string = '';

  /**
   * Full URL (e.g., "https://oakcreeknews.com")
   */
  url: string = '';

  /**
   * Property description
   */
  description: string = '';

  /**
   * Link to Repository (from smrt-projects)
   * Optional - used when property is backed by a git repository
   */
  repositoryId: string | null = null;

  /**
   * Link to Profile (from smrt-profiles)
   * Optional - owner/publisher of the property
   */
  ownerId: string | null = null;

  /**
   * Property status
   */
  status: PropertyStatus = 'active';

  /**
   * Extensible metadata (analytics IDs, config, etc.)
   */
  metadata: Record<string, unknown> = {};

  constructor(options: PropertyOptions = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
    if (options.domain !== undefined) this.domain = options.domain;
    if (options.url !== undefined) this.url = options.url;
    if (options.description !== undefined)
      this.description = options.description;
    if (options.repositoryId !== undefined)
      this.repositoryId = options.repositoryId;
    if (options.ownerId !== undefined) this.ownerId = options.ownerId;
    if (options.status !== undefined) this.status = options.status;
    if (options.metadata !== undefined) this.metadata = options.metadata;
  }

  /**
   * Get all zones for this property
   */
  async getZones(): Promise<import('./Zone').Zone[]> {
    if (!this.id) return [];
    const { ZoneCollection } = await import('../collections/Zones');
    const collection = await (ZoneCollection as any).create(this.options);
    return await collection.findByProperty(this.id);
  }

  /**
   * Get zone tree for this property
   */
  async getZoneTree(): Promise<
    import('../types').ZoneTree<import('./Zone').Zone>
  > {
    if (!this.id) return { propertyId: '', roots: [] };
    const { ZoneCollection } = await import('../collections/Zones');
    const collection = await (ZoneCollection as any).create(this.options);
    return await collection.getTree(this.id);
  }

  /**
   * Create a zone on this property
   */
  async createZone(
    options: Omit<import('../types').ZoneOptions, 'propertyId'>,
  ): Promise<import('./Zone').Zone> {
    const { ZoneCollection } = await import('../collections/Zones');
    const collection = await (ZoneCollection as any).create(this.options);
    const zone = await collection.create({
      ...options,
      propertyId: this.id,
    });
    await zone.save();
    return zone;
  }

  /**
   * Check if property is active
   */
  isActive(): boolean {
    return this.status === 'active';
  }

  /**
   * Generate a summary of the property and its zones
   */
  async summarize(): Promise<string> {
    const zones = await this.getZones();
    const topLevelZones = zones.filter((z) => z.parentId === null);

    return await this.do(
      `Summarize this digital property:\n` +
        `Name: ${this.name}\n` +
        `Domain: ${this.domain}\n` +
        `Description: ${this.description}\n` +
        `Status: ${this.status}\n` +
        `Total zones: ${zones.length}\n` +
        `Top-level zones: ${topLevelZones.map((z) => z.name).join(', ')}`,
    );
  }
}
