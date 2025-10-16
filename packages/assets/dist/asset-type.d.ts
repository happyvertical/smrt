import { SmrtObject } from '../../../core/smrt/src';
import { AssetTypeOptions } from './types';
export declare class AssetType extends SmrtObject {
    slug: string;
    name: string;
    description: string;
    constructor(options?: AssetTypeOptions);
    /**
     * Get asset type by slug
     *
     * @param slug - The slug to search for
     * @returns AssetType instance or null
     */
    static getBySlug(slug: string): Promise<AssetType | null>;
}
//# sourceMappingURL=asset-type.d.ts.map