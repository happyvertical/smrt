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
'optional' }` (static decorator literal, both profiles; cloud runs them as
`required`, below):

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

## `required` mode and row-level security (#5191)

`shell-tenancy.ts`. Cloud only; the desktop never calls it and its decorators
stay `optional` (the desktop still has background paths with no tenant context,
import recovery among them).

- **Mode.** `shellProfile()` resolving to `cloud` calls `requireShellTenancy()`:
  core's `ObjectRegistry.registerOverride(name, { tenancy: { mode: 'required' } })`
  for every model in `SHELL_TENANT_MODELS` (process-wide, monotonic, no schema
  change). A read or write with no tenant context now throws instead of reading
  across tenants. `AppImport` is not in the list: it declares no tenancy and
  workbook import is refused in cloud, so its table stays empty there; the
  import service refuses to touch it in cloud (`requireLocalProfile`), so a
  write there fails loudly.
- **Policies.** At cloud start `prepareDatabase` runs `protectShellTables`:
  `smrt-users`' scoped policy generator over the shell classes (the tables'
  current schema), row-level security ENABLED and FORCED (so it holds for the
  table owner, the single-login profile), four policies per table: a row is
  visible when `tenant_id` equals `smrt.tenant_id` and `smrt.permissions` holds
  `SHELL_STORE_PERMISSION` (a marker for a connection the shell's stores opened,
  not an owner permission: owner-only is `assertOwner`). `Approval`'s SELECT
  also admits `approvals.read` (`shellPolicySlugs`): the generated
  `POST /api/approvals/[id]/decide` loads the row through the request's own RLS
  database, which carries the session's permissions and never the marker, before
  `assertOwner()` runs. `shell-routes.test.ts` pins that `Approval.decide` is the
  only generated route or tool of a shell model that loads a row by id (App's
  methods are static, every other model is closed), so each new one has to be
  thought through. The apply reads the catalog first and runs no DDL when the
  policies are exactly what it would write: each table's comment carries a stamp
  (`smrt-app-shell:rls:v<N>:<digest of the generated policy set>:<digest of
  the catalog>`; `N` is `SHELL_RLS_POLICY_VERSION`, bumped whenever the policy
  text changes, pinned by a digest test), and the catalog digest covers the RLS flags, EVERY policy on the
  table (name, command, roles, normalized USING / WITH CHECK) and the helper
  function bodies. A changed predicate, a removed slug, a dropped or extra
  policy, a rewritten helper, an older or unversioned stamp is not current, so
  the policies are re-applied (extra policies dropped) and re-stamped. A stamp
  with a NEWER version on any table is left alone with a warning
  (`shell-rls-policies-newer`): an old replica restarting mid-rollout never puts
  an older set back. The apply is one transaction under an advisory lock
  with a lock timeout, so replicas starting together never interleave
  DROP/CREATE POLICY and no reader sees a table between them. A
  missing table says to run `smrt db:migrate`; every failure's reason goes to
  stderr (`app-shell.database.rls-incomplete`) because the runtime reports a
  failed start generically. A table that cannot be
  protected refuses the start (reason on stderr). So does a login that is a
  superuser or has BYPASSRLS: many owners share the database and such a login
  silently removes every boundary (`app-shell.database.rls-bypass`). The one
  opt-out is `SMRT_UNSAFE_ALLOW_RLS_BYPASS=1` (tests, local development), which
  logs `rls-bypass-allowed` loudly. Default: refuse. Desktop and self-hosted
  single-owner are unchanged.
- **Long-lived stores.** They outlive the request that made them and run in the
  engine's queues, so they cannot use the request's RLS transaction. In cloud on
  PostgreSQL `getShellDb()` returns `tenantBoundDb(base)`: every operation (and
  every `transaction()`) runs in a transaction that first publishes the ambient
  tenant and the store marker as `smrt.*` settings. The tenant is read when the
  operation runs, never when the handle was made, and with none the call
  refuses. Inside such a transaction the handle reuses it (no second
  connection). `table()`, `acquireSession()` and `beginTransaction()` are refused
  on it. The hosted claim's transaction (`commitIn`, `reachable`, `withDraftRows`)
  is not one the handle opened, so those bind the ambient tenant to it
  (`bindAmbientShellScope`). There is no system path: no shell code reads across
  tenants. SQLite (cloud tests) has no policies; the application layer holds there.
- **Raw SQL** bypasses the tenancy interceptor and not the policies: the stores'
  raw `UPDATE`s still add `AND tenant_id = ?`, and the policy is the second line.

Test: `shell-rls.postgres.test.ts` (registered `test:postgres` lane: PGlite and a
real server). The login is a NOSUPERUSER NOBYPASSRLS role that owns the tables;
two owners go through the real stores, then the assertions go around the
application layer (raw SQL for the other owner's row id) and fail when the
policies are removed. It also runs the generated decide route for two owners
(the owner decides their own approval, the other gets a 404; the generated route is a build output, so the test performs its three steps and `shell-routes.test.ts` generates the real route from the real manifest and pins those steps, in order). The hosted claim's
binding runs only on the real-server lane (`claimAppDatabase` is PostgreSQL only).

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

**Settings page.** `routes/settings/inference/+page.server.ts` returns, in cloud,
`hideDeploymentRows(page)` (`inference-hosted-view.ts`): the operator's tier
targets, aliases, fusions and the app-wide transcript setting are removed (the
owner's interim decision: hide, not show read-only); what stays is the tenant's
own tier overrides and default tier, its allow-list (what THIS tenant may choose;
the panel enables its choices from it), key state and usage. The panel runs with
`scope="tenant"` and no app edit controls. Test: `cloud-inference.test.ts` ("the
operator's deployment-wide rows are not shown").

**Welcome and Connect AI.** The state route already answers `hosted: true` in
cloud; `ConnectAiState.hosted` (smrt-svelte) makes the shared component drop the
ChatGPT row, the CLI rows and the ChatGPT preview note, leaving the owner's own
API key. The welcome page (and Settings > Assistant) ask the profile (`+page.server.ts`)
and, hosted, say "your own API key" and offer no spreadsheet start (workbook
import is refused in cloud).

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
with the real tenancy interceptor; the deployed runtime's startup
(version probe) and a live OIDC provider are NOT exercised; the shell tables' RLS
is `shell-rls.postgres.test.ts` (above).

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
- Connection budget (#5464, reshaped by #5188): `WorkerLimits.connections`, set by
  `host.ts` on every host it opens when PostgreSQL holds the apps (or a lifecycle
  policy is set). Every PostgreSQL app worker's operations go through the
  process's ONE shared `BrokerPool` (engine.md "The shared pool"): its slots and
  one reserved cancel connection are taken from the budget once, when the first
  PostgreSQL worker starts, and a swap's new worker, a report worker or a
  rehearsal costs nothing more. A host also reserves `HOST_OVERHEAD` (live 2: the
  claim connection, which also carries its transactions and heartbeat (#5470), + one
  admin connection in flight; draft 1), returned on `close`, a successful
  `discardIfEmpty`, and a failed open (`withConnections`). `maxAppConnections`
  caps the total held by the process; unset, it is `maxOpenApps` x
  `appAllowance()` (live + draft overhead) plus the pool, and with no cap at all
  there is no budget. The pool's own size is `brokerPoolSize`, else what
  `maxAppConnections` leaves, else 10 (`SMRT_APP_SHELL_BROKER_POOL_SIZE`,
  `_PER_APP_TRANSACTIONS`, `_MAX_QUEUED_OPERATIONS`, `_POOL_ACQUIRE_TIMEOUT_MS`;
  `SMRT_APP_SHELL_OP_TIMEOUT_MS` is the per-operation deadline). A budget refusal
  is immediate (`ConnectionBudgetError`, a `CapacityError`: `refused`; a publish
  check rethrows it instead of storing a "does not fit your data" blocker); a
  saturated pool answers a call with `DatabaseBusyError` (`unavailable`, 503):
  retry. A worker with no shared pool (a budget without `pool()`: the self-hosted
  per-worker path) still reserves its own pool with `take`, and a swap that stops
  the old worker first keeps that share across the gap (`retireApp`). A refusal
  while a wake adopts its draft fails the wake for a retry; it is never stored as a
  draft problem. Transient admin connections beyond the one in `HOST_OVERHEAD` and
  the shell's own pool are not counted. SQLite and PGlite are not counted. A budget
  below the derived one refuses rather than evicts. `hostMetrics()` reports
  `connections`, `maxConnections` and `brokerPool` (`inUse`, `queued`, `max`).
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

Needs a PostgreSQL role that may `CREATE SCHEMA` (the admin, `DATABASE_URL`). The
portable export/import work on a PostgreSQL app (#5419).

**Two credentials (#5188).** With `SMRT_APP_SHELL_RUNTIME_DATABASE_URL` set to a
second login, `appDatabase` (`app-database.ts`) keeps `DATABASE_URL` as the admin
(shell tables, schema ownership, the claim, copies and swaps, and the owner lane's
boot and migration under `SET LOCAL ROLE <schema>_o`) and runs every user
operation as the runtime login after `SET LOCAL ROLE <schema>_r` (the broker). The
login must be NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB, own no table, hold
nothing on the app schemas or TEMP/CREATE on the database, and be a member of the
app roles only WITH INHERIT FALSE: `provision(schema)` creates and grants the roles
(`provisionAppRoles`; the owner role goes to the admin) and refuses to start the app
(`assertRuntimeLogin`) otherwise. Unset, the deployment is single-owner (one login,
no app roles), as before, and startup logs one structured warning
(`app-shell.database.no-role-isolation`: "no database-level role isolation: set
`SMRT_APP_SHELL_RUNTIME_DATABASE_URL`") because nothing in the database then
separates one app from another. User tables carry forced row-level-security policies (#5189, engine.md); guests are still refused.

An app still in an `app.db` is refused until `migrateOwnAppToPostgres()` (host.ts;
engine.md "SQLite to PostgreSQL in place") has moved it. v1 decisions:

- **Trigger**: an explicit operator command, never a boot job and no owner-facing
  route: `smrt-app-shell migrate-to-postgres --tenant <id> --user <owner id> [--json]`
  (`src/lib/server/operator.ts`, `build/operator.js`), run on the host with the
  server's own environment. It starts the shell the way `./embed` does (listening
  on nothing, no background job runner), checks that the user is the tenant's
  owner (`requireOwner`: an ACTIVE membership with the system `owner` role, looked
  up in shell.db; a non-owner, another tenant's owner and unknown ids are one
  refusal that writes nothing), then runs `migrateOwnAppToPostgres` as that
  verified owner (tenant from the verified principal, never an argument). No
  principal is built from the operator's say-so. Exit 0 migrated or
  already-migrated, 1 refused or failed (a shell that fails to start exits 1 with its
  startup error, before the arguments are read), 2 usage once the shell started.
  A database that cannot be reached is reported as such, not as "not the owner".
  Hosted profile only.
- **Refuses** (nothing written) while there is an open draft, waiting changes, or
  an unsettled approval (pending, accepted, executing, or approved with no result), each named in the message.
- **The kept `app.db`** stays until an operator removes it; it is a snapshot as of
  migration time, not a live fallback (the PostgreSQL app diverges at its first
  write).
- **Downgrade** is unsupported once the app has taken writes on PostgreSQL. Before
  any write, by hand: (1) stop the host; (2) check nothing was written (the
  schema's `_app_meta` `version` equals the completion row's `version`, and
  `_smrt_changes`/the tables hold no row newer than `migratedAt`); (3) `DROP SCHEMA
  <app schema> CASCADE` (this removes the completion row) and delete
  `postgres-migration.json`; (4) serve the app from SQLite again by starting the
  host WITHOUT `appDatabase` (the profile setting that returns the app to its
  `app.db`). With `appDatabase` still set, the host refuses the app after the row
  is gone (it is offline) until `app.db` is served that way or it is migrated again.
- The completion row is an engine convention in the app's own schema, not
  tamper-evident against the same database role: a role that can write the schema
  can forge or remove it.

### Receiving a desktop app (#5193)

`POST /api/shell/app/receive` (`receiveOwnUserApp`, `src/lib/server/receive-user-app.ts`)
installs a desktop bundle (`exportUserApp`, `smrt app export`) as the signed-in
owner's app in the shared PostgreSQL, in the schema the host names for that
tenant's app. Owner session and same origin only (an operator or a link token
is not a caller here yet). v1:

- **Tenant** is the verified owner's, never a field of the request or bundle.
- **Target** is an app that never held content: no history, or only the engine's
  own empty version 0 (`isEmptyStart`) with no row anywhere. Any other app, a
  SQLite file or an open draft is refused with nothing written (409); the
  engine treats its own untouched first start (version 0, no model, no row) as
  empty (`importPostgres`).
- **Resumable and idempotent**: the version history and the pointer go in first
  (one shell transaction; versions already stored are skipped), then the rows in
  one transaction with a completion fact (`user-app-received`) and a verification
  before the commit (engine). A crash between them converges on rerun; an app
  opened in the gap boots at the bundle's version on empty tables (the engine's
  own migration) and the rerun still fills it, but rows written there first make
  the rerun refuse (nothing is lost: the desktop file is kept). The same bundle
  again is `already-received`. A failure inside the import is settled by what it left: the completion
  fact is written with the rows, so with it the rows are in and the history
  stays (a rerun converges); without it, and with the schema holding a row (not
  this call's), only the history goes back (`ShellVersionStore.unstage`); without
  it and with an empty schema, the half-built schema goes too (engine `discardUnfilledImport`: under the
  app's claim, so refused while another host has the app open, and only with no
  completion fact and no row; the schema is provisioned again on the next use) and the history goes back, so
  the tenant is left as found. A state that cannot be read is left alone. Before anything is staged the app's claim is probed (`assertAppUnclaimed`): a
  process that holds the tenant's app open (the close below reaches only this
  one's) refuses the receive with nothing written; a claim taken in the gap
  after the probe keeps the history (that host may already run on it) and asks
  to retry, and a rerun once it is closed converges. The tenant's open app is closed first (refused
  while a call is inside it); do not use the app during a receive.
- **Refuses** (named, nothing written) while the tenant has an open draft,
  waiting changes or an unsettled approval, as the SQLite migration does
  (`assertNothingPending`).
- **Verification pass** (`verified: true` in the answer): per-table counts and
  digests, the recorded version and definition, and the version history
  (number, parent, definition, migration) against the bundle, after the commit.
- Approvals and drafts are not carried (engine.md "Approvals and drafts in a move").
- v1 defaults, revisit: the SQLite file on the desktop stays; the hosted app
  cannot be moved back once it has taken writes; waiting changes and drafts refuse a move.
- The CLI side (`runSharedCloudMigration`, `SharedCloudTransport.receiveUserApp`)
  is wired; an HTTP transport that authenticates a cloud link to this route is not.

## Remaining (not in this slice)

- Supplying a hosted identity provider's config is the operator's
  (`packages.users.auth.oidc` in smrt.config; the shell only reads it): no live
  provider was exercised.
- Hosted inference: gate, entitlement and provisioning landed (#5194, `hosted-inference.md`); the caller-aware parts wait for #5188/#5189/#5375. Workbook import in cloud, a statement timeout per
  operation (the database layer, not the registry), a cross-process lock for the first sign-in of one account (the insert-only
  ids already prevent a second tenant).

## Key endpoints (cloud)

A key the owner saves is later sent by the server to its endpoint, so in the cloud
profile only a provider's own public https endpoint may hold one. `saveKey` refuses a
custom `baseUrl` or a non-https origin, and the assistant refuses a resolved target
whose endpoint is not the provider's own (`assertPublicProviderEndpoint`). Without that,
a tenant could make the server call an internal address.

## Database text in tool errors (interim, #5464; full boundary #5498)

`src/lib/server/owner-text.ts` is the one place that decides which error text
may leave. Only text that starts with `Database query failed:` (core's
`DatabaseError.queryFailed`: the SQL and the driver's cause) is replaced, with
a generic sentence plus a short reason ("that change could not be saved, try
again" / "the database is unavailable, try again"); the raw text goes to the
server log. An optional `Error:` prefix is allowed; mid-text occurrences are
left alone.

Everything else passes through unchanged: the runtime's own messages,
validation, a method's own text, SQLite and PostgreSQL constraint text.
Address-shaped leaks (host names, IPs) in other error text are NOT covered:
they are left to the full boundary (#5498). Exits covered: `dispatchTool` (app
and shell tool results, and so the assistant and `/mcp` calls), the assistant's
thrown-error chip, an approval's stored failure text (every content item and
`structuredContent`, so reading the approval back shows the same generic text),
and the `/mcp` JSON-RPC errors (`tools/list`, scope and authorization, calls).
Not covered: any other route, SSE, logs of other layers, the worker protocol
and database handles.
