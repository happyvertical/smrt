# The shell on the `cloud` runtime profile (#5191, epic #5183)

The same SvelteKit app runs under two app-runtime profiles, chosen by
smrt-config's runtime resolution (`runtime` block of smrt.config, else
`local`); `smrt.ts` hands the shell its profile through
`ShellContext.profile` (`local` or `cloud`; `self-hosted` and anything else
fail closed). Tests that do not name a profile are `local`: the desktop's
behaviour and tests are the baseline and must not change.

## Local versus cloud

| | `local` (desktop) | `cloud` |
|---|---|---|
| Owners | one | many; one tenant each, owner-only |
| Shell database | SQLite from the local runtime; `prepareShellSchema` runs | PostgreSQL (`DATABASE_URL`); schema by `smrt db:migrate`, never at runtime |
| Sign-in | owner link (loopback + launch secret), `/setup` | `/auth/<provider>/login` and `/callback` (OIDC, `smrt-users`); first sign-in creates the tenant; a signed-out visitor sees a Sign in link to the configured provider (`signInHrefFor`) |
| Start-up extras | owner hand-off files, workbook-import job runner | none (`hooks.server.ts` returns before them) |
| User app data | `<data root>/user-app` (+ `-draft`), SQLite file | PostgreSQL, one schema per app (`appSchemaName`), its draft a side schema; the directory `<SMRT_APP_SHELL_DATA_ROOT>/tenants/<tenant id>/<app id>` (+ `-draft`) keeps only the engine's marker, journal and snapshots. SQLite files when `DATABASE_URL` is unset (tests) |
| Data-root custody and lease | yes | never |
| Assistant engines | `api`, `chatgpt`, `claude-code`, `codex` | `api` on the owner's own key only |
| Operator key (config/env) | the assistant's `base` | never used: the resolved target must carry the tenant's own stored key, else "unavailable" unless a stored hosted binding passes the gate (`hosted-inference.md`) |
| `/settings/inference` authority | the one owner is the deployment (app scope writable) | tenant scope only; app-scope writes and server-side probes refused |
| Workbook import | yes | refused (404): its job runner is the local runtime's |

Desktop-only surfaces answer 404 in cloud before touching the runtime:
`/api/_runtime/owner-link`, `/setup`, onboarding `connect`/`engine`/`chatgpt`.
`requireLocalProfile(what)` / `requireCloudProfile(what)` in `host.ts` are the
guards; add one to any new surface that runs a program or signs in on the
server's machine.

## Tenant scoping

Every shell model that holds one owner's data is `tenantScoped: { mode:
'optional' }` (static decorator literal, both profiles):

| Model | Table | Holds |
|---|---|---|
| `App` | `apps` | the tenant's app row: current definition and pointer; THE tenant-to-app mapping |
| `AppVersion` | `app_versions` | definition history |
| `AppDraft` | `app_drafts` | the open/ended drafts |
| `AppDraftVersion` | `app_draft_versions` | a draft's versions |
| `Approval` | `approvals` | the approval ledger |
| `AssistantThread` | `assistant_threads` | assistant conversations |
| `AssistantMessage` | `assistant_messages` | their messages |
| `ChangeBatch` | `change_batches` | the owner's changes waiting (#5178); also carries an explicit `tenantId` the batch lookup filters on |
| `ChangeCard` | `change_cards` | the cards of a batch |

`AppImport` was already tenant-scoped (its `tenantId` field carries
`requiredFor: 'tenant-scope'`). Preferences, inference settings, the secret
store and AI usage rows belong to `smrt-preferences`/`smrt-inference`/
`smrt-secrets`/core, which scope them by tenant themselves.
`TENANT_SCOPED_TABLES` in `schema.ts` lists the tables above except `change_batches`
(its `tenantId` is an explicit field the batch lookup filters on, there was
nothing to adopt, and the change feed does not offer it).

Why `optional`, not `required`: `required` makes every no-context read throw,
and the desktop still has background paths with no tenant context (import
recovery). Cloud fail-closed is enforced by the shell instead:

- `getShellDb()` refuses (401) with no tenant context in cloud; the sign-in
  flow uses `getAccountsDb()`, only for the global user/tenant/membership tables.
- Stores are pinned: `ShellVersionStore` / `DraftVersionStore` take the tenant,
  run every operation inside it (`inTenant`) and refuse a different ambient
  tenant.
- `host.ts` keys the live host, version store and draft slot by tenant
  (`holders`), from the verified session's tenant context only. App directories
  come from validated UUIDs (`tenantAppDirs`), never from input.
- The event bus carries a tenant on every event; cloud subscribers get only
  their tenant's (an untenanted event reaches nobody).
- `approval-store.ts` takes the tenant from the request in cloud and its raw
  `UPDATE` adds `AND tenant_id = ?` (raw SQL bypasses the interceptor).
- Process-wide state is per tenant or keyed by globally unique ids, never one
  shared slot: the changes queue (`changes.ts`) and the draft lifecycle queue
  (`drafts.ts`) are `createTenantQueue()`s (one job at a time per tenant, so a
  slow check for one tenant never stalls another); the check scheduler and its
  `owners` / `importIndex` maps are keyed by batch id (a UUID of exactly one
  tenant) and `runChecksJob` re-enters the owner's tenant (`runAs`) whatever
  timer fired it; the assistant's comment-turn slot is keyed by the owner's user id (unique across tenants; an owner has one tenant).
  `apply-now.ts` and `template-records.ts` are pure (no state); the
  `setAfterChecks` / `setWorkingCopyReplaced` hooks are data-only, set once.
- `owner.ts`: the owner check runs inside the principal's own tenant; a user
  who owns tenant A is not the owner of B.

Moving to `required` (and PostgreSQL RLS policies for these tables) needs the
desktop's no-context paths audited first, and core's `PostgresPermissionPolicies`
pass over the shell's registry. NOT done here; the shell tables are not
RLS-enforced.

Desktop (tenancy interceptor ON in the local runtime): optional-mode rows
written with no context get a NULL tenant and are then invisible to reads made
inside a context, so the desktop never mixes the two. Its stores pin to the
installation's one tenant (`Holder.pin` in `host.ts`), and the workbook-import
job hooks run inside the import owner's context (`import-workflow.ts`). A new
desktop background path that writes shell rows must do the same.
`import-job-engines.test.ts` (real local runtime) and
`local-tenant-scope.test.ts` guard it.

Desktop upgrade: a database made before the models were scoped has no
`tenant_id`. `prepareShellSchema` (local only) adds the column and gives rows
without one the installation's single tenant (`adoptTenantScope`; with zero or
several tenants it leaves rows alone). Covered by `local-tenant-scope.test.ts`.

Secrets and the assistant: `SMRT_SECRET_MASTER_KEY` must be set in cloud (the
runtime generates none outside local), or an owner's key cannot be saved. The
`/mcp` route accepts the signed session only in cloud (local MCP tokens verify
`null` outside the local profile).

## Inference boundary

An owner owns one tenant, not the deployment. Two rules, both enforced in the
shell (no core change):

- **Assistant credentials.** `resolveAssistantOptions` in cloud accepts only a
  resolution that is `via: 'resolver'`, `source: 'byo'`, carries its own literal
  `apiKey` and whose client options hold exactly that key
  (`assertOwnerSuppliedKey`, `assistant/config.ts`). That is the stored-key layer
  (smrt-secrets, the user's then the tenant's) and nothing else. An app
  `inference.tiers` binding, a tenant override row naming `apiKeyEnv`, a
  `local`/`hosted` source, or core's provider-environment key fill
  (`bindInferenceTarget`) all fail with `assistant_not_configured`, so an
  account with no key never runs on the operator's.
- **Settings authority.** `shellInference()` rebuilds the settings service in
  cloud with an authorizer that admits only `scopeType: 'tenant'` and the
  session's own tenant id (`tenantOnlyInCloud`, `inference.ts`). Every action of
  the shared controller is accounted for: `saveTier`/`saveDefaultTier` at `app`,
  `saveAlias`, `saveFusion`, `saveTranscripts` are refused (403, app-scope rows
  are every tenant's); `saveKey`, `saveDefaults` and tenant-scope tier writes act
  on the ambient tenant only; `testConnection`, `testCandidate` and
  `discoverModels` are refused (they would make the server connect to an
  owner-typed address, read operator key variables, or probe the server's
  loopback). `load` shows the deployment's app rows read-only (operator config,
  no keys) plus the caller's own tenant row. Desktop keeps `can: () => true`.
- **Change feed.** `authorizeChangeFeedForOwner` offers a cloud owner only
  `TENANT_SCOPED_TABLES`, never accounts, tenants, secrets or the global override
  table.

Tests: `routes/settings/inference/cloud-inference.test.ts`,
`change-feed` cases in `cloud-change-feed.test.ts`, and the local-profile
case in `inference-settings.test.ts`.

## Accounts

`accounts.ts`: `ownerTenantFor(db, user)` is the whole sign-up. Idempotent,
one tenant per account, tenant and membership ids derived from the user id and
inserted insert-only (concurrent first sign-ins collide into one tenant); a
tenant already holding the account's slug is refused, never overwritten
(`Tenant` upserts on slug). `cloud-auth.ts` passes it to `smrt-users`' OIDC
handlers as the `tenantId` resolver, so the session is minted fresh (never
reusing a presented cookie) for the account's own tenant; the tenant never
comes from the request. The App row is created on the tenant's first request.

## Tests

`cloud-isolation.test.ts` (two owners: definitions, history, approvals, changes waiting,
events, directories, sign-up, sessions), `cloud-surfaces.test.ts` (what must
not exist in cloud; local unchanged), `local-tenant-scope.test.ts` (desktop
upgrade and tenancy ON). Harness: `cloud-test-support.ts`. They run on SQLite
with the real tenancy interceptor; PostgreSQL, the deployed runtime's startup
(version probe), RLS and a live OIDC provider are NOT exercised.

## Many apps in one process (#5192)

`host-lifecycle.ts` (policy, counters, wake gate) and the registry in `host.ts`.
Engaged ONLY when the profile is `cloud` AND `ShellContext.lifecycle` is set (the
runtime reads `SMRT_APP_SHELL_IDLE_MS`, `_MAX_OPEN_APPS`, `_MEMORY_CEILING_MB`,
`_APP_MEMORY_MB`, `_MAX_CONCURRENT_WAKES`, `_MAX_APP_CONNECTIONS`; none set = no policy). Otherwise the
desktop and an unconfigured hosted process keep the raw host, never a proxy,
never a timer, never an eviction (`host-lifecycle.test.ts`, "desktop is unchanged").

- Hosts handed out by `getHost()` and held draft hosts are wrapped in a proxy
  that counts every call as a lease until it settles; `getHost()` also leases for
  `handoutMs` (default 5000) so the caller's first call is never met by a closed host. An app with a lease, or
  whose draft a workflow `hold`s, is never closed; reading `def`, `openHost()`
  and the event bus (a live tab) touch nothing, so a tab does not keep a worker.
- Eviction closes live worker, draft worker and the holder; the next request is
  a first open from disk (`openLive`), sharing nothing with the old holder.
  A request for an app being closed waits for it, then reopens: never two
  workers on one directory.
- Caps: `maxOpenApps` and `memoryCeilingMb / appMemoryMb` (the smaller wins,
  at least 1). A wake over the cap closes the least recently used idle app
  (no call inside, hand-out lease over, idle at least `minIdleMs`, default 0); if every open app is busy it waits up to `capacityWaitMs`, then refuses
  (`refused`, "no room"), never cutting a call. A worker keeps the memory it grew
  to, so the ceiling is a count, not a reading of the process.
- `maxConcurrentWakes` (default 2) queues a burst of wakes.
- Connection budget (#5464): `WorkerLimits.connections`, set by `host.ts` on
  every host it opens. EVERY worker on a server PostgreSQL reserves its pool in
  `AppWorker`'s constructor and returns it when the thread exits, so a swap's new
  worker, a report worker and a publish rehearsal are counted while they live;
  the pool is created at exactly the size reserved (`connection.max`, else
  `POOL_SIZE` = 2, set explicitly, never the adapter default). A host also reserves
  `HOST_OVERHEAD` (live 2: the claim connection, one connection that also carries its
  transactions and heartbeat (#5470), + one admin connection in flight; draft
  1), returned on `close`, a successful `discardIfEmpty`, and a failed open
  (`withConnections`). `maxAppConnections` caps the total held by the process;
  unset, it is `maxOpenApps` x `appAllowance(pool)` (live + draft + one transient
  worker pool, plus both overheads; `pool` follows the largest pool a config asks
  for, so a bigger `connection.max` scales it), and with no cap at all there is no budget.
  A refusal is immediate (`ConnectionBudgetError`, a `CapacityError`: `refused`; a publish check rethrows it instead of storing a "does not fit your data" blocker), never queued, so a
  swap or report that finds no room fails and can be retried. A swap that
  stops the old worker first (migration, restore, publish) keeps its pool's
  share across the gap (`retireApp`), so nothing can take it and the
  replacement or the rollback is never refused. The handed-over reservation stays the
  host's until the replacement is ready (a thread that dies first does not
  release it). A refusal while a wake adopts its draft fails the wake for a retry; it
  is never stored as a draft problem. Transient admin
  connections beyond the one in `HOST_OVERHEAD` and the shell's own pool are not
  counted. SQLite and PGlite are not counted. A budget below the derived one
  refuses rather than evicts. `hostMetrics()` reports `connections` and
  `maxConnections`.
- `drainShell(timeoutMs)`: refuse new apps, wait for calls, close all; for
  recycling a process. `hostMetrics()`: open, queued wakes, wakes, failed wakes,
  evictions by cause, wake times, cap, RSS.
- A workflow that keeps one app busy across more than `idleMs` between calls
  (without holding a draft) can be put to sleep between them; its next call wakes it.

## User apps on PostgreSQL (#5191)

`ShellContext.appDatabase` (set by `smrt.ts` from `DATABASE_URL` in the cloud
profile) gives each tenant's app a schema of its own: `appSchemaName(tenant,
app)` is `app_` + 32 hex of sha256 over the two validated ids (never input, never
shaped like an engine side schema). `host.ts` creates it before the engine opens
it (`provision`: `CREATE SCHEMA IF NOT EXISTS`; the engine never does) and passes
`database` to the live host and to the draft host (a draft reopens with the live
config; its own schema comes from its marker). A leftover copy is removed with
`discardOrphanDraft`, which also drops a PostgreSQL draft's schema
(`discardStaleDraft`). Data-root custody and the lease are the local runtime's and
never run here; `smrt.ts` never touches `localRuntime()` in the cloud profile.
The two-owner proof on a PGlite stand-in is `cloud-postgres.test.ts`; a real
server is CI's `test:postgres` lane and NOT exercised by the shell's tests.

The tenant-to-app mapping is the `App` row (slug `app`) and the app id keys the
directory and the schema, so a second app per tenant needs a second row, a holder
key of (tenant, app) and a route to name it, none of which is ruled out; today
`host.ts` holds one app per tenant.

The shell's own tables and every app schema are the same database and role
(#5418), so a live host's claim connection (`claimApp`, #5470) commits a publish
or snapshot restore with the shell's `App`/`AppVersion` rows in one transaction
(engine.md "The store in the swap"). The host refuses to open when its claim
cannot see the shell's own `App` row, so a deployment that put the shell and
the apps on different databases is refused, not silently unfenced.

Needs a PostgreSQL role that may `CREATE SCHEMA` (the hosted role and policies
are #5188/#5189). The portable export/import still refuse a PostgreSQL app (engine
`requireSqlite`).

## Remaining (not in this slice)

- Supplying a hosted identity provider's config is the operator's
  (`packages.users.auth.oidc` in smrt.config; the shell only reads it): no live
  provider was exercised. The welcome/connect-AI UI still shows desktop options.
- `required` mode and RLS policies for the shell tables (above); the
  `database-rls` request transaction is not used by the shell's long-lived stores.
- Hosted inference: gate, entitlement and provisioning landed (#5194, `hosted-inference.md`); the caller-aware parts wait for #5188/#5189/#5375. Workbook import in cloud, a statement timeout per
  operation (the database layer, not the registry), a cross-process lock for the first sign-in of one account (the insert-only
  ids already prevent a second tenant).

## Key endpoints (cloud)

A key the owner saves is later sent by the server to its endpoint, so in the cloud
profile only a provider's own public https endpoint may hold one. `saveKey` refuses a
custom `baseUrl` or a non-https origin, and the assistant refuses a resolved target
whose endpoint is not the provider's own (`assertPublicProviderEndpoint`). Without that,
a tenant could make the server call an internal address.
