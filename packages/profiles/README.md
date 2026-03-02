# @happyvertical/smrt-profiles

Central identity system with multi-auth (Nostr/OIDC/API keys/magic links), relationships, controlled metadata, and audit logging.

## Installation

```bash
pnpm add @happyvertical/smrt-profiles
```

## Usage

```typescript
import {
  Profile,
  ProfileCollection,
  OidcIdentity,
  OidcIdentityCollection,
  ApiKey,
  ApiKeyCollection,
  NostrIdentity,
  generateNostrKeypair,
  createProfileFromOidc,
} from '@happyvertical/smrt-profiles';

// Create a profile
const profile = new Profile({
  name: 'Alice Johnson',
  email: 'alice@example.com',
});
await profile.save();

// OIDC identity (Keycloak/Google/GitHub)
const oidcProfile = await createProfileFromOidc({
  issuer: 'https://accounts.google.com',
  subject: 'abc123',
  email: 'alice@example.com',
  name: 'Alice Johnson',
});

// Nostr identity (encrypted keypair, requires SERVER_MASTER_SECRET)
const keypair = generateNostrKeypair();
const nostr = new NostrIdentity({
  profileId: profile.id,
  pubkey: keypair.pubkey,
});
await nostr.save();

// API key (plaintext returned once only)
const { key, apiKey } = await ApiKey.generate({
  profileId: profile.id,
  scope: 'read:profiles',
  expiresAt: new Date('2025-12-31'),
});
// key = plaintext (store now), apiKey.keyPrefix = visible identifier

// Relationships (auto-creates reciprocal inverse)
const bob = new Profile({ name: 'Bob Smith', email: 'bob@example.com' });
await bob.save();
await profile.addRelationship(bob, 'friend');
const friends = await profile.getRelationships({ direction: 'from' });
```

## API

### Models

| Export | Description |
|--------|------------|
| `Profile` | Core identity (STI base for Bot/Organization/Person) |
| `Bot` | STI subclass for automated agents |
| `Organization` | STI subclass for companies/groups |
| `Person` | STI subclass for individuals |
| `ProfileType` | Profile classification lookup table |
| `ProfileMetadata` | Per-profile metadata values |
| `ProfileMetafield` | Controlled vocabulary with validation schema |
| `ProfileRelationship` | Directional link between two profiles |
| `ProfileRelationshipType` | Relationship classification with reciprocal flag |
| `ProfileRelationshipTerm` | Time-bounded relationship periods |

### Auth Models

| Export | Description |
|--------|------------|
| `OidcIdentity` | OIDC provider identity (issuer + subject) |
| `NostrIdentity` | Nostr keypair with AES-256-GCM encryption |
| `ApiKey` | SHA-256 hashed API key with scope and expiry |
| `MagicLinkToken` | One-time passwordless auth token |
| `AuditLog` | Action/resource audit trail with source tracking |

### Collections

| Export | Description |
|--------|------------|
| `ProfileCollection` | CRUD and query for profiles |
| `ProfileTypeCollection` | Profile type management |
| `ProfileMetadataCollection` | Metadata value operations |
| `ProfileMetafieldCollection` | Metafield vocabulary management |
| `ProfileRelationshipCollection` | Relationship queries |
| `ProfileRelationshipTypeCollection` | Relationship type management |
| `ProfileRelationshipTermCollection` | Term period management |
| `ApiKeyCollection` | API key lookup and management |
| `AuditLogCollection` | Audit log queries |
| `MagicLinkTokenCollection` | Magic link token operations |
| `NostrIdentityCollection` | Nostr identity lookup (includes NIP-05) |
| `OidcIdentityCollection` | OIDC identity lookup |

### Auth Functions

| Export | Description |
|--------|------------|
| `resolveIdentity` | Resolve profile from any auth method |
| `createProfileFromOidc` | Create profile + OIDC identity in one call |
| `createProfileFromNostr` | Create profile + Nostr identity in one call |
| `createAuthEvent` | Create a Nostr auth event |
| `verifyAuthEvent` | Verify a Nostr auth event signature |
| `createMagicLinkService` | Factory for magic link auth service |
| `createNip05Handler` | Factory for NIP-05 address handler |

### Nostr Crypto

| Export | Description |
|--------|------------|
| `generateNostrKeypair` | Generate new Nostr keypair |
| `encryptPrivkey` / `decryptPrivkey` | AES-256-GCM key encryption |
| `deriveEncryptionKey` | Derive encryption key from master secret |
| `getPublicKey` | Derive pubkey from privkey |
| `signEvent` / `computeEventId` | Nostr event signing |
| `verifyNostrSignature` | Verify Nostr signature |
| `pubkeyToNpub` / `npubToPubkey` | Bech32 pubkey conversion |
| `privkeyToNsec` / `nsecToPrivkey` | Bech32 privkey conversion |
| `isValidPubkey` / `isValidPrivkey` | Key validation |
| `parseNip05Identifier` / `isValidNip05Identifier` | NIP-05 parsing |

### Key Types

`ProfileOptions`, `ProfileTypeOptions`, `ProfileMetadataOptions`, `ProfileMetafieldOptions`, `ProfileRelationshipOptions`, `ProfileRelationshipTypeOptions`, `ProfileRelationshipTermOptions`, `OidcIdentityOptions`, `NostrIdentityOptions`, `ApiKeyOptions`, `GenerateKeyResult`, `MagicLinkTokenOptions`, `GenerateTokenResult`, `AuditLogOptions`, `AuditSource`, `AuthContext`, `ResolveIdentityResult`, `InitiateResult`, `VerifyResult`, `MagicLinkConfig`, `MagicLinkService`, `Nip05HandlerConfig`, `Nip05HandlerResult`, `Nip05Request`, `Nip05Response`, `NostrEvent`, `NostrKeypair`, `EncryptedKey`, `ValidationSchema`, `ValidatorFunction`, `ReciprocalHandler`

## Dependencies

- `@happyvertical/smrt-core` -- ORM base classes
- `@happyvertical/ai` -- AI client (SDK)
- `@happyvertical/sql` -- Database operations (SDK)
- `@happyvertical/files` -- Filesystem utilities (SDK)
- `@happyvertical/logger` -- Structured logging (SDK)
- `@happyvertical/utils` -- Shared utilities (SDK)
- `@noble/curves` -- Nostr cryptography
- `bech32` -- Bech32 encoding for Nostr keys
- Peer: `@happyvertical/smrt-tenancy`
