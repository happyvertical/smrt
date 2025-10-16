import { SmrtObject } from '@smrt/core';
import { AssetStatusOptions } from './types';
export declare class AssetStatus extends SmrtObject {
    slug: string;
    name: string;
    description: string;
    constructor(options?: AssetStatusOptions);
    /**
     * Get asset status by slug
     *
     * @param slug - The slug to search for
     * @returns AssetStatus instance or null
     */
    static getBySlug(slug: string): Promise<AssetStatus | null>;
}
//# sourceMappingURL=asset-status.d.ts.map