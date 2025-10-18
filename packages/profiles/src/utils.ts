/**
 * Utility functions for profile operations
 *
 * Provides standalone helper functions for metadata management,
 * relationship operations, and validation.
 *
 * @packageDocumentation
 */

// Utility functions will be implemented as part of Phase 2
// This file serves as a placeholder for the API structure

/**
 * Retrieve all metadata for a profile as a key-value object
 *
 * @param profileId - The UUID of the profile
 * @param options - Database and configuration options
 * @returns Object with metafield slugs as keys and values as values
 */
export async function getProfileMetadata(
  profileId: string,
  options: any = {},
): Promise<Record<string, any>> {
  const { ProfileMetadataCollection } = await import(
    './collections/ProfileMetadataCollection'
  );

  const metadataCollection = await (ProfileMetadataCollection as any).create(options);

  return await metadataCollection.getMetadataObject(profileId);
}

/**
 * Set a single metadata value for a profile
 *
 * @param profileId - The UUID of the profile
 * @param metafieldSlug - The slug of the metafield
 * @param value - The value to set
 * @param options - Database and configuration options
 */
export async function setProfileMetadata(
  profileId: string,
  metafieldSlug: string,
  value: any,
  options: any = {},
): Promise<void> {
  const { ProfileCollection } = await import('./collections/ProfileCollection');

  const profileCollection = await (ProfileCollection as any).create(options);

  const profile = await profileCollection.get({ id: profileId });
  if (!profile) {
    throw new Error(`Profile '${profileId}' not found`);
  }

  await profile.addMetadata(metafieldSlug, value);
}

/**
 * Find profiles with a specific metadata key-value pair
 *
 * @param metafieldSlug - The slug of the metafield to search
 * @param value - The value to match
 * @param options - Database and configuration options
 * @returns Array of matching profile IDs
 */
export async function findProfilesByMeta(
  metafieldSlug: string,
  value: any,
  options: any = {},
): Promise<string[]> {
  const { ProfileMetafieldCollection } = await import(
    './collections/ProfileMetafieldCollection'
  );
  const { ProfileMetadataCollection } = await import(
    './collections/ProfileMetadataCollection'
  );

  // Get metafield by slug
  const metafieldCollection = await (ProfileMetafieldCollection as any).create(options);

  const metafield = await metafieldCollection.getBySlug(metafieldSlug);
  if (!metafield) {
    throw new Error(`Metafield '${metafieldSlug}' not found`);
  }

  // Find all metadata with this metafield and value
  const metadataCollection = await (ProfileMetadataCollection as any).create(options);

  return await metadataCollection.findProfilesByMetadata(metafield.id, value);
}

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
export async function createReciprocalRelationship(
  fromProfile: any,
  toProfile: any,
  relationshipSlug: string,
  contextProfile?: any,
): Promise<void> {
  // The Profile.addRelationship method already handles reciprocal relationships
  await fromProfile.addRelationship(
    toProfile,
    relationshipSlug,
    contextProfile,
  );
}

/**
 * Validate a metadata value against a metafield's validation schema
 *
 * @param metafield - The metafield with validation rules
 * @param value - The value to validate
 * @returns True if valid, throws error if invalid
 */
export async function validateMetadataValue(
  metafield: any,
  value: any,
): Promise<boolean> {
  // The ProfileMetafield.validateValue method already implements validation
  return await metafield.validateValue(value);
}
