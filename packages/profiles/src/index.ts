/**
 * @have/profiles
 *
 * Profile management system with relationships, metadata, and reciprocal associations
 *
 * @packageDocumentation
 */

// Export models
export { Profile } from './models/Profile';
export { ProfileType } from './models/ProfileType';
export { ProfileMetafield } from './models/ProfileMetafield';
export { ProfileMetadata } from './models/ProfileMetadata';
export { ProfileRelationship } from './models/ProfileRelationship';
export { ProfileRelationshipType } from './models/ProfileRelationshipType';
export { ProfileRelationshipTerm } from './models/ProfileRelationshipTerm';

// Export collections
export { ProfileCollection } from './collections/ProfileCollection';
export { ProfileTypeCollection } from './collections/ProfileTypeCollection';
export { ProfileMetafieldCollection } from './collections/ProfileMetafieldCollection';
export { ProfileMetadataCollection } from './collections/ProfileMetadataCollection';
export { ProfileRelationshipCollection } from './collections/ProfileRelationshipCollection';
export { ProfileRelationshipTypeCollection } from './collections/ProfileRelationshipTypeCollection';
export { ProfileRelationshipTermCollection } from './collections/ProfileRelationshipTermCollection';

// Export types
export type {
  ReciprocalHandler,
  ValidationSchema,
  ValidatorFunction,
} from './types';
