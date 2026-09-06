# OIDC provisioning

Read for changes to `src/collections/UserCollection.ts`, `src/services/OidcLoginService.ts`,
OIDC handlers, or identity migrations. The canonical scenario matrix is
`packages/profiles/src/testing/oidcProvisioningDecisionMatrix.ts`.

- **OIDC `email_verified` is enforced.** `UserCollection.getOrCreateFromOidc`
  refuses to provision a user when the IdP explicitly returns
  `email_verified: false` (opt out with `{ allowUnverifiedEmail: true }`). An
  absent claim makes no assertion and is not enforced.
- **RFC 9207 response issuer is exact.** OIDC callbacks validate a supplied
  `iss` against discovered metadata with exact string comparison before trusting
  a code or error. If metadata advertises issuer-response support, `iss` is
  required.
- **Verified-email Profile reuse is fail-closed.** The typed canonical scenarios
  live in
  `packages/profiles/src/testing/oidcProvisioningDecisionMatrix.ts`; both
  package suites execute that matrix and public docs reference it rather than
  maintaining another behavioral table. Default provisioning reuses only one
  unowned, global `Person`. Tenant-scoped, non-Person, duplicate-email,
  and already-owned matches fail before User/session creation. An existing
  issuer/subject link without a User must still be the unique global Person for
  the current verified claim email; once owned, the stable issuer/subject link
  reuses its canonical Person and owner.
  Issuer and subject are opaque, case-sensitive identifiers; preserve their
  exact value and use trim only to reject blank claims.
- **`resolveProfile` is the application reconciliation boundary.** The
  SvelteKit handlers, `OidcLoginService`, and `getOrCreateFromOidc` accept the
  same hook inside the provisioning transaction. The service/handler path
  supplies protocol-validated claims; direct collection callers must validate
  and trust their claim source before calling `getOrCreateFromOidc`.
  Token/userinfo merging keeps `email` and `email_verified` paired to the same
  claim source; verification is never borrowed across sources.
  Resolver reads/writes use the supplied `db`, and the hook must be idempotent
  because a concurrent unique-key conflict can retry it. `undefined` chooses
  the secure default and `null` rejects, including exact issuer/subject reuse.
  For a new identity, a supplied Profile is still validated as the unique,
  unowned global Person for the verified email. For an exact existing identity,
  it must be the already-linked Profile and cannot rebind identity authority;
  stable-link owner and canonical-Person checks still apply. The hook receives a
  separate frozen claims snapshot; internal retry and persistence state is not
  exposed for mutation.
- **Owned first binding requires `authorizeProfileOwner`.** An invitation or
  approval workflow may explicitly return both its pre-provisioned canonical
  global `Person` and existing approved `User` from this transaction-bound
  hook. `undefined` keeps the secure `profile_owned` default and `null`
  rejects. SMRT treats only the selected IDs as input, reloads them in the
  provisioning transaction, and requires `email_verified === true`, the unique
  canonical global Person for the normalized claim email, exactly one owner,
  that owner as the selected User, and the same normalized User email. The
  hook runs before identity/User/session creation and may be retried, so use
  only its supplied `db` and `users` handles and keep application authorization
  idempotent. Never authorize from email matching alone. Existing exact
  identities cannot be rebound; when `resolveProfile` is also present both
  hooks must select the same Profile.
- **OIDC first login is atomic.** The Profile, `OidcIdentity`, and User are one
  transaction. The database arbiters are `OidcIdentity.identityKey`,
  private `oidc_profile_email_reservations.email_key`, `User.emailKey`, and the
  unique `User.profileId`; local callbacks acquire exact issuer/subject and normalized
  email locks in deterministic order so changed email claims also serialize.
  SQLite and DuckDB callbacks additionally serialize every root-handle statement
  the coordinator owns per database URL — `_smrt_backfills` initialization, the
  transaction, and the post-commit rebind — because one adapter multiplexes a
  single native connection and cannot safely overlap unrelated root
  transactions. Never overlap two statements on one such handle, inside a
  transaction or not: rebind and owner/email candidate reads are sequential,
  never `Promise.all`. Owner-authorized DuckDB callbacks use that same
  root-handle serialization;
  PostgreSQL deadlock and serialization errors use a bounded transaction retry.
  Newly provisioned Profiles use non-semantic per-profile slugs so equal IdP
  display names cannot trigger a natural-key upsert;
  run
  `smrt db:status`, `smrt db:migrate`, then `smrt db:status` before deployment.
  Stop or upgrade old writers first. Before migration, group
  non-null `users.profile_id` values, then reconcile duplicates. After
  migration, run public `backfillProfileEmailKeys(db)`,
  `backfillUserEmailKeys(db)`, then `backfillLegacyUserProfiles(db)` from one
  deploy process. The first two use the shared
  TypeScript `normalizeIdentityEmail()` implementation transactionally and are
  idempotent; the User backfill fails before writes if normalized duplicates
  remain. The legacy Profile backfill transactionally creates canonical global
  Persons for null/blank User links without creating OIDC identities or
  inferring ownership; reconcile any same-email Profile or reservation before
  retrying. Its marker records a completed pass but never skips newly imported
  legacy Users on a later run. Every OIDC path requires the Profile email-key
  readiness marker; creating a User or checking User email uniqueness
  additionally requires the User marker. A stable issuer/subject with an
  existing owning User skips only the User email-key lookup and marker. Full
  scans remain in the explicit deploy step; guarded runtime paths use indexed
  keys and validate only returned candidates. Multiple null links remain valid.
  Legacy race keys backfill only after canonical validation. Pass a root
  database on adapters such as DuckDB that cannot create nested savepoints.
  Root adapters must expose `beginTransaction`; transaction-only handles are
  ambiguous and fail closed before provisioning writes. Caller-owned
  transactions never run `_smrt_backfills` DDL and require that table to
  already exist; use the root database when initialization or recovery is
  needed.
