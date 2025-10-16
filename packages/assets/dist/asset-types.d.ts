import { SmrtCollection } from '@smrt/core';
import { AssetType } from './asset-type';
export declare class AssetTypeCollection extends SmrtCollection<AssetType> {
    static readonly _itemClass: typeof AssetType;
    /**
     * Get or create an asset type by slug
     *
     * @param slug - The asset type slug
     * @param name - The display name (defaults to slug)
     * @param description - Optional description
     * @returns The existing or newly created AssetType
     */
    getOrCreate(slug: string, name?: string, description?: string): Promise<AssetType>;
    /**
     * Initialize common asset types
     *
     * Creates standard asset types if they don't exist:
     * - image
     * - video
     * - document
     * - audio
     * - folder
     */
    initializeCommonTypes(): Promise<void>;
}
//# sourceMappingURL=asset-types.d.ts.map