/**
 * SMRT model exports for profiles package
 */

// Auth-related models
export { ApiKey, type ApiKeyOptions, type GenerateKeyResult } from './ApiKey';
export { AuditLog, type AuditLogOptions, type AuditSource } from './AuditLog';
export {
  type GenerateTokenResult,
  MagicLinkToken,
  type MagicLinkTokenOptions,
} from './MagicLinkToken';
export { NostrIdentity, type NostrIdentityOptions } from './NostrIdentity';
export { OidcIdentity, type OidcIdentityOptions } from './OidcIdentity';
export { Profile } from './Profile';
export { ProfileMetadata } from './ProfileMetadata';
export { ProfileMetafield } from './ProfileMetafield';
export { ProfileRelationship } from './ProfileRelationship';
export { ProfileRelationshipTerm } from './ProfileRelationshipTerm';
export { ProfileRelationshipType } from './ProfileRelationshipType';
export { ProfileType } from './ProfileType';
// Profile subclasses (STI)
export { Bot, Organization, Person } from './ProfileTypes';
