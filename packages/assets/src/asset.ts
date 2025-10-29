/**
 * Asset model - Core entity for asset management
 *
 * Represents a digital asset with versioning, metadata, and tag support
 */

import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import type { Tag } from '@happyvertical/smrt-tags';
import type { AssetStatus } from './asset-status';
import type { AssetType } from './asset-type';
import type { AssetOptions } from './types';

@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
  cli: true,
})
export class Asset extends SmrtObject {
  // Core fields
  name = ''; // User-friendly name
  // slug is inherited as an accessor from SmrtObject
  sourceUri = ''; // URI to the actual file (e.g., 's3://bucket/key', 'file:///path')
  mimeType = ''; // MIME type (e.g., 'image/jpeg', 'video/mp4')
  description = ''; // Optional description
  version = 1; // Version number

  // Foreign key references (stored as IDs/slugs)
  primaryVersionId: string | null = null; // Points to first version's ID
  typeSlug = ''; // FK to AssetType.slug
  statusSlug = ''; // FK to AssetStatus.slug
  ownerProfileId: string | null = null; // FK to Profile.id (nullable)
  parentId: string | null = null; // FK to Asset.id (for derivatives)

  // Timestamps
  createdAt = new Date();
  updatedAt = new Date();

  constructor(options: AssetOptions = {}) {
    super(options);
    if (options.name) this.name = options.name;
    if (options.slug) this.slug = options.slug;
    if (options.sourceUri) this.sourceUri = options.sourceUri;
    if (options.mimeType) this.mimeType = options.mimeType;
    if (options.description) this.description = options.description;
    if (options.version !== undefined) this.version = options.version;
    if (options.primaryVersionId !== undefined)
      this.primaryVersionId = options.primaryVersionId;
    if (options.typeSlug) this.typeSlug = options.typeSlug;
    if (options.statusSlug) this.statusSlug = options.statusSlug;
    if (options.ownerProfileId !== undefined)
      this.ownerProfileId = options.ownerProfileId;
    if (options.parentId !== undefined) this.parentId = options.parentId;
    if (options.createdAt) this.createdAt = options.createdAt;
    if (options.updatedAt) this.updatedAt = options.updatedAt;
  }

  /**
   * Get all tags for this asset from @happyvertical/smrt-tags
   *
   * @returns Array of Tag instances from @happyvertical/smrt-tags package
   */
  async getTags(): Promise<Tag[]> {
    // Query asset_tags join table and retrieve Tag instances
    const db = this.db;
    const rows = await db.list('asset_tags', {
      where: { asset_id: this.id },
    });

    // Import Tag dynamically to avoid circular dependencies
    const { Tag } = await import('@happyvertical/smrt-tags');
    const tags: Tag[] = [];

    for (const row of rows as { tag_slug: string }[]) {
      const tag = await Tag.getBySlug(row.tag_slug);
      if (tag) tags.push(tag);
    }

    return tags;
  }

  /**
   * Check if this asset has a specific tag
   *
   * @param tagSlug - The slug of the tag to check
   * @returns True if the asset has this tag
   */
  async hasTag(tagSlug: string): Promise<boolean> {
    const db = this.db;
    const rows = await db.list('asset_tags', {
      where: { asset_id: this.id, tag_slug: tagSlug },
    });

    return rows.length > 0;
  }

  /**
   * Get the parent asset (if this is a derivative)
   *
   * @returns Parent Asset instance or null
   */
  async getParent(): Promise<Asset | null> {
    if (!this.parentId) return null;

    const record = await this.db.get('assets', { id: this.parentId });

    if (!record) return null;

    const asset = new Asset();
    Object.assign(asset, record);
    return asset;
  }

  /**
   * Get all derivative assets (children)
   *
   * @returns Array of child Asset instances
   */
  async getChildren(): Promise<Asset[]> {
    const rows = await this.db.list('assets', {
      where: { parent_id: this.id },
    });

    return (rows as any[]).map((row) => {
      const asset = new Asset();
      Object.assign(asset, row);
      return asset;
    });
  }

  /**
   * Get the type of this asset
   *
   * @returns AssetType instance or null
   */
  async getType(): Promise<AssetType | null> {
    if (!this.typeSlug) return null;

    const { AssetType } = await import('./asset-type');
    return await AssetType.getBySlug(this.typeSlug);
  }

  /**
   * Get the status of this asset
   *
   * @returns AssetStatus instance or null
   */
  async getStatus(): Promise<AssetStatus | null> {
    if (!this.statusSlug) return null;

    const { AssetStatus } = await import('./asset-status');
    return await AssetStatus.getBySlug(this.statusSlug);
  }

  /**
   * Get asset by slug
   *
   * @param slug - The slug to search for
   * @returns Asset instance or null
   */
  static async getBySlug(_slug: string): Promise<Asset | null> {
    // Will be auto-implemented by SMRT
    return null;
  }
}
