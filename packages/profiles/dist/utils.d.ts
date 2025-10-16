/**
 * Utility functions for profile operations
 *
 * Provides standalone helper functions for metadata management,
 * relationship operations, and validation.
 *
 * @packageDocumentation
 */
/**
 * Retrieve all metadata for a profile as a key-value object
 *
 * @param profileId - The UUID of the profile
 * @param options - Database and configuration options
 * @returns Object with metafield slugs as keys and values as values
 */
export declare function getProfileMetadata(profileId: string, options?: any): Promise<Record<string, any>>;
/**
 * Set a single metadata value for a profile
 *
 * @param profileId - The UUID of the profile
 * @param metafieldSlug - The slug of the metafield
 * @param value - The value to set
 * @param options - Database and configuration options
 */
export declare function setProfileMetadata(profileId: string, metafieldSlug: string, value: any, options?: any): Promise<void>;
/**
 * Find profiles with a specific metadata key-value pair
 *
 * @param metafieldSlug - The slug of the metafield to search
 * @param value - The value to match
 * @param options - Database and configuration options
 * @returns Array of matching profile IDs
 */
export declare function findProfilesByMeta(metafieldSlug: string, value: any, options?: any): Promise<string[]>;
/**
 * Create a reciprocal relationship between two profiles
 *
 * This is a convenience function that creates a relationship and automatically
 * handles the reciprocal relationship based on the relationship type configuration.
 *
 * @param fromProfile - The initiating profile
 * @param toProfile - The target profile
 * @param relationshipSlug - The type of relationship
 * @param contextProfile - Optional context profile for tertiary relationships
 */
export declare function createReciprocalRelationship(fromProfile: any, toProfile: any, relationshipSlug: string, contextProfile?: any): Promise<void>;
/**
 * Validate a metadata value against a metafield's validation schema
 *
 * @param metafield - The metafield with validation rules
 * @param value - The value to validate
 * @returns True if valid, throws error if invalid
 */
export declare function validateMetadataValue(metafield: any, value: any): Promise<boolean>;
//# sourceMappingURL=utils.d.ts.map