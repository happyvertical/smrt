/**
 * @have/profiles
 *
 * Profile management system with relationships, metadata, and reciprocal associations
 *
 * @packageDocumentation
 */

// Export collections
export { ProfileCollection } from './collections/ProfileCollection';
export { ProfileMetadataCollection } from './collections/ProfileMetadataCollection';
export { ProfileMetafieldCollection } from './collections/ProfileMetafieldCollection';
export { ProfileRelationshipCollection } from './collections/ProfileRelationshipCollection';
export { ProfileRelationshipTermCollection } from './collections/ProfileRelationshipTermCollection';
export { ProfileRelationshipTypeCollection } from './collections/ProfileRelationshipTypeCollection';
export { ProfileTypeCollection } from './collections/ProfileTypeCollection';
// Export model option types
export type { ProfileOptions } from './models/Profile';
// Export models
export { Profile } from './models/Profile';
export type { ProfileMetadataOptions } from './models/ProfileMetadata';
export { ProfileMetadata } from './models/ProfileMetadata';
export type { ProfileMetafieldOptions } from './models/ProfileMetafield';
export { ProfileMetafield } from './models/ProfileMetafield';
export type { ProfileRelationshipOptions } from './models/ProfileRelationship';
export { ProfileRelationship } from './models/ProfileRelationship';
export type { ProfileRelationshipTermOptions } from './models/ProfileRelationshipTerm';
export { ProfileRelationshipTerm } from './models/ProfileRelationshipTerm';
export type { ProfileRelationshipTypeOptions } from './models/ProfileRelationshipType';
export { ProfileRelationshipType } from './models/ProfileRelationshipType';
export type { ProfileTypeOptions } from './models/ProfileType';
export { ProfileType } from './models/ProfileType';
// Export profile subclasses (STI)
export { Bot, Organization, Person } from './models/ProfileTypes';
// Export types
export type {
  ReciprocalHandler,
  ValidationSchema,
  ValidatorFunction,
} from './types';
