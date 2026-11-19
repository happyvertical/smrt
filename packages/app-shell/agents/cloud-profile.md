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
| Sign-in | owner link (loopback + launch secret), `/setup` | `/auth/<provider>/login` and `/callback` (OIDC, `smrt-users`); first sign-in creates the tenant |
| User app data | `<data root>/user-app` (+ `-draft`) | `<SMRT_APP_SHELL_DATA_ROOT>/tenants/<tenant id>/<app id>` (+ `-draft`), SQLite engine |
| Data-root custody and lease | yes | never |
| Assistant engines | `api`, `chatgpt`, `claude-code`, `codex` | `api` on the owner's own key only |
| Operator key (config/env) | the assistant's `base` | never used: the resolved target must carry the tenant's own stored key, else "unavailable" (#5194 wires hosted inference) |
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

`AppImport` was already tenant-scoped (its `tenantId` field carries
`requiredFor: 'tenant-scope'`). Preferences, inference settings, the secret
store and AI usage rows belong to `smrt-preferences`/`smrt-inference`/
`smrt-secrets`/core, which scope them by tenant themselves.
`TENANT_SCOPED_TABLES` in `schema.ts` lists the seven above.

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

`cloud-isolation.test.ts` (two owners: definitions, history, approvals, drafts,
events, directories, sign-up, sessions), `cloud-surfaces.test.ts` (what must
not exist in cloud; local unchanged), `local-tenant-scope.test.ts` (desktop
upgrade and tenancy ON). Harness: `cloud-test-support.ts`. They run on SQLite
with the real tenancy interceptor; PostgreSQL, the deployed runtime's startup
(version probe), RLS and a live OIDC provider are NOT exercised.

## Remaining (not in this slice)

- Wiring a hosted identity provider's config and the signed-out landing page
  (a visitor with no session sees the shell's signed-out card, not a sign-in
  redirect); the welcome/connect-AI UI still shows desktop options.
- `required` mode and RLS policies for the shell tables (above); the
  `database-rls` request transaction is not used by the shell's long-lived stores.
- Hosted inference (#5194), workbook import in cloud, eviction/caps (#5192),
  a cross-process lock for the first sign-in of one account (the insert-only
  ids already prevent a second tenant).
