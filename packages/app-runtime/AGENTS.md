# @happyvertical/smrt-app-runtime

Application infrastructure composition for the validated runtime profiles in
`@happyvertical/smrt-config`.

## Local profile

- `initializeLocalApplicationRuntime()` owns user data paths, SQLite tuning,
  local application-secret creation, and the single-use owner bootstrap flow.
- SQLite is acquired through `@happyvertical/sql`'s explicit
  `{ driver: 'node:sqlite', custody: 'trusted-parent' }` boundary after the
  runtime establishes its user-owned mode-0700 data root.
- Application migrations are explicit through `prepareDatabase`; runtime never
  creates application model tables implicitly.
- Owner bootstrap creates normal `Person`, `User`, `Tenant`, owner `Role` /
  `Membership`, and `Session` records in one transaction.
- Bootstrap is loopback-only. Only an HMAC of the short-lived token is stored.
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
  separate processes; the web process does not start them automatically.
- `health()` is process liveness. `readiness()` probes database/auth/assets/
  secrets; it does not claim that an external worker fleet is running.
- Cloud must keep required tenant context and must never introduce a root or
  unscoped tenant fallback. RLS remains an explicit deployment/migration choice.

## Invariants

- Never expose application-secret bytes or bootstrap token hashes in diagnostics.
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
