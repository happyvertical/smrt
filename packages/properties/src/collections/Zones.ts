/**
 * ZoneCollection - Collection manager for Zone objects
 *
 * Provides querying and tree operations for Zone entities.
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { Zone } from '../models/Zone';
import type { ZoneTree, ZoneTreeNode } from '../types';

export class ZoneCollection extends SmrtCollection<Zone> {
  static readonly _itemClass = Zone;

  /**
   * Find all zones for a property
   *
   * @param propertyId - Property ID
   * @returns Array of zones
   */
  async findByProperty(propertyId: string): Promise<Zone[]> {
    return await this.list({
      where: { propertyId },
    });
  }

  /**
   * Find top-level zones for a property (no parent)
   *
   * @param propertyId - Property ID
   * @returns Array of top-level zones
   */
  async findTopLevel(propertyId: string): Promise<Zone[]> {
    return await this.list({
      where: { propertyId, parentId: null },
    });
  }

  /**
   * Find direct children of a zone
   *
   * @param parentId - Parent zone ID
   * @returns Array of child zones
   */
  async findChildren(parentId: string): Promise<Zone[]> {
    return await this.list({
      where: { parentId },
    });
  }

  /**
   * Find zones by path pattern
   *
   * @param propertyId - Property ID
   * @param path - URL path to match
   * @returns Array of matching zones
   */
  async findByPath(propertyId: string, path: string): Promise<Zone[]> {
    return await this.list({
      where: { propertyId, path },
    });
  }

  /**
   * Find zones by type
   *
   * @param propertyId - Property ID
   * @param type - Zone type
   * @returns Array of zones of the given type
   */
  async findByType(propertyId: string, type: string): Promise<Zone[]> {
    return await this.list({
      where: { propertyId, type },
    });
  }

  /**
   * Get the complete zone tree for a property
   *
   * @param propertyId - Property ID
   * @returns ZoneTree structure
   */
  async getTree(propertyId: string): Promise<ZoneTree<Zone>> {
    const allZones = await this.findByProperty(propertyId);
    const zoneMap = new Map<string, Zone>();
    const childrenMap = new Map<string, Zone[]>();

    // Build lookup maps
    for (const zone of allZones) {
      if (zone.id) {
        zoneMap.set(zone.id, zone);
      }
      if (!childrenMap.has(zone.parentId || '')) {
        childrenMap.set(zone.parentId || '', []);
      }
      childrenMap.get(zone.parentId || '')?.push(zone);
    }

    // Build tree nodes recursively
    const buildNode = (zone: Zone): ZoneTreeNode<Zone> => {
      const children = (zone.id ? childrenMap.get(zone.id) : []) || [];
      return {
        zone,
        children: children.map(buildNode),
      };
    };

    // Get root nodes (no parent)
    const roots = childrenMap.get('') || [];

    return {
      propertyId,
      roots: roots.map(buildNode),
    };
  }

  /**
   * Get all ancestors of a zone (path to root)
   *
   * @param zoneId - Zone ID
   * @returns Array of ancestors (from root to parent)
   */
  async getAncestors(zoneId: string): Promise<Zone[]> {
    const ancestors: Zone[] = [];

    // Get the starting zone
    const startZone = await this.get({ id: zoneId });
    if (!startZone) return ancestors;

    let currentId: string | null = startZone.parentId;

    // Walk up the tree
    while (currentId) {
      const parent = await this.get({ id: currentId });
      if (!parent) break;
      ancestors.unshift(parent); // Add to front (root first)
      currentId = parent.parentId;
    }

    return ancestors;
  }

  /**
   * Get all descendants of a zone recursively
   *
   * @param zoneId - Zone ID
   * @returns Array of all descendant zones
   */
  async getDescendants(zoneId: string): Promise<Zone[]> {
    const descendants: Zone[] = [];
    const queue: string[] = [zoneId];

    while (queue.length > 0) {
      const currentId = queue.shift();
      if (!currentId) continue;

      const children = await this.findChildren(currentId);

      for (const child of children) {
        descendants.push(child);
        if (child.id) {
          queue.push(child.id);
        }
      }
    }

    return descendants;
  }

  /**
   * Get the depth of the deepest zone in a property
   *
   * @param propertyId - Property ID
   * @returns Maximum depth (0 = only top-level zones)
   */
  async getMaxDepth(propertyId: string): Promise<number> {
    const allZones = await this.findByProperty(propertyId);
    let maxDepth = 0;

    for (const zone of allZones) {
      if (zone.id) {
        const ancestors = await this.getAncestors(zone.id);
        maxDepth = Math.max(maxDepth, ancestors.length);
      }
    }

    return maxDepth;
  }

  /**
   * Find zones with specific dimensions
   *
   * @param propertyId - Property ID
   * @param width - Required width
   * @param height - Required height
   * @returns Array of matching zones
   */
  async findByDimensions(
    propertyId: string,
    width: number,
    height: number,
  ): Promise<Zone[]> {
    return await this.list({
      where: { propertyId, width, height },
    });
  }

  /**
   * Find zones that allow a specific format
   *
   * @param propertyId - Property ID
   * @param format - Format to check
   * @returns Array of zones allowing the format
   */
  async findByAllowedFormat(
    propertyId: string,
    format: string,
  ): Promise<Zone[]> {
    const allZones = await this.findByProperty(propertyId);
    return allZones.filter((zone) => zone.isFormatAllowed(format));
  }

  /**
   * Move a zone to a new parent
   *
   * @param zoneId - Zone ID to move
   * @param newParentId - New parent ID (null for top-level)
   * @returns Updated zone
   */
  async moveZone(
    zoneId: string,
    newParentId: string | null,
  ): Promise<Zone | null> {
    const zone = await this.get({ id: zoneId });
    if (!zone) return null;

    // Prevent circular references
    if (newParentId) {
      const descendants = await this.getDescendants(zoneId);
      const descendantIds = descendants.map((d) => d.id);
      if (descendantIds.includes(newParentId)) {
        throw new Error('Cannot move zone into one of its descendants');
      }
    }

    zone.parentId = newParentId;
    await zone.save();
    return zone;
  }

  /**
   * Delete a zone and optionally its descendants
   *
   * @param zoneId - Zone ID to delete
   * @param cascade - Whether to delete descendants
   * @returns Number of zones deleted
   */
  async deleteZone(zoneId: string, cascade: boolean = false): Promise<number> {
    const zone = await this.get({ id: zoneId });
    if (!zone) return 0;

    let deleted = 0;

    if (cascade) {
      const descendants = await this.getDescendants(zoneId);
      for (const desc of descendants) {
        await desc.delete();
        deleted++;
      }
    } else {
      // Move children to parent
      const children = await this.findChildren(zoneId);
      for (const child of children) {
        child.parentId = zone.parentId;
        await child.save();
      }
    }

    await zone.delete();
    deleted++;

    return deleted;
  }
}
