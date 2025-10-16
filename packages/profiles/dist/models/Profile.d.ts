import { SmrtObject, SmrtObjectOptions } from '../../../../core/smrt/src';
export interface ProfileOptions extends SmrtObjectOptions {
    typeId?: string;
    email?: string;
    name?: string;
    description?: string;
}
export declare class Profile extends SmrtObject {
    typeId: any;
    email: any;
    name: any;
    description: any;
    metadata: any;
    relationshipsFrom: any;
    relationshipsTo: any;
    constructor(options?: ProfileOptions);
    /**
     * Get the profile type slug for this profile
     *
     * @returns The slug of the profile type
     */
    getTypeSlug(): Promise<string>;
    /**
     * Set the profile type by slug
     *
     * @param slug - The slug of the profile type
     * @throws Error if profile type not found
     */
    setTypeBySlug(slug: string): Promise<void>;
    /**
     * Add metadata to this profile
     *
     * @param metafieldSlug - The slug of the metafield
     * @param value - The value to set
     */
    addMetadata(metafieldSlug: string, value: any): Promise<void>;
    /**
     * Get all metadata for this profile as key-value object
     *
     * @returns Object with metafield slugs as keys
     */
    getMetadata(): Promise<Record<string, any>>;
    /**
     * Update multiple metadata values
     *
     * @param metadata - Object with metafield slugs as keys and values
     */
    updateMetadata(metadata: Record<string, any>): Promise<void>;
    /**
     * Remove metadata by metafield slug
     *
     * @param metafieldSlug - The slug of the metafield to remove
     */
    removeMetadata(metafieldSlug: string): Promise<void>;
    /**
     * Add a relationship to another profile
     *
     * @param toProfile - The target profile
     * @param relationshipSlug - The type of relationship
     * @param contextProfile - Optional context profile for tertiary relationships
     */
    addRelationship(toProfile: Profile, relationshipSlug: string, contextProfile?: Profile): Promise<void>;
    /**
     * Get all relationships for this profile
     *
     * @param options - Filter options (typeSlug, direction)
     * @returns Array of ProfileRelationship instances
     */
    getRelationships(options?: {
        typeSlug?: string;
        direction?: 'from' | 'to' | 'all';
    }): Promise<ProfileRelationship[]>;
    /**
     * Get related profiles
     *
     * @param relationshipSlug - Optional filter by relationship type slug
     * @returns Array of related Profile instances
     */
    getRelatedProfiles(relationshipSlug?: string): Promise<Profile[]>;
    /**
     * Remove a relationship to another profile
     *
     * @param toProfile - The target profile
     * @param relationshipSlug - The type of relationship to remove
     */
    removeRelationship(toProfile: Profile, relationshipSlug: string): Promise<void>;
    /**
     * AI-powered: Generate a professional bio for this profile
     *
     * @returns Generated bio text
     */
    generateBio(): Promise<string>;
    /**
     * AI-powered: Check if profile matches criteria
     *
     * @param criteria - Criteria to match against
     * @returns True if matches criteria
     */
    matches(criteria: string): Promise<boolean>;
    /**
     * Find profiles by metadata key-value pair
     *
     * @param metafieldSlug - The metafield slug to search
     * @param value - The value to match
     * @returns Array of matching profiles
     */
    static findByMetadata(metafieldSlug: string, value: any): Promise<Profile[]>;
    /**
     * Find profiles by type slug
     *
     * @param typeSlug - The profile type slug
     * @returns Array of matching profiles
     */
    static findByType(typeSlug: string): Promise<Profile[]>;
    /**
     * Find related profiles for a given profile
     *
     * @param profileId - The profile UUID
     * @param relationshipSlug - Optional filter by relationship type
     * @returns Array of related profiles
     */
    static findRelated(profileId: string, relationshipSlug?: string): Promise<Profile[]>;
    /**
     * Search profiles by email
     *
     * @param email - The email to search for
     * @returns Profile or null if not found
     */
    static searchByEmail(email: string): Promise<Profile | null>;
}
//# sourceMappingURL=Profile.d.ts.map