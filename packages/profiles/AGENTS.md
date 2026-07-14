# @happyvertical/smrt-profiles

Central identity system with multi-auth, relationships, controlled metadata, and audit logging.

## Models

- **Profile** (STI base → Bot, Organization, Person): email (globally unique exact value), readonly indexed `emailKey` derived with `normalizeIdentityEmail()` for adapter-independent identity lookup, `typeId` FK to ProfileType, plus a `metadata` `@oneToMany('ProfileMetadata')` relationship for controlled per-profile values.
- **ProfileAsset**: dedicated owned-asset join in `profile_assets` with `relationship` and `sortOrder`.
- **ProfileRelationship**: bidirectional — creating one auto-creates reciprocal inverse. `contextProfileId` for tertiary relationships. `ProfileRelationshipTerm` tracks start/end dates.
- **ProfileMetafield**: controlled vocabulary with `validationSchema`. **ProfileMetadata**: per-profile values linked to metafields.
- **AuditLog**: action, resourceType/Id, `source` (web/cli/ci/webhook/mcp), `onBehalfOfId` for CI pass-through identity. `allowSuperAdminBypass: true`.

## Auth Methods

| Model | Pattern |
|-------|---------|
| NostrIdentity | Encrypted keypair (AES-256-GCM). Requires `SERVER_MASTER_SECRET` env var for decryption. NIP-05 address generation. |
| OidcIdentity | Multiple issuers (Keycloak/Google/GitHub). Lookup by `issuer + subject` pair. Transactional provisioning derives the readonly nullable unique `identityKey` and backfills legacy rows. |
| ApiKey | SHA-256 hashed. **Plaintext returned once only** on `generate()`. `keyPrefix` for identification. Scope-based with expiry. |
| MagicLinkToken | One-time token with expiry for passwordless auth. |

## Identity Resolution

Auth helpers in `src/auth/` build profiles from external identity claims:

- `resolveIdentity()` — top-level dispatcher that returns/creates a Profile from Nostr signatures, OIDC claims, magic link tokens, or API keys.
- `createProfileFromOidc(claims, provider, options)` — creates `Profile` + `OidcIdentity` for first-time OIDC sign-in using a transaction-capable root database in `options.db`.
- `ProfileCollection.findUniqueGlobalPersonByEmail(email)` — supported
  verified-identity lookup; fails closed on tenant-scoped, non-Person, or
  duplicate case-insensitive matches.
- `ProfileCollection.requireCanonicalGlobalPerson(profileId, email?)` —
  validates an application-selected Profile against the same canonical global
  Person invariant.
- `ProfileCollection.reserveCanonicalIdentityEmail(profileId, email?)` —
  validates and synchronizes the private unique
  `oidc_profile_email_reservations.email_key` used as the database arbiter for
  concurrent external-identity provisioning. Omitting `email` uses the
  Profile's stored address, moving or removing an existing reservation as the
  canonical Profile changes.
- `createProfileFromNostr(email, nostrData)` — creates `Profile` + `NostrIdentity` for Nostr-authenticated users.

## Key Methods

- `Profile.getAssets()` / `addAsset()` / `removeAsset()` and the matching `ProfileCollection` wrappers — canonical owned asset helpers backed by `profile_assets`.
- `Profile.addMetadata(metafieldSlug, value)` / `Profile.getMetadata()` — validates against metafield schema. `ProfileCollection.batchGetMetadata()` / `batchUpdateMetadata()` for bulk reads/writes.
- `Profile.getRelationships({ direction: 'from'|'to'|'all' })` — direction matters.
- `Profile.getRelationshipsFrom()` / `getRelationshipsTo()` — R10-generated `@oneToMany` accessors. ProfileRelationship has two FKs back to Profile, so each `@oneToMany` annotates its inverse explicitly (`{ foreignKey: 'fromProfileId' }` / `'toProfileId'`). Return raw `ProfileRelationship[]`; use `getRelationships()` for slug/direction filtering.
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
- **OIDC unique per issuer+subject**: same subject from different issuers =
  different identities. Both claims are opaque and case-sensitive; preserve
  exact whitespace after using trim only to reject blank values.
- **OIDC identity mutations are trusted-only**: generated REST, MCP, and CLI
  surfaces are read-only. Link or update identities through transactional
  provisioning APIs so callers cannot rebind issuer/subject authority to an
  arbitrary Profile. Deprecated `OidcIdentity.findOrCreate()` preserves only
  transaction-safe exact-link reuse and refuses to create new links;
  `OidcIdentityCollection.linkToProfile()` and `Profile.linkOidcIdentity()`
  delegate to that same non-creating compatibility path.
- **Apply schema migrations for identity race keys**: run `smrt db:status`,
  `smrt db:migrate`, then `smrt db:status` before deploying. Transactional OIDC
  provisioning populates `OidcIdentity.identityKey` and
  `oidc_profile_email_reservations`; legacy rows reserve an address only after
  safe validation. Stop/upgrade old Profile writers, then run the public,
  transactional and idempotent `backfillProfileEmailKeys(db)` from one deploy
  process. Verified-email provisioning and public email-key lookup require the
  standard `_smrt_backfills` readiness marker and fail closed immediately when
  it is absent. This keeps table scans in the explicit deploy step; runtime
  reads use the indexed key and validate only returned candidates.
- **Public OIDC provisioning requires transactions**:
  `createProfileFromOidc()` owns a root transaction or uses a savepoint on an
  already-bound handle. Root adapters must expose `beginTransaction`;
  transaction-only handles are ambiguous and fail closed. Pass the root
  database for adapters without nested savepoints, including DuckDB;
  provisioning fails before durable writes if neither path is safe. Trusted
  framework packages use the private
  `@happyvertical/smrt-profiles/internal/oidc-provisioning` subpath instead of
  duplicating adapter probing, locking, or retry policy, and supply both exact
  issuer/subject and normalized-email lock keys in deterministic order. The
  coordinator additionally serializes all SQLite/DuckDB provisioning
  transactions per database URL because those adapters cannot overlap
  unrelated root transactions safely and retries bounded PostgreSQL
  deadlock/serialization failures. New OIDC Profiles use per-profile,
  non-semantic slugs so duplicate display names never invoke natural-key upsert.
  Caller-owned transactions never execute `_smrt_backfills` DDL; paths that
  perform canonical email lookup or reservation require the table to already
  exist or the caller must retry with the root database. Exact issuer/subject
  reuse skips the email-key readiness-marker lookup, but root coordination still
  initializes the shared tracker table. Caller-owned exact reuse does not
  consult the tracker and therefore does not require that table.
- **Profile-only OIDC linking fails closed on existing email matches**:
  the typed canonical scenario contract is
  `src/testing/oidcProvisioningDecisionMatrix.ts`, executed by both Profiles
  and Users tests; keep public docs pointed at it instead of adding a second
  behavioral table.
  `createProfileFromOidc()` preserves exact issuer/subject reuse, including
  legacy tenant-scoped and non-Person links, but profiles cannot prove whether a
  User owns a same-email Profile. New identities therefore never attach to an
  existing email match through this helper; User/session provisioning still
  rejects unsafe linked Profiles before creating authentication state. Use
  `UserCollection.getOrCreateFromOidc()` for owner-aware verified-email reuse and
  its supported transaction-bound resolver hook.
- **Email storage and identity matching differ**: `Profile.email` has an
  exact-value DB constraint. Identity boundaries query readonly indexed
  `Profile.emailKey`, derived by the shared TypeScript
  `normalizeIdentityEmail()` helper rather than adapter-specific SQL casing or
  trimming, and deliberately fail closed on duplicate normalized keys.
- **Optional tenancy** on Profile; AuditLog allows super-admin bypass
