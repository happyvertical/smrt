/**
 * Zone model - Hierarchical placement area within a property
 *
 * Zones represent pages, sections, or slots within a digital property.
 * They can be nested arbitrarily using the parentId self-reference.
 */

import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { ZoneOptions, ZoneTreeNode } from '../types';

@TenantScoped({ mode: 'optional' })
@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create'] },
  cli: true,
})
export class Zone extends SmrtObject {
  /**
   * Tenant ID for multi-tenant isolation
   */
  @tenantId({ nullable: true })
  tenantId?: string;

  /**
   * Parent property ID (required)
   */
  propertyId: string = '';

  /**
   * Parent zone ID for hierarchy (null = top-level zone)
   */
  parentId: string | null = null;

  /**
   * Display name
   */
  name: string = '';

  /**
   * Zone type (descriptive, not structural)
   * Common values: "page", "section", "slot", "container", "widget"
   */
  type: string = '';

  /**
   * URL path pattern (e.g., "/", "/articles/*")
   */
  path: string = '';

  /**
   * CSS selector for placement (e.g., "#header", ".sidebar")
   */
  selector: string = '';

  /**
   * Position hint (e.g., "top", "after-paragraph-3")
   */
  position: string = '';

  /**
   * Width in pixels (null = fluid)
   */
  width: number | null = null;

  /**
   * Height in pixels (null = fluid)
   */
  height: number | null = null;

  /**
   * Allowed content/ad formats
   */
  allowedFormats: string[] = [];

  /**
   * Default content/asset ID for fallback
   */
  defaultContentId: string | null = null;

  /**
   * Extensible metadata
   */
  metadata: Record<string, unknown> = {};

  constructor(options: ZoneOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId as any;
    if (options.propertyId !== undefined) this.propertyId = options.propertyId;
    if (options.parentId !== undefined) this.parentId = options.parentId;
    if (options.name !== undefined) this.name = options.name;
    if (options.type !== undefined) this.type = options.type;
    if (options.path !== undefined) this.path = options.path;
    if (options.selector !== undefined) this.selector = options.selector;
    if (options.position !== undefined) this.position = options.position;
    if (options.width !== undefined) this.width = options.width;
    if (options.height !== undefined) this.height = options.height;
    if (options.allowedFormats !== undefined)
      this.allowedFormats = options.allowedFormats;
    if (options.defaultContentId !== undefined)
      this.defaultContentId = options.defaultContentId;
    if (options.metadata !== undefined) this.metadata = options.metadata;
  }

  /**
   * Check if this is a top-level zone (no parent)
   */
  isTopLevel(): boolean {
    return this.parentId === null;
  }

  /**
   * Check if this zone has dimensions set
   */
  hasDimensions(): boolean {
    return this.width !== null && this.height !== null;
  }

  /**
   * Get dimensions as string (e.g., "728x90")
   */
  getDimensionString(): string | null {
    if (!this.hasDimensions()) return null;
    return `${this.width}x${this.height}`;
  }

  /**
   * Get the parent property
   */
  async getProperty(): Promise<import('./Property').Property | null> {
    const { PropertyCollection } = await import('../collections/Properties');
    const collection = await (PropertyCollection as any).create(this.options);
    return await collection.get({ id: this.propertyId });
  }

  /**
   * Get the parent zone (if any)
   */
  async getParent(): Promise<Zone | null> {
    if (!this.parentId) return null;
    const { ZoneCollection } = await import('../collections/Zones');
    const collection = await (ZoneCollection as any).create(this.options);
    return await collection.get({ id: this.parentId });
  }

  /**
   * Get direct children of this zone
   */
  async getChildren(): Promise<Zone[]> {
    if (!this.id) return [];
    const { ZoneCollection } = await import('../collections/Zones');
    const collection = await (ZoneCollection as any).create(this.options);
    return await collection.findChildren(this.id);
  }

  /**
   * Get all ancestors up to the root
   */
  async getAncestors(): Promise<Zone[]> {
    if (!this.id) return [];
    const { ZoneCollection } = await import('../collections/Zones');
    const collection = await (ZoneCollection as any).create(this.options);
    return await collection.getAncestors(this.id);
  }

  /**
   * Get all descendants recursively
   */
  async getDescendants(): Promise<Zone[]> {
    if (!this.id) return [];
    const { ZoneCollection } = await import('../collections/Zones');
    const collection = await (ZoneCollection as any).create(this.options);
    return await collection.getDescendants(this.id);
  }

  /**
   * Get the full path from root to this zone
   */
  async getFullPath(): Promise<string> {
    const ancestors = await this.getAncestors();
    const names = [...ancestors.map((z) => z.name), this.name];
    return names.join(' > ');
  }

  /**
   * Get the depth in the hierarchy (0 = top-level)
   */
  async getDepth(): Promise<number> {
    const ancestors = await this.getAncestors();
    return ancestors.length;
  }

  /**
   * Create a child zone under this zone
   */
  async createChild(
    options: Omit<ZoneOptions, 'propertyId' | 'parentId'>,
  ): Promise<Zone> {
    if (!this.id) {
      throw new Error('Zone must be saved before creating children');
    }
    const { ZoneCollection } = await import('../collections/Zones');
    const collection = await (ZoneCollection as any).create(this.options);
    const zone = await collection.create({
      ...options,
      propertyId: this.propertyId,
      parentId: this.id,
    });
    await zone.save();
    return zone;
  }

  /**
   * Build tree node for this zone and its children
   */
  async toTreeNode(): Promise<ZoneTreeNode<Zone>> {
    const children = await this.getChildren();
    const childNodes = await Promise.all(children.map((c) => c.toTreeNode()));
    return {
      zone: this,
      children: childNodes,
    };
  }

  /**
   * Check if a format is allowed in this zone
   */
  isFormatAllowed(format: string): boolean {
    if (this.allowedFormats.length === 0) return true; // No restrictions
    return this.allowedFormats.includes(format);
  }
}
