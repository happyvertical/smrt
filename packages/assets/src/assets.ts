/**
 * AssetCollection - Collection manager for Asset instances
 *
 * Provides tag management, versioning, tenant-aware queries, and operations for assets
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { type Tag, TagCollection } from '@happyvertical/smrt-tags';
import { queryGlobal, queryWithGlobals } from '@happyvertical/smrt-tenancy';
import { Asset } from './asset';
import type { AssetTag } from './asset-tag';
import type { AssetTagCollection } from './asset-tags';

/** Tag context used for asset tags unless a caller names another. */
export const ASSET_TAG_CONTEXT = 'asset';

export interface AssetTagInput {
  /** Display name for a newly created tag (defaults to the label given). */
  name?: string;
  /** Tag context (namespace); defaults to {@link ASSET_TAG_CONTEXT}. */
  context?: string;
}

/** The slug a tag label is stored under: `Town hall` → `town-hall`. */
export function assetTagSlug(label: string): string {
  return String(label ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function titleFromSlug(slug: string): string {
  const words = slug.replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

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

  // ─────────────────────────────────────────────────────────────────────────────
  // Tags (asset_tags → @happyvertical/smrt-tags Tag)
  // ─────────────────────────────────────────────────────────────────────────────

  private async assetTagCollection(): Promise<AssetTagCollection> {
    const { AssetTagCollection } = await import('./asset-tags');
    return AssetTagCollection.create({ db: this.db });
  }

  private async tagCollection(): Promise<TagCollection> {
    return TagCollection.create({ db: this.db });
  }

  private async requireAsset(assetId: string): Promise<Asset> {
    const asset = (await this.get({ id: assetId })) as Asset | null;
    if (!asset?.id) throw new Error(`Asset '${assetId}' not found`);
    return asset;
  }

  /**
   * Find the asset's tag for `tag` (a slug or a label) in the asset's own
   * tenant, optionally creating it. A tag of another tenant is never used.
   */
  private async resolveAssetTag(
    asset: Asset,
    tag: string,
    options: AssetTagInput & { create: boolean },
  ): Promise<Tag | null> {
    const slug = assetTagSlug(tag);
    if (!slug) throw new Error('A tag needs at least one letter or digit');
    const context = options.context ?? ASSET_TAG_CONTEXT;
    const tags = await this.tagCollection();
    const matches = (await tags.list({
      where: asset.tenantId
        ? { slug, context, tenantId: asset.tenantId }
        : { slug, context },
      limit: 10,
    })) as Tag[];
    const existing = matches.find(
      (candidate) => (candidate.tenantId ?? null) === (asset.tenantId ?? null),
    );
    if (existing || !options.create) return existing ?? null;

    const trimmed = tag.trim();
    return (await tags.create({
      slug,
      name:
        options.name?.trim() ||
        (trimmed !== slug ? trimmed : titleFromSlug(slug)),
      context,
      level: 0,
      tenantId: asset.tenantId ?? null,
    })) as Tag;
  }

  /**
   * Add a tag to an asset. `tag` is a slug (`town-hall`) or a label
   * (`Town hall`); the tag is found or created in the asset's tenant under
   * `context` (default {@link ASSET_TAG_CONTEXT}). Adding a tag twice is a
   * no-op. Returns the Tag.
   *
   * @throws when the asset does not exist (or is not visible in the active
   *   tenant context)
   */
  async addTag(
    assetId: string,
    tag: string,
    options: AssetTagInput = {},
  ): Promise<Tag> {
    const asset = await this.requireAsset(assetId);
    const resolved = (await this.resolveAssetTag(asset, tag, {
      ...options,
      create: true,
    })) as Tag;
    const links = await this.assetTagCollection();
    const existing = await links.byLeft(asset.id as string, {
      tagId: resolved.id,
    });
    if (existing.length === 0) {
      await links.attach(asset.id as string, resolved.id as string, {
        tenantId: asset.tenantId ?? null,
      });
    }
    return resolved;
  }

  /**
   * Remove a tag (slug or label) from an asset. Unknown tags are ignored.
   * The Tag itself is kept; only the link goes.
   */
  async removeTag(
    assetId: string,
    tag: string,
    options: Pick<AssetTagInput, 'context'> = {},
  ): Promise<void> {
    const asset = await this.requireAsset(assetId);
    const resolved = await this.resolveAssetTag(asset, tag, {
      ...options,
      create: false,
    });
    if (!resolved?.id) return;
    const links = await this.assetTagCollection();
    await links.detach(asset.id as string, resolved.id);
  }

  /**
   * Make the asset's tags (in `context`) exactly `tags`: missing ones are
   * added, others in the same context removed. Returns the resulting Tags.
   */
  async setTags(
    assetId: string,
    tags: string[],
    options: Pick<AssetTagInput, 'context'> = {},
  ): Promise<Tag[]> {
    const asset = await this.requireAsset(assetId);
    const context = options.context ?? ASSET_TAG_CONTEXT;
    const wanted: Tag[] = [];
    const seen = new Set<string>();
    for (const tag of tags) {
      const slug = assetTagSlug(tag);
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      wanted.push(await this.addTag(asset.id as string, tag, { context }));
    }
    const wantedIds = new Set(wanted.map((tag) => tag.id));
    const current = await asset.getTags();
    for (const tag of current) {
      if (tag.context === context && !wantedIds.has(tag.id)) {
        await this.removeTag(asset.id as string, tag.slug, { context });
      }
    }
    return wanted;
  }

  /**
   * Tags for many assets in two queries, keyed by asset id (assets without
   * tags map to an empty list). Useful for list views.
   */
  async getTagsForAssets(assetIds: string[]): Promise<Map<string, Tag[]>> {
    const result = new Map<string, Tag[]>();
    const ids = [...new Set(assetIds.filter(Boolean))];
    for (const id of ids) result.set(id, []);
    if (ids.length === 0) return result;

    const links = await this.assetTagCollection();
    const rows = (await links.list({
      where: { 'assetId in': ids },
    })) as AssetTag[];
    if (rows.length === 0) return result;

    const tags = await this.tagCollection();
    const tagById = new Map(
      (
        (await tags.listByIds([
          ...new Set(rows.map((row) => row.tagId)),
        ])) as Tag[]
      )
        .filter((tag) => tag.id)
        .map((tag) => [tag.id as string, tag]),
    );
    for (const row of rows) {
      const tag = tagById.get(row.tagId);
      if (tag) result.get(row.assetId)?.push(tag);
    }
    for (const list of result.values()) {
      list.sort((a, b) => a.name.localeCompare(b.name));
    }
    return result;
  }

  /**
   * Get all assets with a specific tag (slug or label), within the active
   * tenant context.
   */
  async getByTag(
    tag: string,
    options: Pick<AssetTagInput, 'context'> = {},
  ): Promise<Asset[]> {
    const slug = assetTagSlug(tag);
    if (!slug) return [];
    const tags = await this.tagCollection();
    const matches = (await tags.list({
      where: { slug, context: options.context ?? ASSET_TAG_CONTEXT },
    })) as Tag[];
    const tagIds = matches.map((match) => match.id).filter(Boolean) as string[];
    if (tagIds.length === 0) return [];

    const links = await this.assetTagCollection();
    const rows = (await links.list({
      where: { 'tagId in': tagIds },
    })) as AssetTag[];
    const assetIds = [...new Set(rows.map((row) => row.assetId))];
    if (assetIds.length === 0) return [];
    return (await this.listByIds(assetIds)) as Asset[];
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
