import { SmrtCollection } from '../../../../core/smrt/src';
import { Profile } from '../models/Profile';
export declare class ProfileCollection extends SmrtCollection<Profile> {
    static readonly _itemClass: typeof Profile;
    /**
     * Find profiles by type slug
     *
     * @param typeSlug - The profile type slug to filter by
     * @returns Array of matching profiles
     */
    findByType(typeSlug: string): Promise<Profile[]>;
    /**
     * Batch get metadata for multiple profiles
     *
     * @param profileIds - Array of profile UUIDs
     * @returns Map of profile ID to metadata object
     */
    batchGetMetadata(profileIds: string[]): Promise<Map<string, Record<string, any>>>;
    /**
     * Batch update metadata for multiple profiles
     *
     * @param updates - Array of { profileId, data } objects
     */
    batchUpdateMetadata(updates: Array<{
        profileId: string;
        data: Record<string, any>;
    }>): Promise<void>;
    /**
     * Find related profiles for a given profile
     *
     * @param profileId - The profile UUID
     * @param relationshipSlug - Optional filter by relationship type
     * @returns Array of related profiles
     */
    findRelated(profileId: string, relationshipSlug?: string): Promise<Profile[]>;
    /**
     * Get the relationship network for a profile up to a maximum depth
     *
     * @param profileId - The starting profile UUID
     * @param options - Configuration options
     * @returns Map of profile ID to depth level
     */
    getRelationshipNetwork(profileId: string, options?: {
        maxDepth?: number;
    }): Promise<Map<string, number>>;
}
//# sourceMappingURL=ProfileCollection.d.ts.map