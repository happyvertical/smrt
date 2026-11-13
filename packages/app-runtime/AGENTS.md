# @happyvertical/smrt-app-runtime

Application infrastructure composition for the validated runtime profiles in
`@happyvertical/smrt-config`.

## Local profile

- `validateApplicationId()` is the canonical strict validator for explicit app
  IDs. `encodeApplicationId()` derives a length-bounded, collision-resistant
  ID from package names; generated operational surfaces must share these APIs.
- `initializeLocalApplicationRuntime()` owns user data paths, SQLite tuning,
  local application-secret creation, and the single-use owner bootstrap flow.
- SQLite is acquired through `@happyvertical/sql`'s explicit
  `{ driver: 'node:sqlite', custody: 'trusted-parent' }` boundary after the
  runtime establishes its user-owned mode-0700 data root.
- The initialization lease lives beside the data root
  (`<parent>/.smrt-lease-<key>/initialization.sqlite`, #3877), then the legacy
  `/tmp/.smrt-<uid>/<key>` lease, which older releases take alone: secure when
  its ancestry is trusted, else lock-only (owner check on unmapped ancestors
  relaxed, nothing written; skipped only if its directory cannot be created
  and no lock file exists). It is required (secure) when the parent cannot hold
  a lease. Legacy candidates, deduplicated and in this order: the in-namespace
  uid, then that uid mapped through `/proc/self/uid_map` (identity when absent;
  unparseable/non-covering fails closed); ownership checks still use the
  in-namespace uid. The beside-data lease taken first keeps that order
  deadlock-free. Only the in-namespace candidate (when it differs) is skipped
  if its root is an existing real directory owned by another uid. Acquire in that order; never make the
  lease location configurable per process — every process sharing a data root
  must derive the same lease.
- `secretMasterKey()` (`src/local-secret-master-key.ts`) is the smrt-secrets
  master key for the local profile: created once in the `VaultKeyStore`
  (default file store in a `.smrt-keys-<root name>` sibling of the data root,
  injectable via `vaultKeyStore`), under the initialization lock. Hex for
  `SecretService.create({ masterKeyProvider })` only; errors carry no key,
  path or cause. Deployed profiles return `null` (env var only); never add a
  generated or default key outside the local profile.
- Filesystem custody (preflight, data-root and lease construction, markers, the
  application secret, no-follow opens) lives in `src/local-custody.ts`; it is
  internal (not exported from the package). `index.ts` only composes it into the
  public entry points. `LocalRuntimeError` lives in `src/local-runtime-error.ts`.
- Windows has its own custody rule (README "Windows", smrt#4837): Node has no
  `O_NOFOLLOW`, uid, mode bits or DACL access there. Module map, `icacls`
  locking, test seams and the SDDL rule: [agents/windows-custody.md](agents/windows-custody.md).
- First start (smrt#4835, `src/local-schema.ts`): with `createSchema` the
  local runtime creates its schema before serving, inside the initialization
  lock (plus the web writer lease), via the framework's `migrateSmrtSchemas`
  (the `smrt db:migrate` path; never a second creator). The SvelteKit runtime
  defaults it on; direct `initializeLocalApplicationRuntime` defaults off so
  operator tooling (`smrt app setup` spawns `db:migrate`) is unchanged. Local
  only; deployed profiles keep `DB_SCHEMA_MISSING`. First run (no tracker or
  bootstrap table): framework step and `prepareDatabase` share ONE
  transaction; failure rolls back and removes a database file the attempt
  created (secret and root marker stay). Later starts: the framework batch is
  one atomic DDL transaction on the database (a transaction handle has no
  `getTableSchema`), then `prepareDatabase` in its own transaction.
- `prepareDatabase(db, context)` is the app hook the desktop shell builds on;
  keep name and shape. It runs on EVERY start after the framework step
  (idempotent). `context`: `db`, `profile`, `paths` (null deployed), `firstRun`,
  `migrateSchemas()`; `(db)` callers still work. Its rejection is
  `migration_failed`; a framework-step failure is `schema_creation_failed`
  (fixed text, cause only as non-enumerable `cause`, root retryable). A refused
  migrate is `schema_migration_refused`, nothing applied: [agents/local-schema.md](agents/local-schema.md). Call `assertMigrationAccepted(result)` before `applied`.
  Tests of creation set `SMRT_VITEST_AUTO_SCHEMA=0` (the shared setup
  otherwise pre-creates every registered table).
- Standalone migration commands must call `prepareLocalDatabaseStorage()`
  before opening SQLite so custody is established without creating schema or
  bootstrap records.
- Read-only/copy/import operator commands must call
  `validateLocalDatabaseStorage()` before opening SQLite; it verifies the
  app-bound marker, source separation, real path chain, ownership, and mode
  without creating or repairing storage.
- Owner bootstrap creates normal `Person`, `User`, `Tenant`, owner `Role` /
  `Membership`, and `Session` records in one transaction. `ownerTenant`
  selects the tenant slug (default `default`); because `Tenant` upserts on
  slug, the claim must look the slug up first and fail closed
  (`owner_tenant_conflict`) rather than save over it. `adoptExisting` adopts
  only an active root tenant with zero memberships (#3032). Fresh tenant
  creation uses `TenantService` with the local ownership policy and a trusted
  reserved identity. Default tenant and owner graph IDs derive from the
  protected per-install application secret. Preserve that file when restoring
  the same installation. A missing seed in an initialized root fails closed
  (`installation_seed_missing`) and is never regenerated.
- Bootstrap is loopback-only. Only an HMAC of the short-lived token is stored.
  A token that cannot claim fails a read-only preflight before role/catalog
  seeding (#3323); the claim transaction's conditional UPDATE stays the
  authority for single use, expiry, and concurrency.
- Local MCP tokens (`mcpTokens`, `openLocalMcpTokenStore`, `smrt app token`):
  owner-bound, scoped, revocable. No `expiresInSeconds` = renewable: 30 d window
  slid by `verify()` (conditional UPDATE, at most hourly via `last_used_at`;
  never revives expired/revoked, never shortens, best effort); explicit TTL
  (60 s..365 d) = fixed, never slides. Optional `holder`: `issue` rotates in one
  transaction (revoke old + insert new; partial unique index backstop);
  `revokeHolder` for device removal (no local caller exists). NULL
  holder/sliding on old rows = no holder, fixed; `ensureLocalMcpTokenTable`
  adds columns idempotently. Reseed changes the HMAC key, voiding all tokens.
  Only a
  domain-separated HMAC (application secret) is stored, in the runtime-owned
  `_smrt_local_mcp_tokens` system table (created like the bootstrap table;
  never application schema). Issue refuses scopes the owner lacks; verify
  returns token scopes ∩ live permissions and `null` for anything else.
- Bearer binding is explicit (`tenantBinding`, set by the auth adapter;
  `direct-membership.ts`): `direct` (local tokens, default hosted resolver)
  needs an active direct membership in exactly the tenant; the default
  `direct-or-inherited` (hosted app mappings) applies
  `isSessionTenantAuthorized`'s rule. The direct row, when present, is pinned
  into `PermissionResolver`, so inheritance never substitutes for it.
  `verify()` principals (and their `scopes` arrays) are frozen;
  `runAsPrincipal` takes a validated, deep-frozen, null-prototype copy of
  the principal before any await (`plain-data.ts`: own data only; poison
  keys `__proto__`/`constructor`/`prototype`, accessors, inherited or
  non-plain data, sparse arrays and functions rejected), authorizes from it,
  and hands `fn` that snapshot. Token `issue()` input is read the same way.
  They carry
  `tenantBinding: 'direct'` and the
  `LOCAL_MCP_TOKEN_PRINCIPAL` brand; `runAsPrincipal` rejects a copy that
  widens the binding, so the two public APIs compose safely.
  Return bearer material only to the issuing operator or the authenticated
  desktop credential response. The opt-in `createLocalMcpCredentialHandler`
  requires a direct loopback peer, matching Host and exact Origin, and the sole
  active owner's first-class session. Desktop slots use a disjoint ID namespace,
  atomic hash replacement and terminal revocation. See the desktop protocol in
  [README.md](README.md). The operator store opens an
  uncached connection and takes no writer lease (revocation is per request).
- Installation custody (`installation-custody.ts`, #4704): the data root's
  `secrets/installation.json` travels with copies; the state root's
  `installation.json` stays at the location; matching `activationId`s mean
  in custody. Unattributable arrivals fail closed (`installation_unverified`)
  until `restore` (asserts origin retired; epoch +1), `reseed` (new seed,
  identities and seed-keyed tokens change; needs `confirmDestroySeed`), `recover-seed` or `retire`
  (`smrt app installation`). A fresh seed always establishes custody; a
  pre-existing seed never does. Record and seed reads use `O_NOFOLLOW`, owner
  and mode checks; writes are atomic. The state root must persist with the
  data volume (Linux containers: `XDG_STATE_HOME` on that volume, never `HOME`
  or `/tmp`); the refusal names it. Decision and limits: README.
- `origin.json` (`origin-file.ts`, #4729): the local web process records its
  exact `http://127.0.0.1:<port>` (from `ORIGIN`, set by the desktop
  supervisor; anything else writes nothing) in the state root, per location and
  not in backups, removes it on exit/SIGTERM/SIGINT. `readOriginFile` is the
  only reader contract: `null` unless private, exact and the pid is alive; the
  reader still probes. It holds no secret; keep it that way.
- Background jobs and application-defined paid capabilities are default-off.
- The embedded runner reuses `TaskRunner`; it is not a second job contract.

## Device entitlement cache (`./device-entitlements`, #4787)

- Signed (Ed25519, `node:crypto`), time-limited snapshot of the feature keys
  one account grants one device, so a local install knows its tier offline.
  `signDeviceEntitlementSnapshot` runs only on the issuing cloud/billing host;
  `verifyDeviceEntitlementSnapshot` / `DeviceEntitlementCache` run on the
  install. Trusted public keys (`trustedKeys`, by key id, rotation = several)
  come from application configuration, never the cache file or data root: that
  is why a local install cannot mint its own. Signature is checked before any
  payload field is read; signed bytes are domain-prefixed
  (`smrt-device-entitlement-v1\0`); the payload `keyId` must equal the
  envelope's.
- Anything but a valid snapshot (absent, expired, tampered, wrong
  account/device, future-dated beyond `clockSkewMs`, lifetime above
  `maxLifetimeMs`, older than the watermark, unreadable) is the Local tier with
  no keys. `status()` and `grantSource()` never throw; `install()`/`refresh()`
  report a reason and keep what is stored. Invalid *configuration* (non-Ed25519
  or private key, empty key set, out-of-range durations) throws at construction.
- Entitlement cache reads and installs share `<filePath>.lock`; its watermark
  records issuance, observed time and signed-envelope identity before replacement.
  Rollback, replay and lock contention fail closed; only authenticated expiry
  dates are exposed. See [cache persistence](README.md#device-entitlement-cache)
  for legacy, retry and standalone-verifier behavior.
- Grace (`gracePeriodMs`, default 0, max 30 d) keeps keys on past `expiresAt`
  (`state: 'grace'`); skew applies to `issuedAt` only, never extends expiry.
- Features integration is structural: `cache.grantSource()` is a
  `FeatureGrantSource` for `FeatureResolver`/`requireFeature`, or
  `registerDeviceEntitlementGrantSource()` writes the
  `Symbol.for('@happyvertical/smrt-features:grant-source')` slot. This package
  must not import `smrt-features`: its dev tooling depends on `smrt-cli`, which
  depends on this package (a cycle). The transport for `refresh()` is injected.

## Deployed profiles

- `initializeDeployedApplicationRuntime()` composes only `self-hosted` and
  `cloud`; it rejects local initialization and provider/binding mismatches.
- Provider bindings own credentials, vendor clients, and readiness checks.
  Runtime diagnostics contain selectors and status only.
- The database binding must expose a provider-owned `close` callback before
  `connect` can run. The runtime owns that cleanup boundary and runs the
  application's explicit, idempotent `prepareDatabase` hook.
- A failed startup cleanup throws `DeployedRuntimeCleanupError`; callers retain
  and retry its idempotent `retryCleanup()` boundary until it succeeds.
- Public authentication, asset storage, and secret bindings are mandatory and
  readiness-checked before startup succeeds.
- `createTaskWorker()` and `createScheduleWorker()` initialize the normal jobs
  package runners against the shared PostgreSQL database. They are intended for
  separate processes; the web process does not start them automatically. A
  task worker polls `default` plus `SCHEDULED_JOB_QUEUE` (`agents`, where
  `ScheduleRunner` enqueues) unless `queues` is passed (#3141). The
  worker process must import the app's compiled registration
  (`.smrt/runtime/register.js`, #3117) first; runners resolve `objectType`
  through the registry and never load application source themselves.
- `close()` drains in-flight readiness/session/worker initialization and
  serialized runner start/stop operations, stops every runner returned by the
  runtime, and then closes PostgreSQL. Returned runners must not be restarted
  after runtime shutdown begins.
- A tracked operation may await a re-entrant `close()` request without
  deadlocking; external `close()` callers still await complete cleanup.
- `health()` is process liveness. `readiness()` probes database/auth/assets/
  secrets; it does not claim that an external worker fleet is running.
- Database-provider readiness is additive; a PostgreSQL-specific server-version
  probe always gates startup and live readiness.
- Cloud must keep required tenant context and must never introduce a root or
  unscoped tenant fallback. RLS remains an explicit deployment/migration choice.

## SvelteKit entry (`./sveltekit`)

- Server-only subpath; `@sveltejs/kit` is an optional peer and is externalized
  in `vite.config.ts` (kit recognizes `redirect`/`fail` by class identity).
  Consumer apps use core's `smrt()` preset to bundle the Kit-facing entry into
  their SSR output and dedupe Kit; `./sveltekit-runtime` and the root stay external
  to preserve native dependency loading. The implementation subpath is for
  build composition; apps keep importing `./sveltekit`.
  Package-build externalization alone does not preserve class identity through adapter-node's final production bundle.
  The root entry must never import kit or Svelte.
- Without a `runtime` option the profile comes from smrt-config's
  `resolveEffectiveApplicationRuntime(await loadConfig())`, the same rule as
  `smrt app` (#3446): no block → `local`; `null`/`false`/`0`/`''` fail closed.
- `createSmrtSvelteKitRuntime()` order is fixed: readiness gate → URL tenant
  selection (`locals.selectedTenant*`, never tenant context, headers ignored) →
  verified session (tenant context entered only when
  `isSessionTenantAuthorized()` accepts it, else unauthenticated; never via
  `createSessionHandler`, which re-runs `resolve` on downstream errors) →
  publish `locals.tenantContext` only for that verified tenant.
- `database-rls` isolation forces `postgresRls: true`, including on
  `skipPaths` (anonymous principal). `resolve` runs at most once;
  session-layer failure before it is a 500 with cleared locals.
- In an RLS request `classOptions()`/`databaseConfig()` return the
  transaction-bound request db (class `db` overrides win). Anything that
  outlives a request (session service, tenant selector) must use the base
  config, never these. `runtime.database()` is the same rule for a service
  that takes a `DatabaseInterface` (preference store): the request db in an
  RLS request, else the runtime's own handle; never close it.
- The local writer lease defaults to `defaultWriterLease()` (root
  `acquireWriterLease` over `prepareApplicationStateRoot`, presenting
  `SMRT_OPERATION_INSTANCE`); `acquireWriterLease` replaces it, `false` opts
  out, deployed profiles never take it. Provider readiness stays injected:
  apps pass `createProviderReadinessProbe`; deployed startup fails closed
  without `providerReadiness`.
- `getCollection()` builds from `classOptions()` on every call (RLS request db
  inside a request); each generated route's embedded prelude imports the
  app's `smrt.ts` and reaches it through core's
  `createGeneratedCollectionAccess()` (a legacy accessor export wins,
  deprecated for one release).
- Owner setup removes the `smrt app` onboarding hand-off files by default,
  immediately after the claim commits (before cookie serialization or hooks);
  `onOwnerClaimed` is for additional cleanup and
  `removeOnboardingHandoff: false` is the explicit opt-out.
- `createSessionLayoutLoad()` adds `session.user` (`{ id, email, name? }`
  copied from `locals.user`, else `null`). `createSignOutHandler(runtime)` is
  the `POST` handler for `src/routes/sign-out/+server.ts`: 405 for other
  methods, 403 unless `Sec-Fetch-Site: same-origin` or `Origin` equals the
  request origin, then `destroySessionCookie` with the runtime's cookie
  name/path/domain (cookie cleared even if the session row is gone); 204, or
  303 to `/` when the request accepts HTML.
- `createOwnerLinkHandler(runtime, { autoClaim: true })` (opt-in) signs the
  desktop person in after every launch-secret/loopback check via
  `runtime.signInLocalOwner` -> `LocalApplicationRuntime.signInOwner`
  (serialized): creates the owner through `claimOwner`'s transaction with an
  internal invitation and no email (`User.email = ''`, `emailKey` null), else
  issues a session for the sole active owner unless the request has it;
  anything but exactly one active owner fails closed (`owner_unavailable`, no
  session, redirect `/`). Never add a second owner-creation path.
- Owner setup re-checks loopback peer and loopback URL host per request and
  returns only fixed `{ code, message }` failures.
- Desktop signed-out recovery: [agents/desktop-signin.md](agents/desktop-signin.md).
- `verifyLocalMcpToken` (local only) and `resolveMcpPrincipal` (hosted only:
  issuer/subject → `oidc_identities` → exactly one active user with exactly
  one active direct membership, else `null`) are the runtime's MCP credential
  bindings; pass the runtime as `mountMcpAppRoute({ runtime })` (or
  `createHostedMcpResourceAuth({ runtime })`).
  Token claims never select a tenant.
- `resolveApplicationId()` / `runtimeConfigurationFingerprint()` must stay
  byte-compatible with process managers (golden vectors in tests).

## Operator state (root entry)

- One owner for the state shared by the web process and `smrt app`
  (`@happyvertical/smrt-cli/app` re-exports these): `resolveApplicationStateRoot`
  / `prepareApplicationStateRoot` (private app-bound mode-0700 root and
  marker), `withOperationLock` (`operation.lock`), `acquireWriterLease` /
  `readActiveWriterLease` (`writer.lease`), `reclaimStaleRecord`, and
  `createProviderReadinessProbe` (`SMRT_*_READINESS_MODULE`, resolved from the
  app root with Node's own ESM rules). File names, record formats, and
  messages are a cross-process contract; never change them unilaterally.
  `installation.json` joins `writer.lease` and `operation.lock` in the state
  root; the writer lease record is unchanged. So do `vault-sync.json` and,
  only during a restore, `data-root-swap.json`: while that journal exists
  `acquireWriterLease` refuses every writer except `dataRootSwapRecovery`
  (#4805; README "Vault primary writer and restore-latest").
- A vault restart is orchestrated by `restartVault` in
  `@happyvertical/smrt-cli/app` (README "Restarting when the recovery secret is
  lost"); it adds no state, only sequencing over `restartAccount`,
  `switchVaultAccount` and `vault-sync.json`. The parked account is read only
  through `openPreviousReadingKey`: it never seals, never writes, and refuses
  once `discardPreviousAccount` has run (#4838).
- Tests that hook `node:fs` interleavings must live in this package: from a
  consumer the package is an externalized dependency a mock cannot reach.

## Public runtime diagnostics

- `projectRuntimeDiagnostics()` is the only public diagnostic projection. It
  constructs the schema-version-1 allowlist and never serializes the private
  local or deployed diagnostics objects.
- The allowlist is limited to active profile/coarse health, schema and
  migration readiness, six fixed capability statuses, a sorted/capped public
  tool inventory plus digest, explicit operational topology differences,
  coarse worker heartbeat state, and eight stable code/timestamp errors.
- Callers supply an explicit clock and worker-heartbeat seam. A missing
  heartbeat is `unknown`; web-process liveness never proves worker liveness.
- Error ingestion maps unknown codes to `runtime_error`, truncates timestamps
  to the minute, and ignores messages, stacks, logs, records, and nested state.
- Authentication and diagnostics-read authorization belong before every call
  to the projector or its runtime probes.

## Invariants

- Never expose application-secret bytes or bootstrap token hashes in diagnostics.
- Never include migration or provider error text in a local or deployed startup
  error message; migration driver text is a likely credential carrier.
- Never include provider error text, URLs, tokens, or credentials in deployed
  errors, diagnostics, health, or readiness payloads.
- Keep local data, assets, database, and secrets outside the source tree.
- Do not reach into collection/database private fields. Add an upstream public
  API if composition cannot be expressed through exported surfaces.
- Keep profile selection out of domain models, generated APIs, MCP/WebMCP
  surfaces, effects, approvals, and authorization records.

## Validation

Build first: `sveltekit-production.test.ts` copies the published `dist` entry
and exercises the final adapter-node HTTP handler in a separate process.

```bash
pnpm --filter @happyvertical/smrt-app-runtime build
pnpm --filter @happyvertical/smrt-app-runtime test
pnpm --filter @happyvertical/smrt-app-runtime typecheck
```

## Owner tool approvals

`src/owner-approvals.ts` composes the existing smrt-approvals ledger with a host
recovery envelope and owner check. Contract and validation:
[agents/owner-approvals.md](agents/owner-approvals.md). Never expose its authority
methods to a model or create its application schema on request.
