import { SmrtObject } from '../../../../core/smrt/src';
import { PlaceTypeOptions } from '../types';
export declare class PlaceType extends SmrtObject {
    description: string;
    createdAt: Date;
    updatedAt: Date;
    constructor(options?: PlaceTypeOptions);
    /**
     * Convenience method for slug-based lookup
     *
     * @param slug - The slug to search for
     * @returns PlaceType instance or null if not found
     */
    static getBySlug(slug: string): Promise<PlaceType | null>;
}
//# sourceMappingURL=PlaceType.d.ts.map