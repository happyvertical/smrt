import { SmrtObject, SmrtObjectOptions } from '@smrt/core';
export interface ProfileTypeOptions extends SmrtObjectOptions {
    slug?: string;
    name?: string;
    description?: string;
}
export declare class ProfileType extends SmrtObject {
    name: import('@smrt/core').Field;
    description: import('@smrt/core').Field;
    constructor(options?: ProfileTypeOptions);
    /**
     * Convenience method for slug-based lookup
     *
     * @param slug - The slug to search for
     * @returns ProfileType instance or null if not found
     */
    static getBySlug(_slug: string): Promise<ProfileType | null>;
}
//# sourceMappingURL=ProfileType.d.ts.map