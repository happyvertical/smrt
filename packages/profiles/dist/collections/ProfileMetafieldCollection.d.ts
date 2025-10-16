import { SmrtCollection } from '@smrt/core';
import { ProfileMetafield } from '../models/ProfileMetafield';
import { ValidationSchema } from '../types';
export declare class ProfileMetafieldCollection extends SmrtCollection<ProfileMetafield> {
    static readonly _itemClass: typeof ProfileMetafield;
    /**
     * Get metafield by slug
     *
     * @param slug - The slug to search for
     * @returns ProfileMetafield instance or null
     */
    getBySlug(slug: string): Promise<ProfileMetafield | null>;
    /**
     * Get or create a metafield by slug
     *
     * @param slug - The slug to search for
     * @param defaults - Default values if creating
     * @returns ProfileMetafield instance
     */
    getOrCreateBySlug(slug: string, defaults: {
        name: string;
        description?: string;
        validation?: ValidationSchema;
    }): Promise<ProfileMetafield>;
}
//# sourceMappingURL=ProfileMetafieldCollection.d.ts.map