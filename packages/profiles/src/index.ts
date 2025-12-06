/**
 * @happyvertical/smrt-profiles
 *
 * Profile management system with relationships, metadata, reciprocal associations,
 * and authentication primitives (OIDC, API keys, audit logging).
 *
 * @packageDocumentation
 */

// Auth module
export {
  type AuthContext,
  createProfileFromOidc,
  type ResolveIdentityResult,
  resolveIdentity,
} from './auth';
// Auth-related collections
export { ApiKeyCollection } from './collections/ApiKeyCollection';
export { AuditLogCollection } from './collections/AuditLogCollection';
export { OidcIdentityCollection } from './collections/OidcIdentityCollection';
// Export collections
export { ProfileCollection } from './collections/ProfileCollection';
export { ProfileMetadataCollection } from './collections/ProfileMetadataCollection';
export { ProfileMetafieldCollection } from './collections/ProfileMetafieldCollection';
export { ProfileRelationshipCollection } from './collections/ProfileRelationshipCollection';
export { ProfileRelationshipTermCollection } from './collections/ProfileRelationshipTermCollection';
export { ProfileRelationshipTypeCollection } from './collections/ProfileRelationshipTypeCollection';
export { ProfileTypeCollection } from './collections/ProfileTypeCollection';
export type { ApiKeyOptions, GenerateKeyResult } from './models/ApiKey';
// Auth-related models
export { ApiKey } from './models/ApiKey';
export type { AuditLogOptions, AuditSource } from './models/AuditLog';
export { AuditLog } from './models/AuditLog';
export type { OidcIdentityOptions } from './models/OidcIdentity';
export { OidcIdentity } from './models/OidcIdentity';
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
