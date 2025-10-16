import { SmrtCollection } from '@smrt/core';
import { ProfileRelationshipType } from '../models/ProfileRelationshipType';
export declare class ProfileRelationshipTypeCollection extends SmrtCollection<ProfileRelationshipType> {
    static readonly _itemClass: typeof ProfileRelationshipType;
    /**
     * Get relationship type by slug
     *
     * @param slug - The slug to search for
     * @returns ProfileRelationshipType instance or null
     */
    getBySlug(slug: string): Promise<ProfileRelationshipType | null>;
    /**
     * Get or create a relationship type by slug
     *
     * @param slug - The slug to search for
     * @param defaults - Default values if creating
     * @returns ProfileRelationshipType instance
     */
    getOrCreateBySlug(slug: string, defaults: {
        name: string;
        reciprocal?: boolean;
    }): Promise<ProfileRelationshipType>;
    /**
     * Get all reciprocal relationship types
     *
     * @returns Array of reciprocal ProfileRelationshipType instances
     */
    getReciprocal(): Promise<ProfileRelationshipType[]>;
    /**
     * Get all directional (non-reciprocal) relationship types
     *
     * @returns Array of directional ProfileRelationshipType instances
     */
    getDirectional(): Promise<ProfileRelationshipType[]>;
}
//# sourceMappingURL=ProfileRelationshipTypeCollection.d.ts.map