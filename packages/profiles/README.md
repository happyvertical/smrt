# @happyvertical/smrt-profiles

Central identity system with multi-auth (Nostr/OIDC/API keys/magic links), relationships, controlled metadata, and audit logging.

## Installation

```bash
pnpm add @happyvertical/smrt-profiles @happyvertical/sql
```

## Usage

```typescript
import {
  backfillProfileEmailKeys,
  createProfileFromOidc,
} from '@happyvertical/smrt-profiles';
import { getDatabase } from '@happyvertical/sql';

// Connect after applying schema migrations.
const persistence = { type: 'sqlite' as const, url: 'file:profiles.db' };
// Mark migrated Profile email keys ready before enabling OIDC provisioning.
const db = await getDatabase(persistence);
await backfillProfileEmailKeys(db);

// Provision a new OIDC Profile or reuse its exact issuer/subject link.
const { profile, oidcIdentity, created } = await createProfileFromOidc(
  {
    iss: 'https://accounts.google.com',
    sub: 'abc123',
    email: 'olivia@example.com',
    email_verified: true,
    name: 'Olivia Smith',
  },
  'google',
  { db },
);
```

### Owned assets

```typescript
import { AssetCollection } from '@happyvertical/smrt-assets';
import { ProfileCollection } from '@happyvertical/smrt-profiles';

const profiles = await ProfileCollection.create({ db });
const assets = await AssetCollection.create({ db });

const headshot = await assets.create({
  name: 'alice-headshot.jpg',
  sourceUri: 'file:///tmp/alice-headshot.jpg',
  mimeType: 'image/jpeg',
});

await profile.addAsset(headshot, 'avatar');
await profiles.addAsset(profile.id!, headshot, 'gallery', 1);

const avatarAssets = await profile.getAssets('avatar');
const galleryAssets = await profiles.getAssets(profile.id!, 'gallery');
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
| `ProfileAsset` | Dedicated owned-asset join stored in `profile_assets` with `relationship` and `sortOrder` |

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
| `ProfileAssetCollection` | Direct access to `profile_assets` rows plus asset helper wrappers |
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

`ProfileCollection.findUniqueGlobalPersonByEmail(email)` is the supported
verified-identity lookup. It reads across tenant scopes and returns a Profile
only when the case-insensitive email has exactly one match and that row is a
global `Person`; tenant-scoped, non-Person, and duplicate matches throw a
`CanonicalPersonProfileError`. Matching uses readonly, indexed
`Profile.emailKey`, derived with the exported TypeScript
`normalizeIdentityEmail()` helper so Unicode casing and whitespace behave the
same on every database adapter. Use
`requireCanonicalGlobalPerson(profileId, email?)` to validate an
application-selected Profile against the same invariant. When `email` is
omitted, the helper validates uniqueness using the Profile's current stored
email. `reserveCanonicalIdentityEmail(profileId, email)` additionally claims
the normalized address in the private
`oidc_profile_email_reservations` table. Omit `email` to synchronize the
reservation from the Profile's current stored email; changing the address moves
the reservation, and clearing it removes the reservation. Legacy simple
`Person` STI discriminators remain valid and are handled by core's normal
upgrade path.

`OidcIdentity.identityKey` stores a nullable, unique issuer/subject natural key
for transaction-safe first-login races. The model derives it from issuer and
subject on every save, so callers cannot desynchronize it. New links populate
it and legacy rows backfill it when reused. Issuer and subject are opaque,
case-sensitive OIDC identifiers: surrounding whitespace is preserved and is
part of the key; trimming is used only to reject an all-whitespace claim. The
generated REST, MCP, and CLI surfaces are read-only because identity mutation
is an authentication authority change; trusted callers link identities through
the transactional provisioning APIs. The legacy
`OidcIdentity.findOrCreate()` method is deprecated: it transactionally reuses
one exact safe issuer/subject link for compatibility but refuses to create a
new authentication link. Use `createProfileFromOidc()` or the users package's
owner-aware provisioning API for creation. The deprecated
`OidcIdentityCollection.linkToProfile()` and `Profile.linkOidcIdentity()`
helpers delegate to the same exact-reuse-only path and cannot plant or rebind a
link.
Existing installations must stop or upgrade legacy Profile writers, run
`smrt db:status`, `smrt db:migrate`, and then `smrt db:status` before deploying
this version to add the identity keys and private email-reservation table. Then
run `backfillProfileEmailKeys(db)` once from a single deploy process before
enabling verified-email provisioning. The transaction-safe backfill is
idempotent; canonical email lookup and reservation fail closed with
`email_key_backfill_required` while the standard `_smrt_backfills` readiness
marker is absent. Exact issuer/subject reuse does not depend on email-key
readiness because it does not perform email-based linking.
The identity-boundary helpers use the readiness guard and indexed key. The
general-purpose `ProfileCollection.findByEmail()` retains its compatible legacy
lookup behavior and is not suitable for identity linking. Only the explicit
deploy-time backfill scans the Profile table and records readiness; guarded
runtime identity lookups use the indexed key and validate returned candidates.
`createProfileFromOidc()` requires a transaction-capable database. Pass the
root database, which must expose `beginTransaction`, and s-m-r-t owns the
transaction; an already transaction-bound handle is supported through a
savepoint. Paths that perform canonical email lookup or reservation require
`_smrt_backfills` to exist first. Provisioning never attempts tracker DDL on
a caller-owned transaction; for those paths, if the table is absent, pass the
root database so s-m-r-t can initialize it outside the transaction. Exact
issuer/subject reuse skips the email-key readiness-marker lookup, but root
coordination still initializes the shared tracker table. Caller-owned exact
reuse does not consult the tracker and therefore does not require that table.
A handle exposing only `transaction()` is ambiguous and fails closed. For
adapters without nested savepoint support, including DuckDB, pass
the root database rather than calling the helper inside an outer transaction.
Provisioning fails before durable writes when neither safe path is available.
The typed [OIDC provisioning decision matrix](./src/testing/oidcProvisioningDecisionMatrix.ts)
is the canonical package-by-package behavior contract. It records exact reuse,
new identity and resolver outcomes, readiness, retries, adapter support, public
errors, and permitted row creation; the Profiles and Users suites execute its
applicable rows directly. In particular, Profile-only exact reuse preserves an
established legacy link because it creates no User/session authentication state,
while `UserCollection.getOrCreateFromOidc()` remains owner-aware and fail-closed.
Use the Users API for verified-email reuse and application reconciliation. Its
`authorizeProfileOwner` option is the only supported exception for a new
issuer/subject targeting a pre-provisioned owned Person: the users package
atomically verifies the canonical Profile, sole approved owner, matching User
email, and non-rebindable identity. Without that explicit application
authorization, the owned Profile still returns `profile_owned`.

`Profile` and `ProfileCollection` both expose `getAssets()`, `addAsset()`, and
`removeAsset()` helpers backed by `profile_assets`. Typical relationships are
`avatar`, `gallery`, and `attachment`.

### Auth Functions

| Export | Description |
|--------|------------|
| `resolveIdentity` | Resolve profile from any auth method |
| `createProfileFromOidc` | Create a Profile + OIDC identity or reuse an exact issuer/subject link; existing email matches fail closed |
| `normalizeIdentityEmail` | Adapter-independent Unicode/whitespace email canonicalizer used by identity keys |
| `backfillProfileEmailKeys` | Transactionally populate normalized keys for migrated Profiles |
| `PROFILE_EMAIL_KEY_BACKFILL_NAME` | Durable readiness-marker name recorded by the Profile email-key backfill |
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

`ProfileOptions`, `ProfileTypeOptions`, `ProfileMetadataOptions`, `ProfileMetafieldOptions`, `ProfileRelationshipOptions`, `ProfileRelationshipTypeOptions`, `ProfileRelationshipTermOptions`, `OidcIdentityOptions`, `CanonicalPersonProfileErrorCode`, `NostrIdentityOptions`, `ApiKeyOptions`, `GenerateKeyResult`, `MagicLinkTokenOptions`, `GenerateTokenResult`, `AuditLogOptions`, `AuditSource`, `AuthContext`, `ResolveIdentityResult`, `InitiateResult`, `VerifyResult`, `MagicLinkConfig`, `MagicLinkService`, `Nip05HandlerConfig`, `Nip05HandlerResult`, `Nip05Request`, `Nip05Response`, `NostrEvent`, `NostrKeypair`, `EncryptedKey`, `ValidationSchema`, `ValidatorFunction`, `ReciprocalHandler`

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
