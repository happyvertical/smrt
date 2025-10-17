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
// Export models
export { Profile } from './models/Profile';
export { ProfileMetadata } from './models/ProfileMetadata';
export { ProfileMetafield } from './models/ProfileMetafield';
export { ProfileRelationship } from './models/ProfileRelationship';
export { ProfileRelationshipTerm } from './models/ProfileRelationshipTerm';
export { ProfileRelationshipType } from './models/ProfileRelationshipType';
export { ProfileType } from './models/ProfileType';

// Export types
export type {
  ReciprocalHandler,
  ValidationSchema,
  ValidatorFunction,
} from './types';
