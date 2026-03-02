# @happyvertical/smrt-profiles

Central identity system with multi-auth, relationships, controlled metadata, and audit logging.

## Models

- **Profile** (STI base → Bot, Organization, Person): email (globally unique), `typeId` FK to ProfileType, `metadata`
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

## Key Collection Methods

- `UserCollection.getOrCreateFromOidc(claims, provider)` — creates Profile + OidcIdentity + User in one flow
- `ProfileCollection.addMetadata()`/`getMetadata()` — validates against metafield schema
- `Profile.getRelationships({ direction: 'from'|'to'|'all' })` — direction matters
- AI: `generateBio()` (do), `matches(criteria)` (is)

## Gotchas

- **SERVER_MASTER_SECRET required** for Nostr private key decryption — centralized key management
- **API key never returned again**: `ApiKey.generate()` returns plaintext once; only `keyPrefix` visible later
- **OIDC unique per issuer+subject**: same subject from different issuers = different identities
- **Email unique across all profiles**: DB-level unique constraint, not per-tenant
- **Optional tenancy** on Profile; AuditLog allows super-admin bypass
