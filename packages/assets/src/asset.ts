/**
 * Asset model - Core entity for asset management
 *
 * Represents a digital asset with versioning, metadata, and tag support
 */

import { SmrtObject, smrt } from '@smrt/core';
import type { Tag } from '@smrt/tags';
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
  slug = ''; // URL-friendly identifier
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
   * Get all tags for this asset from @smrt/tags
   *
   * @returns Array of Tag instances from @smrt/tags package
   */
  async getTags(): Promise<Tag[]> {
    // Query asset_tags join table and retrieve Tag instances
    const collection = this.getCollection();
    if (!collection) return [];

    const db = await collection.getDb();
    const rows = (await db
      .prepare('SELECT tag_slug FROM asset_tags WHERE asset_id = ?')
      .all(this.id)) as { tag_slug: string }[];

    // Import Tag dynamically to avoid circular dependencies
    const { Tag } = await import('@smrt/tags');
    const tags: Tag[] = [];

    for (const row of rows) {
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
    const collection = this.getCollection();
    if (!collection) return false;

    const db = await collection.getDb();
    const result = (await db
      .prepare(
        'SELECT COUNT(*) as count FROM asset_tags WHERE asset_id = ? AND tag_slug = ?',
      )
      .get(this.id, tagSlug)) as { count: number };

    return result.count > 0;
  }

  /**
   * Get the parent asset (if this is a derivative)
   *
   * @returns Parent Asset instance or null
   */
  async getParent(): Promise<Asset | null> {
    if (!this.parentId) return null;

    const collection = this.getCollection();
    if (!collection) return null;

    return (await collection.get({ id: this.parentId })) as Asset | null;
  }

  /**
   * Get all derivative assets (children)
   *
   * @returns Array of child Asset instances
   */
  async getChildren(): Promise<Asset[]> {
    const collection = this.getCollection();
    if (!collection) return [];

    return (await collection.list({
      where: { parentId: this.id },
    })) as Asset[];
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
