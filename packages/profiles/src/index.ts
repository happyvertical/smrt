/**
 * @happyvertical/smrt-profiles
 *
 * Profile management system with relationships, metadata, reciprocal associations,
 * and authentication primitives (OIDC, Nostr, API keys, audit logging).
 *
 * @packageDocumentation
 */

// Self-register this package's manifest before any @smrt() decorator fires
// downstream. Must come first so the side effect runs ahead of the class
// module loads below. See __smrt-register__.ts for issue #1132 context.
import './__smrt-register__';

// Auth module - Identity resolution
// Auth module - Nostr crypto
// Auth module - Magic link service
// Auth module - NIP-05 handler
export {
  type AuthContext,
  computeEventId,
  createAuthEvent,
  createMagicLinkService,
  createNip05Handler,
  createProfileFromNostr,
  createProfileFromOidc,
  decryptPrivkey,
  deriveEncryptionKey,
  type EncryptedKey,
  encryptPrivkey,
  generateNostrKeypair,
  getPublicKey,
  type InitiateResult,
  isValidNip05Identifier,
  isValidPrivkey,
  isValidPubkey,
  type MagicLinkConfig,
  type MagicLinkService,
  type Nip05HandlerConfig,
  type Nip05HandlerResult,
  type Nip05Request,
  type NostrEvent,
  type NostrKeypair,
  npubToPubkey,
  nsecToPrivkey,
  parseNip05Identifier,
  privkeyToNsec,
  pubkeyToNpub,
  type ResolveIdentityResult,
  resolveIdentity,
  signEvent,
  type VerifyResult,
  verifyAuthEvent,
  verifyNostrSignature,
} from './auth';

// Auth-related collections
export { ApiKeyCollection } from './collections/ApiKeyCollection';
export { AuditLogCollection } from './collections/AuditLogCollection';
export { MagicLinkTokenCollection } from './collections/MagicLinkTokenCollection';
export {
  type Nip05Response,
  NostrIdentityCollection,
} from './collections/NostrIdentityCollection';
export { OidcIdentityCollection } from './collections/OidcIdentityCollection';
export { ProfileAssetCollection } from './collections/ProfileAssetCollection';
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
export type {
  GenerateTokenResult,
  MagicLinkTokenOptions,
} from './models/MagicLinkToken';
export { MagicLinkToken } from './models/MagicLinkToken';
export type { NostrIdentityOptions } from './models/NostrIdentity';
export { NostrIdentity } from './models/NostrIdentity';
export type { OidcIdentityOptions } from './models/OidcIdentity';
export { OidcIdentity } from './models/OidcIdentity';
// Export model option types
export type { ProfileOptions } from './models/Profile';
export { Profile } from './models/Profile';
// Export models
export type { ProfileAssetOptions } from './models/ProfileAsset';
export { ProfileAsset } from './models/ProfileAsset';
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
