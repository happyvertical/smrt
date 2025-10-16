/**
 * AssetCollection - Collection manager for Asset instances
 *
 * Provides tag management, versioning, and query operations for assets
 */

import { SmrtCollection } from '@have/smrt';
import { Asset } from './asset';

export class AssetCollection extends SmrtCollection<Asset> {
  static readonly _itemClass = Asset;

  /**
   * Add a tag to an asset (uses @have/tags)
   *
   * @param assetId - The asset ID to tag
   * @param tagSlug - The tag slug from @have/tags
   */
  async addTag(assetId: string, tagSlug: string): Promise<void> {
    const db = await this.getDb();
    await db
      .prepare(
        'INSERT OR IGNORE INTO asset_tags (asset_id, tag_slug, created_at) VALUES (?, ?, ?)',
      )
      .run(assetId, tagSlug, new Date().toISOString());
  }

  /**
   * Remove a tag from an asset
   *
   * @param assetId - The asset ID
   * @param tagSlug - The tag slug to remove
   */
  async removeTag(assetId: string, tagSlug: string): Promise<void> {
    const db = await this.getDb();
    await db
      .prepare('DELETE FROM asset_tags WHERE asset_id = ? AND tag_slug = ?')
      .run(assetId, tagSlug);
  }

  /**
   * Get all assets with a specific tag
   *
   * @param tagSlug - The tag slug to filter by
   * @returns Array of assets with this tag
   */
  async getByTag(tagSlug: string): Promise<Asset[]> {
    const db = await this.getDb();
    const rows = (await db
      .prepare('SELECT asset_id FROM asset_tags WHERE tag_slug = ?')
      .all(tagSlug)) as { asset_id: string }[];

    const assets: Asset[] = [];
    for (const row of rows) {
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
    const db = await this.getDb();

    // Query for all assets with this primary version ID or ID matching primary version ID
    const rows = (await db
      .prepare(
        'SELECT * FROM assets WHERE primary_version_id = ? OR id = ? ORDER BY version ASC',
      )
      .all(primaryVersionId, primaryVersionId)) as any[];

    return rows.map((row) => {
      const asset = new Asset();
      Object.assign(asset, row);
      return asset;
    });
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
    const db = await this.getDb();
    const pattern = mimePattern.replace('*', '%');

    const rows = (await db
      .prepare('SELECT * FROM assets WHERE mime_type LIKE ?')
      .all(pattern)) as any[];

    return rows.map((row) => {
      const asset = new Asset();
      Object.assign(asset, row);
      return asset;
    });
  }
}
