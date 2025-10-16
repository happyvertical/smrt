import { SmrtCollection } from '../../../core/smrt/src';
import { AssetMetafield } from './asset-metafield';
export declare class AssetMetafieldCollection extends SmrtCollection<AssetMetafield> {
    static readonly _itemClass: typeof AssetMetafield;
    /**
     * Get or create an asset metafield by slug
     *
     * @param slug - The metafield slug
     * @param name - The display name (defaults to slug)
     * @param validation - Optional validation rules (JSON string or object)
     * @returns The existing or newly created AssetMetafield
     */
    getOrCreate(slug: string, name?: string, validation?: string | Record<string, unknown>): Promise<AssetMetafield>;
    /**
     * Initialize common asset metafields
     *
     * Creates standard metafields with validation rules:
     * - width (integer, min: 0)
     * - height (integer, min: 0)
     * - duration (number, min: 0)
     * - size (integer, min: 0)
     * - author (string)
     * - copyright (string)
     */
    initializeCommonMetafields(): Promise<void>;
}
//# sourceMappingURL=asset-metafields.d.ts.map