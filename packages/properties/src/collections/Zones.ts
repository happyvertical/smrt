/**
 * ZoneCollection - Collection manager for Zone objects
 *
 * Provides querying and tree operations for Zone entities.
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { queryGlobal, queryWithGlobals } from '@happyvertical/smrt-tenancy';
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

    // Build a lookup map for efficient in-memory traversal
    const zonesById = new Map<string, Zone>();
    for (const zone of allZones) {
      if (zone.id) {
        zonesById.set(zone.id, zone);
      }
    }

    // Cache computed depths
    const depthCache = new Map<string, number>();

    const getDepth = (zone: Zone): number => {
      if (!zone.id) return 0;

      const cached = depthCache.get(zone.id);
      if (cached !== undefined) return cached;

      let depth = 0;
      let current: Zone | undefined = zone;
      const visited = new Set<string>();

      // Walk up the parent chain using in-memory lookup
      while (current?.id) {
        const parentId = current.parentId;
        if (!parentId) break;

        // Prevent infinite loops from cyclic data
        if (visited.has(parentId)) break;
        visited.add(parentId);

        const parent = zonesById.get(parentId);
        if (!parent) break;

        depth += 1;
        current = parent;
      }

      depthCache.set(zone.id, depth);
      return depth;
    };

    let maxDepth = 0;
    for (const zone of allZones) {
      maxDepth = Math.max(maxDepth, getDepth(zone));
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

  // ============================================
  // Tenant Helper Methods
  // ============================================

  /**
   * Find zones belonging to a specific tenant
   *
   * @param tenantId - Tenant ID to filter by
   * @returns Array of zones for the tenant
   */
  async findByTenant(tenantId: string): Promise<Zone[]> {
    return this.list({ where: { tenantId } });
  }

  /**
   * Find all global zones (no tenant association).
   *
   * Routes through the shared tenant-global helper so it does not throw under
   * an active tenant context (an explicit `tenant_id IS NULL` filter would be
   * flagged as an isolation violation). (#1600)
   *
   * @returns Array of global zones
   */
  async findGlobal(): Promise<Zone[]> {
    return queryGlobal<Zone>(this);
  }

  /**
   * Find zones for a tenant plus all global zones.
   *
   * Fails closed if an active tenant context requests a different tenant's
   * rows; the admin/system path keeps the cross-tenant capability. (#1600)
   *
   * @param tenantId - Tenant ID to filter by
   * @returns Array of tenant-specific and global zones
   */
  async findWithGlobals(tenantId: string): Promise<Zone[]> {
    return queryWithGlobals<Zone>(this, tenantId, 'Zone.findWithGlobals');
  }
}
