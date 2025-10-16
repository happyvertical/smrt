import { SmrtCollection } from '@smrt/core';
import { ProfileRelationship } from '../models/ProfileRelationship';
export declare class ProfileRelationshipCollection extends SmrtCollection<ProfileRelationship> {
    static readonly _itemClass: typeof ProfileRelationship;
    /**
     * Get all relationships from a profile
     *
     * @param fromProfileId - The origin profile UUID
     * @param typeId - Optional filter by relationship type UUID
     * @returns Array of ProfileRelationship instances
     */
    getFromProfile(fromProfileId: string, typeId?: string): Promise<ProfileRelationship[]>;
    /**
     * Get all relationships to a profile
     *
     * @param toProfileId - The target profile UUID
     * @param typeId - Optional filter by relationship type UUID
     * @returns Array of ProfileRelationship instances
     */
    getToProfile(toProfileId: string, typeId?: string): Promise<ProfileRelationship[]>;
    /**
     * Get all relationships for a profile (both directions)
     *
     * @param profileId - The profile UUID
     * @param typeId - Optional filter by relationship type UUID
     * @returns Array of ProfileRelationship instances
     */
    getForProfile(profileId: string, typeId?: string): Promise<ProfileRelationship[]>;
    /**
     * Check if a relationship exists between two profiles
     *
     * @param fromProfileId - The origin profile UUID
     * @param toProfileId - The target profile UUID
     * @param typeId - The relationship type UUID
     * @returns True if relationship exists
     */
    exists(fromProfileId: string, toProfileId: string, typeId: string): Promise<boolean>;
}
//# sourceMappingURL=ProfileRelationshipCollection.d.ts.map