import { SmrtCollection } from '@smrt/core';
import { Asset } from './asset';
export declare class AssetCollection extends SmrtCollection<Asset> {
    static readonly _itemClass: typeof Asset;
    /**
     * Add a tag to an asset (uses @smrt/tags)
     *
     * @param assetId - The asset ID to tag
     * @param tagSlug - The tag slug from @smrt/tags
     */
    addTag(assetId: string, tagSlug: string): Promise<void>;
    /**
     * Remove a tag from an asset
     *
     * @param assetId - The asset ID
     * @param tagSlug - The tag slug to remove
     */
    removeTag(assetId: string, tagSlug: string): Promise<void>;
    /**
     * Get all assets with a specific tag
     *
     * @param tagSlug - The tag slug to filter by
     * @returns Array of assets with this tag
     */
    getByTag(tagSlug: string): Promise<Asset[]>;
    /**
     * Get assets by type
     *
     * @param typeSlug - The asset type slug (e.g., 'image', 'video')
     * @returns Array of assets matching the type
     */
    getByType(typeSlug: string): Promise<Asset[]>;
    /**
     * Get assets by status
     *
     * @param statusSlug - The asset status slug (e.g., 'published', 'draft')
     * @returns Array of assets matching the status
     */
    getByStatus(statusSlug: string): Promise<Asset[]>;
    /**
     * Get assets by owner
     *
     * @param ownerProfileId - The profile ID of the owner
     * @returns Array of assets owned by this profile
     */
    getByOwner(ownerProfileId: string): Promise<Asset[]>;
    /**
     * Create a new version of an existing asset
     *
     * @param primaryVersionId - The primary version ID (first version's ID)
     * @param newSourceUri - The new source URI for this version
     * @param updates - Optional additional updates
     * @returns The newly created asset version
     */
    createNewVersion(primaryVersionId: string, newSourceUri: string, updates?: Partial<Asset>): Promise<Asset>;
    /**
     * Get the latest version of an asset
     *
     * @param primaryVersionId - The primary version ID
     * @returns The latest version or null
     */
    getLatestVersion(primaryVersionId: string): Promise<Asset | null>;
    /**
     * List all versions of an asset
     *
     * @param primaryVersionId - The primary version ID
     * @returns Array of all asset versions, ordered by version number
     */
    listVersions(primaryVersionId: string): Promise<Asset[]>;
    /**
     * Get child assets (derivatives) of a parent asset
     *
     * @param parentId - The parent asset ID
     * @returns Array of child assets
     */
    getChildren(parentId: string): Promise<Asset[]>;
    /**
     * Get assets by MIME type pattern
     *
     * @param mimePattern - MIME type pattern (e.g., 'image/*', 'video/mp4')
     * @returns Array of matching assets
     */
    getByMimeType(mimePattern: string): Promise<Asset[]>;
}
//# sourceMappingURL=assets.d.ts.map