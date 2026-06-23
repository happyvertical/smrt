/**
 * AssetCollection - Collection manager for Asset instances
 *
 * Provides tag management, versioning, tenant-aware queries, and operations for assets
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { queryGlobal, queryWithGlobals } from '@happyvertical/smrt-tenancy';
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
   * Find all global assets (assets without a tenant).
   *
   * Routes through the shared tenant-global helper so it does not throw under
   * an active tenant context (an explicit `tenant_id IS NULL` filter would be
   * flagged as an isolation violation). (#1600)
   *
   * @returns Array of global assets
   */
  async findGlobal(): Promise<Asset[]> {
    return queryGlobal<Asset>(this);
  }

  /**
   * Find assets belonging to a tenant plus all global assets.
   *
   * Fails closed if an active tenant context requests a different tenant's
   * rows; the admin/system path keeps the cross-tenant capability. (#1600)
   *
   * @param tenantId - The tenant ID to include
   * @returns Array of tenant-specific and global assets
   */
  async findWithGlobals(tenantId: string): Promise<Asset[]> {
    return queryWithGlobals<Asset>(this, tenantId, 'Asset.findWithGlobals');
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
    // db.list(table, where) takes the WHERE object directly — not a
    // `{ where }` wrapper (which would filter on a column literally named
    // "where" and throw).
    const rows = await db.list('asset_tags', { tag_slug: tagSlug });

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
    const newVersionNumber = latestVersion.version + 1;

    // Give the new version a distinct, collision-free slug. The assets table is
    // unique on (slug, context, meta_type), so a reused slug would
    // upsert-overwrite an existing row instead of appending a version. Build
    // `<primary-slug>-v<n>` and verify it's not already taken by another version
    // in the chain OR by an unrelated asset — appending a disambiguator until
    // free. (The chain itself is tracked by `primaryVersionId`, not the slug.)
    const primary =
      versions.find((v) => v.id === primaryVersionId) ??
      versions[versions.length - 1];
    const baseSlug = String(primary?.slug ?? '') || 'asset';
    const takenInChain = new Set(
      versions.map((v) => v.slug).filter(Boolean) as string[],
    );
    let candidate = `${baseSlug}-v${newVersionNumber}`;
    for (let attempt = 1; ; attempt += 1) {
      const collides =
        takenInChain.has(candidate) ||
        (await this.get({ slug: candidate })) !== null;
      if (!collides) break;
      candidate = `${baseSlug}-v${newVersionNumber}-${attempt}`;
    }

    // Create new version
    return (await this.create({
      ...latestVersion,
      id: undefined, // Generate new ID
      slug: candidate,
      sourceUri: newSourceUri,
      version: newVersionNumber,
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
    // Use the collection's `list`/`get` (not raw `db.list`) so rows are properly
    // hydrated into `Asset` instances — `Object.assign(new Asset(), rawRow)`
    // would leave snake_case columns (`source_uri`, `primary_version_id`) on the
    // instance and never populate the camelCase fields. The chain is the rows
    // pointing at this primary plus the primary itself; the adapter has no OR, so
    // fetch both and dedupe by id.
    const [chained, primary] = await Promise.all([
      this.list({ where: { primaryVersionId } }) as Promise<Asset[]>,
      this.get({ id: primaryVersionId }) as Promise<Asset | null>,
    ]);

    const byId = new Map<string, Asset>();
    for (const asset of [...(primary ? [primary] : []), ...chained]) {
      if (asset?.id) byId.set(asset.id, asset);
    }

    const assets = Array.from(byId.values());
    assets.sort((a, b) => a.version - b.version);
    return assets;
  }

  /**
   * Get derivative assets of a source asset.
   *
   * Renamed from `getChildren(parentId)` in R3-D to match the rename of
   * the underlying column (`parent_id` → `source_asset_id`) and method
   * (`Asset.getChildren` → `Asset.getDerivatives`).
   *
   * @param sourceAssetId - The source asset ID
   * @returns Array of derivative assets
   */
  async getDerivatives(sourceAssetId: string): Promise<Asset[]> {
    return (await this.list({ where: { sourceAssetId } })) as Asset[];
  }

  /**
   * Get assets by MIME type pattern
   *
   * @param mimePattern - MIME type pattern (e.g., 'image/*', 'video/mp4')
   * @returns Array of matching assets
   */
  async getByMimeType(mimePattern: string): Promise<Asset[]> {
    const pattern = mimePattern.replace('*', '%');
    // Collection `list` (not raw `db.list`) so the rows hydrate into proper
    // `Asset` instances; the `<field> like` operator key is mapped to the column.
    return (await this.list({
      where: { 'mimeType like': pattern },
    })) as Asset[];
  }

  /**
   * Rollback to a previous version by creating a new version with the target's content.
   * Does NOT delete intermediate versions (safe rollback).
   *
   * @param primaryVersionId - The primary version ID of the version chain
   * @param targetVersion - The version number to rollback to
   * @returns The newly created asset version with content copied from target
   */
  async rollbackToVersion(
    primaryVersionId: string,
    targetVersion: number,
  ): Promise<Asset> {
    const versions = await this.listVersions(primaryVersionId);
    const target = versions.find((v) => v.version === targetVersion);

    if (!target) {
      throw new Error(
        `Version ${targetVersion} not found for asset ${primaryVersionId}`,
      );
    }

    // Create a new version that copies the target's sourceUri
    return await this.createNewVersion(primaryVersionId, target.sourceUri, {
      description: `Rollback to version ${targetVersion}`,
    } as Partial<Asset>);
  }

  /**
   * Get assets in a specific folder
   *
   * @param folderId - The folder ID to list contents for
   * @returns Array of assets in this folder
   */
  async getByFolder(folderId: string): Promise<Asset[]> {
    return (await this.list({ where: { folderId } })) as Asset[];
  }
}
