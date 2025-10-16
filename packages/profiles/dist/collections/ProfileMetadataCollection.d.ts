import { SmrtCollection } from '../../../../core/smrt/src';
import { ProfileMetadata } from '../models/ProfileMetadata';
export declare class ProfileMetadataCollection extends SmrtCollection<ProfileMetadata> {
    static readonly _itemClass: typeof ProfileMetadata;
    /**
     * Get all metadata for a profile
     *
     * @param profileId - The profile UUID
     * @returns Array of ProfileMetadata instances
     */
    getByProfile(profileId: string): Promise<ProfileMetadata[]>;
    /**
     * Get metadata as key-value object for a profile
     *
     * @param profileId - The profile UUID
     * @returns Object with metafield slugs as keys
     */
    getMetadataObject(profileId: string): Promise<Record<string, any>>;
    /**
     * Find all profiles with a specific metadata key-value pair
     *
     * @param metafieldId - The metafield UUID
     * @param value - The value to match
     * @returns Array of profile UUIDs
     */
    findProfilesByMetadata(metafieldId: string, value: any): Promise<string[]>;
}
//# sourceMappingURL=ProfileMetadataCollection.d.ts.map