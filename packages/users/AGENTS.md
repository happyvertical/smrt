# @happyvertical/smrt-users

Multi-tenant identity, RBAC, hierarchical tenants, sessions, and SvelteKit auth.

## Modules

Read only the module relevant to the change; protocol and provisioning details
are not prerequisites for unrelated user-package work.

| Module | Scope | Module doc |
|---|---|---|
| `src/services/PermissionResolver.ts` | permission precedence, inherited memberships, guards, RLS, role seeding | [agents/permissions.md](agents/permissions.md) |
| `src/services/OidcLoginService.ts`, collections and OIDC handlers | identity reconciliation, transaction boundaries, migration readiness | [agents/oidc-provisioning.md](agents/oidc-provisioning.md) |
| `src/services/MobileAuthService.ts` | mobile handshake, bearer sessions, bootstrap extension boundary | [agents/mobile-auth.md](agents/mobile-auth.md) |
| `src/services/TerminalAuthService.ts`, `src/services/LoginAttemptLimiter.ts`, `src/collections/LoginAttemptCollection.ts` | terminal approval concurrency, shared login budget and lockout (#3273), retry-safe database fixtures | [agents/terminal-auth-testing.md](agents/terminal-auth-testing.md) |
| `src/services/DeviceCredentialService.ts` | per-person PIN layered on a device session (#3276), verifier seam for other credential kinds | this file, "Security boundaries" |
| `src/retention.ts` | expired session/token/CLI-auth reaping and retention sweep wiring | [agents/retention.md](agents/retention.md) |

## Models and authority

- Users are global; tenant access comes through Membership (unique user/tenant).
  User email is normalized and globally unique through readonly nullable
  `emailKey`. `profileId` is a unique cross-package reference: at most one User
  owns each non-null Profile.
- Tenant uses STI and a materialized hierarchy, maximum depth 10.
  `hierarchyPath`/`hierarchyLevel` are derived from `parentTenantId` by
  `Tenant.save()` on every save (any caller-supplied value is recomputed) and
  descendants are re-materialized when they change; never hand-maintain them.
  Legacy rows are backfilled with `smrt db:materialize-tenant-hierarchy`
  (`materializeTenantHierarchy()`). Tests that need a corrupt path must write it
  with raw SQL (#3036).
- Role with `tenantId = null` is available to all tenants; `isSystem` prevents
  deletion. `inheritsToDescendants` is opt-in. Seed owner/admin/member/viewer
  through `RoleCollection.seedSystemRoles()` at application initialization.
- Group roles apply only in their own tenant. Use `getGroupIdsForTenant()`,
  never cross-tenant `getGroupIds()`, for authorization.
- Upward visibility is opt-in and read-only: `permissions.ancestorRead`
  ({ roles, collections, maxDepth? }) lets a DESCENDANT membership contribute
  declared `<collection>.read` at an ancestor, only when no membership resolved
  there, intersected with BOTH the role's own catalog grants and the
  principal's effective permissions in that descendant, and only for SYSTEM
  roles (a tenant-scoped role sharing a declared slug is ignored). Off by default, never
  write, never lateral, and never row visibility — sibling rows stay scoped by
  tenancy/RLS. Read the permissions module before changing it.
- Membership DENY always wins. Direct inactive membership blocks inherited
  authority; a direct active membership pins resolution instead of unioning it
  with ancestors. Read the permissions module before changing these rules.
- AccessRequest has no generated API/MCP/CLI operations; access it through
  `AccessRequestService`. Its JSON field is `requestContext`, not reserved
  slug-scoping `context`.

## Security boundaries

- Generated REST/MCP operations on identity/RBAC models are list/get only.
  Route authentication does not authorize authority mutations, and these models
  are not tenant-scoped. Use permission-gated services or explicitly checked
  consumer handlers. CLI remains a local-operator surface. Preserve the
  registry assertions in `security-audit-1400.test.ts`.
- Resource guards take the resource tenant, not the session tenant. Omit a
  session membership when targeting a different tenant; mismatches fail closed.
  `loadSessionContext().tenantAuthorization` must be checked by required-tenant
  consumers: null membership can represent inherited authority.
- Sessions use secure UUIDs; TTL is seconds (default seven days). Access marks
  expired sessions EXPIRED. Magic-link tokens are single use.
- `Session.authMethod` is server-set at mint time and never read from the
  client; every mint site in this package sets it. A session with
  `parentSessionId` is valid only while its parent validates
  (`loadSessionContext` enforces this; there is no FK cascade by design), may
  not switch to a tenant other than the parent's, and is revoked with its
  parent by `destroySession`.
- Credential sign-ins reserve through `LoginAttemptLimiter` BEFORE credential
  work and key the subject on the submitted identifier, never a resolved user,
  so unknown and wrong take the same path. Reservations are fail-closed: keep
  them on failure, release on success or abort, never skip the reserve.
  Limiter writes are raw SQL and bypass the change feed; the audit sink is the
  observability seam, and it must never throw into the sign-in path.
- `DeviceCredentialService` accepts a person credential only from a
  first-class session whose `authMethod` is a device-enrollment method
  (`terminal` by default) and that the host's `assertEnrolledDevice` confirms.
  A layered or PIN session can never administer PINs regardless of
  permissions. PIN hashes carry a per-row salt and the configured pepper;
  treat an unset pepper as a production misconfiguration.
- A person session carries the PERSON's authority (resolved from their own
  membership on every load), never the device account's. `Session.data` keys
  in `SESSION_DATA_KEYS` are server-set controls enforced by the model:
  `permissionCeiling` only ever intersects (malformed fails closed to none)
  and suppresses `superAdminBypass`/`systemContext`; `absoluteExpiresAt`
  bounds `extend()` and `isValid()`; `idleSeconds` overrides the resolving
  service's TTL policy. Never write them from client input. The ceiling is a
  sign-in snapshot; `singleOccupant` revokes other children only AFTER a
  successful mint. A `mustReset` sign-in mints with an empty ceiling and
  `setPin` ends that session; do not grant it authority another way.
- A layered session whose tenant differs from its parent's never loads (null
  is allowed: narrower). Limiter rows carry `retain_until`; retention must
  not fall back to a process-wide horizon.
- `Session.parentSessionId` is the parent's bearer: sensitive, never a
  `list()` filter (raw-SQL id reads, which also keep revocation sweeps free of
  caller list bounds), never serialized to clients. `users.pin.manage` reaches
  only people whose every active membership is in the actor's tenant (the PIN
  is global per person). A sign-in re-checks the verified
  credential generation AFTER the mint (`stillValid`); keep that ordering.
  Operation guards deny outside a session's ceiling; `loadPersonSession`
  re-checks device enrollment.
- Tenant switching verifies active membership before writing and rotates the
  session ID for non-null targets, revoking the old session. Persist the returned
  `SwitchTenantResult.sessionId`; `switchSessionTenant()` updates the cookie and
  preserves its security settings. Failed switches mutate nothing; null clears
  do not rotate, and layered sessions never rotate (a replacement would escape
  the revocation sweeps they depend on). Layers do not nest. `SessionCollection.setSessionTenant()` is unguarded and must
  never receive an untrusted tenant ID.
- OIDC provisioning is atomic and fail-closed. Preserve exact issuer/subject
  identifiers, claim-source email verification, unique global Person ownership,
  and transaction-bound reconciliation. Read the OIDC module and canonical
  scenario matrix before changing any provisioning path.

## Entry points and validation

`src/sveltekit/` owns `createSessionHandler`, `createSessionCookie`,
`destroySessionCookie`, and `switchSessionTenant`. Use README integration examples
rather than copying application setup into these instructions.

From the repository root:

```bash
pnpm --filter @happyvertical/smrt-users test
pnpm --filter @happyvertical/smrt-users typecheck
pnpm --filter @happyvertical/smrt-users test:postgres
```

Start with the relevant test file via `test -- src/__tests__/<file>.test.ts`.
Run `test:postgres` for RLS, principal context, OIDC, or terminal-auth database
changes. `typecheck` includes Svelte accessibility checks; plain `tsc` is
insufficient. Follow root knowledge freshness checks before shipping.
