# @happyvertical/smrt-profiles

Central identity system with multi-auth, relationships, controlled metadata, and audit logging.

## Models

- **Profile** (STI base → Bot, Organization, Person): email (globally unique), `typeId` FK to ProfileType, plus a `metadata` `@oneToMany('ProfileMetadata')` relationship for controlled per-profile values.
- **ProfileAsset**: dedicated owned-asset join in `profile_assets` with `relationship` and `sortOrder`.
- **ProfileRelationship**: bidirectional — creating one auto-creates reciprocal inverse. `contextProfileId` for tertiary relationships. `ProfileRelationshipTerm` tracks start/end dates.
- **ProfileMetafield**: controlled vocabulary with `validationSchema`. **ProfileMetadata**: per-profile values linked to metafields.
- **AuditLog**: action, resourceType/Id, `source` (web/cli/ci/webhook/mcp), `onBehalfOfId` for CI pass-through identity. `allowSuperAdminBypass: true`.

## Auth Methods

| Model | Pattern |
|-------|---------|
| NostrIdentity | Encrypted keypair (AES-256-GCM). Requires `SERVER_MASTER_SECRET` env var for decryption. NIP-05 address generation. |
| OidcIdentity | Multiple issuers (Keycloak/Google/GitHub). Lookup by `issuer + subject` pair. `findOrCreate()` for first login. |
| ApiKey | SHA-256 hashed. **Plaintext returned once only** on `generate()`. `keyPrefix` for identification. Scope-based with expiry. |
| MagicLinkToken | One-time token with expiry for passwordless auth. |

## Identity Resolution

Auth helpers in `src/auth/` build profiles from external identity claims:

- `resolveIdentity()` — top-level dispatcher that returns/creates a Profile from Nostr signatures, OIDC claims, magic link tokens, or API keys.
- `createProfileFromOidc(claims, provider)` — creates `Profile` + `OidcIdentity` for first-time OIDC sign-in.
- `createProfileFromNostr(email, nostrData)` — creates `Profile` + `NostrIdentity` for Nostr-authenticated users.

## Key Methods

- `Profile.getAssets()` / `addAsset()` / `removeAsset()` and the matching `ProfileCollection` wrappers — canonical owned asset helpers backed by `profile_assets`.
- `Profile.addMetadata(metafieldSlug, value)` / `Profile.getMetadata()` — validates against metafield schema. `ProfileCollection.batchGetMetadata()` / `batchUpdateMetadata()` for bulk reads/writes.
- `Profile.getRelationships({ direction: 'from'|'to'|'all' })` — direction matters.
- AI: `generateBio()` (uses `smrtProfiles.profile.generateBio` prompt via `@happyvertical/smrt-prompts`), `matches(criteria)` (delegates to `is()`).

## Prompt Registry

`generateBio()` is registered with `@happyvertical/smrt-prompts` so tenants can override template/model/params at runtime:

```typescript
import { smrtProfilesGenerateBioPrompt } from '@happyvertical/smrt-profiles';
// key: 'smrtProfiles.profile.generateBio'
```

## Gotchas

- **SERVER_MASTER_SECRET required** for Nostr private key decryption — centralized key management
- **API key never returned again**: `ApiKey.generate()` returns plaintext once; only `keyPrefix` visible later
- **OIDC unique per issuer+subject**: same subject from different issuers = different identities
- **Email unique across all profiles**: DB-level unique constraint, not per-tenant
- **Optional tenancy** on Profile; AuditLog allows super-admin bypass
