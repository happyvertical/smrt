/**
 * AssetCollection - Collection manager for Asset instances
 *
 * Provides tag management, versioning, tenant-aware queries, and operations for assets
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { Asset } from './asset';

export class AssetCollection extends SmrtCollection<Asset> {
  static readonly _itemClass = Asset;

  // ─────────────────────────────────────────────────────────────────────────────
  // Tenant-Aware Query Methods
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Find all assets belonging to a specific tenant
   *
   * @param tenantId - The tenant ID to filter by
   * @returns Array of assets belonging to this tenant
   */
  async findByTenant(tenantId: string): Promise<Asset[]> {
    return (await this.list({ where: { tenantId } })) as Asset[];
  }

  /**
   * Find all global assets (assets without a tenant)
   *
   * @returns Array of global assets
   */
  async findGlobal(): Promise<Asset[]> {
    return (await this.list({ where: { tenantId: null } })) as Asset[];
  }

  /**
   * Find assets belonging to a tenant plus all global assets
   *
   * @param tenantId - The tenant ID to include
   * @returns Array of tenant-specific and global assets
   */
  async findWithGlobals(tenantId: string): Promise<Asset[]> {
    return (await this.query(
      `SELECT * FROM ${this.tableName} WHERE tenant_id = ? OR tenant_id IS NULL`,
      [tenantId],
    )) as Asset[];
  }

  /**
   * Add a tag to an asset (uses @smrt/tags)
   *
   * @param assetId - The asset ID to tag
   * @param tagSlug - The tag slug from @smrt/tags
   */
  async addTag(assetId: string, tagSlug: string): Promise<void> {
    const db = this.db;
    await db.upsert('asset_tags', ['asset_id', 'tag_slug'], {
      asset_id: assetId,
      tag_slug: tagSlug,
      created_at: new Date().toISOString(),
    });
  }

  /**
   * Remove a tag from an asset
   *
   * @param assetId - The asset ID
   * @param tagSlug - The tag slug to remove
   */
  async removeTag(assetId: string, tagSlug: string): Promise<void> {
    const db = this.db;
    await db.delete('asset_tags', {
      asset_id: assetId,
      tag_slug: tagSlug,
    });
  }

  /**
   * Get all assets with a specific tag
   *
   * @param tagSlug - The tag slug to filter by
   * @returns Array of assets with this tag
   */
  async getByTag(tagSlug: string): Promise<Asset[]> {
    const db = this.db;
    const rows = await db.list('asset_tags', {
      where: { tag_slug: tagSlug },
    });

    const assets: Asset[] = [];
    for (const row of rows as { asset_id: string }[]) {
      const asset = await this.get({ id: row.asset_id });
      if (asset) assets.push(asset as Asset);
    }

    return assets;
  }

  /**
   * Get assets by type
   *
   * @param typeSlug - The asset type slug (e.g., 'image', 'video')
   * @returns Array of assets matching the type
   */
  async getByType(typeSlug: string): Promise<Asset[]> {
    return (await this.list({ where: { typeSlug } })) as Asset[];
  }

  /**
   * Get assets by status
   *
   * @param statusSlug - The asset status slug (e.g., 'published', 'draft')
   * @returns Array of assets matching the status
   */
  async getByStatus(statusSlug: string): Promise<Asset[]> {
    return (await this.list({ where: { statusSlug } })) as Asset[];
  }

  /**
   * Get assets by owner
   *
   * @param ownerProfileId - The profile ID of the owner
   * @returns Array of assets owned by this profile
   */
  async getByOwner(ownerProfileId: string): Promise<Asset[]> {
    return (await this.list({ where: { ownerProfileId } })) as Asset[];
  }

  /**
   * Create a new version of an existing asset
   *
   * @param primaryVersionId - The primary version ID (first version's ID)
   * @param newSourceUri - The new source URI for this version
   * @param updates - Optional additional updates
   * @returns The newly created asset version
   */
  async createNewVersion(
    primaryVersionId: string,
    newSourceUri: string,
    updates: Partial<Asset> = {},
  ): Promise<Asset> {
    // Get the current latest version
    const versions = await this.listVersions(primaryVersionId);
    if (versions.length === 0) {
      throw new Error(
        `No asset found with primary version ID: ${primaryVersionId}`,
      );
    }

    // Sort by version number to find the latest
    versions.sort((a, b) => b.version - a.version);
    const latestVersion = versions[0];

    // Create new version
    return (await this.create({
      ...latestVersion,
      id: undefined, // Generate new ID
      sourceUri: newSourceUri,
      version: latestVersion.version + 1,
      primaryVersionId,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...updates,
    })) as Asset;
  }

  /**
   * Get the latest version of an asset
   *
   * @param primaryVersionId - The primary version ID
   * @returns The latest version or null
   */
  async getLatestVersion(primaryVersionId: string): Promise<Asset | null> {
    const versions = await this.listVersions(primaryVersionId);
    if (versions.length === 0) return null;

    // Sort by version number descending
    versions.sort((a, b) => b.version - a.version);
    return versions[0];
  }

  /**
   * List all versions of an asset
   *
   * @param primaryVersionId - The primary version ID
   * @returns Array of all asset versions, ordered by version number
   */
  async listVersions(primaryVersionId: string): Promise<Asset[]> {
    const db = this.db;

    // Query for all assets with this primary version ID or ID matching primary version ID
    // Split OR logic into two queries since semantic adapters don't support OR directly
    const [versionsRows, primaryRow] = await Promise.all([
      db.list('assets', {
        where: { primary_version_id: primaryVersionId },
        orderBy: 'version ASC',
      }),
      db.get('assets', { id: primaryVersionId }),
    ]);

    // Combine results and deduplicate by ID
    const allRows = primaryRow ? [primaryRow, ...versionsRows] : versionsRows;
    const uniqueAssets = new Map<string, any>();
    for (const row of allRows) {
      uniqueAssets.set((row as any).id, row);
    }

    // Convert to Asset instances and sort by version
    const assets = Array.from(uniqueAssets.values()).map((row) => {
      const asset = new Asset();
      Object.assign(asset, row);
      return asset;
    });

    // Sort by version number
    assets.sort((a, b) => a.version - b.version);
    return assets;
  }

  /**
   * Get child assets (derivatives) of a parent asset
   *
   * @param parentId - The parent asset ID
   * @returns Array of child assets
   */
  async getChildren(parentId: string): Promise<Asset[]> {
    return (await this.list({ where: { parentId } })) as Asset[];
  }

  /**
   * Get assets by MIME type pattern
   *
   * @param mimePattern - MIME type pattern (e.g., 'image/*', 'video/mp4')
   * @returns Array of matching assets
   */
  async getByMimeType(mimePattern: string): Promise<Asset[]> {
    const db = this.db;
    const pattern = mimePattern.replace('*', '%');

    const rows = await db.list('assets', {
      where: { 'mime_type like': pattern },
    });

    return (rows as any[]).map((row) => {
      const asset = new Asset();
      Object.assign(asset, row);
      return asset;
    });
  }
}
