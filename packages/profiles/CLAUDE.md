# @happyvertical/smrt-profiles

Profile management system with relationships, metadata, reciprocal associations, and authentication for people, organizations, and entities.

## Architecture

```
src/
  index.ts                          # Export barrel
  models/
    Profile.ts                      # Core profile entity (STI base)
    ProfileTypes.ts                 # Bot, Organization, Person (STI subclasses)
    ProfileType.ts                  # Profile type lookup
    ProfileMetadata.ts              # Key-value metadata storage
    ProfileMetafield.ts             # Controlled vocabulary with validation schemas
    ProfileRelationship.ts          # Directional relationships between profiles
    ProfileRelationshipType.ts      # Relationship type lookup with reciprocal flag
    ProfileRelationshipTerm.ts      # Time periods for relationships
    ApiKey.ts                       # API key management
    AuditLog.ts                     # Audit logging
    MagicLinkToken.ts               # Magic link authentication tokens
    NostrIdentity.ts                # Nostr protocol identity
    OidcIdentity.ts                 # OpenID Connect identity
  collections/                      # One collection per model
  auth/
    nostrCrypto.ts                  # Nostr signing and verification
    nip05Handler.ts                 # NIP-05 protocol handler
    magicLinkService.ts             # Magic link authentication flow
    resolveIdentity.ts              # Identity resolution across auth methods
  types.ts                          # Type definitions
```

## Models

### Profile (STI base)

Central entity with `name`, `email`, `description`, `profileType`, and `metadata`. Tenancy-optional. STI subclasses: `Bot`, `Organization`, `Person`.

**Methods**: `getTypeSlug()`, `setTypeBySlug()`, `addMetadata()`, `getMetadata()`, `updateMetadata()`

### ProfileRelationship

Connects two profiles with directional or reciprocal associations.

**Methods**: `getTypeSlug()`, `addTerm()`, `endCurrentTerm()`, `getTerms()`

### Auth Models

- **ApiKey** — API key management with scoping
- **AuditLog** — Tracks actions for compliance
- **MagicLinkToken** — Passwordless authentication tokens
- **NostrIdentity** — Nostr protocol keypair linking
- **OidcIdentity** — OpenID Connect identity linking

## Key Patterns

- **STI inheritance**: Profile > Bot, Organization, Person share one table
- **Reciprocal relationships**: Creating a relationship auto-creates the reverse
- **Temporal tracking**: Relationship terms track time periods (start/end dates)
- **Flexible metadata**: ProfileMetafield provides controlled vocabulary with validation schemas
- **Multi-auth**: Supports Nostr, OIDC, API keys, and magic links

## Key Exports

`Profile`, `ProfileCollection`, `ProfileRelationship`, `ProfileType`, `Bot`, `Organization`, `Person`, `ApiKey`, `AuditLog`

## Dependencies

- `@happyvertical/smrt-core`, `@happyvertical/smrt-tenancy`
- `@happyvertical/ai`, `@happyvertical/sql`, `@happyvertical/files`, `@happyvertical/utils`, `@happyvertical/logger`
- `@noble/curves`, `bech32` (for Nostr crypto)
