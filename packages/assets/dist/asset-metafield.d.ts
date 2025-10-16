import { SmrtObject } from '@smrt/core';
import { AssetMetafieldOptions } from './types';
export declare class AssetMetafield extends SmrtObject {
    slug: string;
    name: string;
    validation: string;
    constructor(options?: AssetMetafieldOptions);
    /**
     * Get validation rules as parsed object
     *
     * @returns Parsed validation object or empty object if no validation
     */
    getValidation(): Record<string, unknown>;
    /**
     * Set validation rules from object
     *
     * @param rules - Validation rules object
     */
    setValidation(rules: Record<string, unknown>): void;
    /**
     * Get asset metafield by slug
     *
     * @param slug - The slug to search for
     * @returns AssetMetafield instance or null
     */
    static getBySlug(slug: string): Promise<AssetMetafield | null>;
}
//# sourceMappingURL=asset-metafield.d.ts.map