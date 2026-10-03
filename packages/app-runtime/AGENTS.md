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
- Application migrations are explicit through `prepareDatabase`; runtime never
  creates application model tables implicitly. A rejected `prepareDatabase` is
  normalized into `LocalRuntimeError` with the stable `migration_failed` code
  and the fixed recovery message `MIGRATION_FAILED_MESSAGE` ("run pnpm
  app:setup and inspect the private migration logs"). The caller's error text
  is never surfaced — it is retained only as a non-enumerable `cause` for
  private logs — and the same application root stays retryable.
- Standalone migration commands must call `prepareLocalDatabaseStorage()`
  before opening SQLite so custody is established without creating schema or
  bootstrap records.
- Read-only/copy/import operator commands must call
  `validateLocalDatabaseStorage()` before opening SQLite; it verifies the
  app-bound marker, source separation, real path chain, ownership, and mode
  without creating or repairing storage.
- Owner bootstrap creates normal `Person`, `User`, `Tenant`, owner `Role` /
  `Membership`, and `Session` records in one transaction.
- Bootstrap is loopback-only. Only an HMAC of the short-lived token is stored.
  A token that cannot claim fails a read-only preflight before role/catalog
  seeding (#3323); the claim transaction's conditional UPDATE stays the
  authority for single use, expiry, and concurrency.
- Local MCP tokens (`mcpTokens`, `openLocalMcpTokenStore`, `smrt app token`):
  owner-bound, scoped, expiring (default 30 d, max 365 d), revocable. Only a
  domain-separated HMAC (application secret) is stored, in the runtime-owned
  `_smrt_local_mcp_tokens` system table (created like the bootstrap table;
  never application schema). Issue refuses scopes the owner lacks; verify
  returns token scopes ∩ live permissions and `null` for anything else.
  Never log or return the token outside `issue()`. The operator store opens an
  uncached connection and takes no writer lease (revocation is per request).
- Background jobs and application-defined paid capabilities are default-off.
- The embedded runner reuses `TaskRunner`; it is not a second job contract.

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
  separate processes; the web process does not start them automatically. The
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
  The root entry must never import kit or Svelte.
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
  config, never these.
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
- Owner setup re-checks loopback peer and loopback URL host per request and
  returns only fixed `{ code, message }` failures.
- `verifyLocalMcpToken` (local only) and `resolveMcpPrincipal` (hosted only:
  issuer/subject → `oidc_identities` → exactly one active user with exactly
  one active direct membership, else `null`) are the runtime's MCP credential
  bindings; pass the runtime as `createHostedMcpResourceAuth({ runtime })`.
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

```bash
pnpm --filter @happyvertical/smrt-app-runtime test
pnpm --filter @happyvertical/smrt-app-runtime typecheck
pnpm --filter @happyvertical/smrt-app-runtime build
```
