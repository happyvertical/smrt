# @happyvertical/smrt-app-runtime

Application infrastructure composition for the validated runtime profiles in
`@happyvertical/smrt-config`.

## Local profile

- `initializeLocalApplicationRuntime()` owns user data paths, SQLite tuning,
  local application-secret creation, and the single-use owner bootstrap flow.
- Application migrations are explicit through `prepareDatabase`; runtime never
  creates application model tables implicitly.
- Owner bootstrap creates normal `Person`, `User`, `Tenant`, owner `Role` /
  `Membership`, and `Session` records in one transaction.
- Bootstrap is loopback-only. Only an HMAC of the short-lived token is stored.
- Background jobs and application-defined paid capabilities are default-off.
- The embedded runner reuses `TaskRunner`; it is not a second job contract.

## Invariants

- Never expose application-secret bytes or bootstrap token hashes in diagnostics.
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
