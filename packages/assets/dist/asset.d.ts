import { SmrtObject } from '@smrt/core';
import { Tag } from '@smrt/tags';
import { AssetStatus } from './asset-status';
import { AssetType } from './asset-type';
import { AssetOptions } from './types';
export declare class Asset extends SmrtObject {
    name: string;
    slug: string;
    sourceUri: string;
    mimeType: string;
    description: string;
    version: number;
    primaryVersionId: string | null;
    typeSlug: string;
    statusSlug: string;
    ownerProfileId: string | null;
    parentId: string | null;
    createdAt: Date;
    updatedAt: Date;
    constructor(options?: AssetOptions);
    /**
     * Get all tags for this asset from @smrt/tags
     *
     * @returns Array of Tag instances from @smrt/tags package
     */
    getTags(): Promise<Tag[]>;
    /**
     * Check if this asset has a specific tag
     *
     * @param tagSlug - The slug of the tag to check
     * @returns True if the asset has this tag
     */
    hasTag(tagSlug: string): Promise<boolean>;
    /**
     * Get the parent asset (if this is a derivative)
     *
     * @returns Parent Asset instance or null
     */
    getParent(): Promise<Asset | null>;
    /**
     * Get all derivative assets (children)
     *
     * @returns Array of child Asset instances
     */
    getChildren(): Promise<Asset[]>;
    /**
     * Get the type of this asset
     *
     * @returns AssetType instance or null
     */
    getType(): Promise<AssetType | null>;
    /**
     * Get the status of this asset
     *
     * @returns AssetStatus instance or null
     */
    getStatus(): Promise<AssetStatus | null>;
    /**
     * Get asset by slug
     *
     * @param slug - The slug to search for
     * @returns Asset instance or null
     */
    static getBySlug(_slug: string): Promise<Asset | null>;
}
//# sourceMappingURL=asset.d.ts.map