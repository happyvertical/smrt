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
| `src/retention.ts` | expired session/token/CLI-auth reaping and retention sweep wiring | [agents/retention.md](agents/retention.md) |

## Models and authority

- Users are global; tenant access comes through Membership (unique user/tenant).
  User email is normalized and globally unique through readonly nullable
  `emailKey`. `profileId` is a unique cross-package reference: at most one User
  owns each non-null Profile.
- Tenant uses STI and a materialized hierarchy, maximum depth 10.
  `createChild()` calculates paths; `moveToParent()` updates all descendants.
- Role with `tenantId = null` is available to all tenants; `isSystem` prevents
  deletion. `inheritsToDescendants` is opt-in. Seed owner/admin/member/viewer
  through `RoleCollection.seedSystemRoles()` at application initialization.
- Group roles apply only in their own tenant. Use `getGroupIdsForTenant()`,
  never cross-tenant `getGroupIds()`, for authorization.
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
- Tenant switching verifies active membership before writing and rotates the
  session ID for non-null targets, revoking the old session. Persist the returned
  `SwitchTenantResult.sessionId`; `switchSessionTenant()` updates the cookie and
  preserves its security settings. Failed switches mutate nothing; null clears
  do not rotate. `SessionCollection.setSessionTenant()` is unguarded and must
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
