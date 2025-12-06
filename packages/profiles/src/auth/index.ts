/**
 * Auth module exports for smrt-profiles
 *
 * Provides identity resolution and authentication primitives.
 * Apps configure auth (OIDC providers, Nostr), modules receive resolved profiles.
 */

// Magic link service
export {
  createMagicLinkService,
  type InitiateResult,
  type MagicLinkConfig,
  type MagicLinkService,
  type VerifyResult,
} from './magicLinkService';
// NIP-05 handler
export {
  createNip05Handler,
  isValidNip05Identifier,
  type Nip05HandlerConfig,
  type Nip05HandlerResult,
  type Nip05Request,
  parseNip05Identifier,
} from './nip05Handler';
// Nostr crypto utilities
export {
  computeEventId,
  createAuthEvent,
  decryptPrivkey,
  deriveEncryptionKey,
  type EncryptedKey,
  encryptPrivkey,
  generateNostrKeypair,
  getPublicKey,
  isValidPrivkey,
  isValidPubkey,
  type NostrEvent,
  type NostrKeypair,
  npubToPubkey,
  nsecToPrivkey,
  privkeyToNsec,
  pubkeyToNpub,
  signEvent,
  verifyAuthEvent,
  verifyNostrSignature,
} from './nostrCrypto';
// Identity resolution
export {
  type AuthContext,
  createProfileFromNostr,
  createProfileFromOidc,
  type ResolveIdentityResult,
  resolveIdentity,
} from './resolveIdentity';
