import { SmrtObject, SmrtObjectOptions } from '../../../../core/smrt/src';
export interface ProfileTypeOptions extends SmrtObjectOptions {
    slug?: string;
    name?: string;
    description?: string;
}
export declare class ProfileType extends SmrtObject {
    name: any;
    description: any;
    constructor(options?: ProfileTypeOptions);
    /**
     * Convenience method for slug-based lookup
     *
     * @param slug - The slug to search for
     * @returns ProfileType instance or null if not found
     */
    static getBySlug(slug: string): Promise<ProfileType | null>;
}
//# sourceMappingURL=ProfileType.d.ts.map