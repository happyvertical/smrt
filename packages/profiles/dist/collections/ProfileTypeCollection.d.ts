import { SmrtCollection } from '../../../../core/smrt/src';
import { ProfileType } from '../models/ProfileType';
export declare class ProfileTypeCollection extends SmrtCollection<ProfileType> {
    static readonly _itemClass: typeof ProfileType;
    /**
     * Get profile type by slug
     *
     * @param slug - The slug to search for
     * @returns ProfileType instance or null
     */
    getBySlug(slug: string): Promise<ProfileType | null>;
    /**
     * Get or create a profile type by slug
     *
     * @param slug - The slug to search for
     * @param defaults - Default values if creating
     * @returns ProfileType instance
     */
    getOrCreateBySlug(slug: string, defaults: {
        name: string;
        description?: string;
    }): Promise<ProfileType>;
}
//# sourceMappingURL=ProfileTypeCollection.d.ts.map