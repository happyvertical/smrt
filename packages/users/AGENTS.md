# @happyvertical/smrt-users

Multi-tenant user management with RBAC, hierarchical tenants, session handling, and SvelteKit integration.

## Models (14)

| Model | Key Pattern |
|-------|-------------|
| User | Auth identity. `profileId` is plain string (not FK) to smrt-profiles. Email auto-lowercased. |
| AccessRequest | "Request access / waitlist" record captured before a `User` exists. CLOSED generated surface (`api`/`mcp`/`cli` = `[]`) — all access via `AccessRequestService`. Email normalized + indexed; JSON `requestContext` (NOT `context` — reserved for slug scoping). |
| Tenant | **STI** + hierarchical parent-child. `hierarchyPath` (materialized path), `hierarchyLevel`. Max depth 10. |
| Session | Server-side. Secure UUID. TTL in **seconds** (not ms). Status auto-updates to EXPIRED on access. |
| MagicLinkToken | Single-use email login token. Backed by `MagicLinkService`. |
| Role | `tenantId = null` → system role (available to all tenants). `isSystem: true` blocks deletion. `inheritsToDescendants: true` (default false) opts the role's membership authority into descendant tenants. |
| Permission | Slug format: `resource.action`. Parsed by PermissionResolver. |
| Membership | User + Tenant + Role junction. UNIQUE(userId, tenantId). |
| Group | Team within a tenant. Multiple roles via GroupRole. |
| GroupMember, GroupRole, RolePermission | Join tables. |
| MembershipOverride | Per-user permission grant/deny. **DENY always wins.** |
| TenantPermissionOverride | Tenant-level cascade overrides. Effect: INHERIT/GRANT/DENY. |

## Permission Resolution — Precedence (broad → specific, most-specific wins)

`PermissionResolver.resolvePermissions` builds the effective set in this order;
each later layer overrides earlier ones:

1. **Tenant-inherited** — walk ancestors, apply each `TenantPermissionOverride`
   down the cascade (GRANT adds, DENY removes within the hierarchy)
2. **Membership role** — base permissions from the user's role in the tenant
3. **Group roles** — permissions from all groups the user belongs to **in that tenant**
4. **Tenant-level DENY** *(removes; overrides role/group grants, tenant-wide)* — a
   `TenantPermissionOverride` with effect `DENY` is a HARD, tenant-wide block: it
   subtracts the DENY'd slug even if a role or group granted it (steps 2–3). It
   sits just **above** the per-user membership overrides and **below** role/group.
5. **Membership GRANT override** *(re-adds; most specific)* — a per-user GRANT can
   re-add a slug a tenant DENY'd in step 4, because it is more specific.
6. **Membership DENY override** *(absolute; always wins)* — a per-user DENY removes
   the slug last and is never overridden.

So a permission a role grants but the tenant DENYs is **removed**, unless that
exact user also has a membership-GRANT override for it. A membership-DENY always
wins. Tenant-DENY of an inherited/cascade grant still blocks it (unchanged).
The hard block reflects the tenant cascade's **net** resolution, not an
unconditional union of every DENY in the chain — so a more-specific tenant GRANT
(e.g. a child sub-tenant re-granting a permission its parent DENYs) still wins.

### Membership selection — hierarchical inheritance (opt-in, #1866)

Which membership feeds step 2 above:

1. **A direct membership row in the target tenant always pins resolution to
   itself** — active rows resolve normally; an inactive (pending/suspended)
   row resolves to the **empty set**. A direct row therefore *attenuates*
   rather than unions: "viewer here, despite being network admin" gives
   viewer, and a suspension in the child is effective even for users holding
   inheritable authority on an ancestor.
2. **No direct row** → the resolver walks the tenant's ancestors (nearest
   first, from `hierarchyPath`) and resolves through the **nearest ACTIVE
   ancestor membership whose role has `inheritsToDescendants: true`**.
   Unflagged or inactive ancestor memberships are skipped (they neither confer
   nor block); there is **no union across the chain** — the nearest flagged
   membership alone is used. To attenuate a specific descendant, create a
   direct membership there or use a tenant-level DENY.
3. **No qualifying ancestor** → empty set (byte-identical to the
   pre-inheritance resolver; with no role flagged, nothing changes).

All later layers run unchanged against the **target** tenant: the tenant
cascade and tenant-DENY hard block come from the target tenant (a child can
carve authority out of an inherited role), group roles stay exact-tenant (only
target-tenant groups contribute; ancestor groups never flow down), and
membership GRANT/DENY overrides travel with the ancestor membership used.
`PermissionResolutionResult.inheritedFromTenantId` reports the ancestor tenant
when inheritance was used (`null` for direct resolution).

Safety: resolution is bounded by `MAX_TENANT_HIERARCHY_DEPTH`; malformed
`hierarchyPath` values fail closed to the empty set — too deep,
self-referential, duplicate ancestors, or inconsistent with the actual
`parentTenantId` chain (the path is verified link-by-link against the loaded
ancestor rows before it is trusted as an authorization source). Tenant `status` is not consulted (parity with direct
resolution). Caching: a long-lived `(user, tenant)` permission cache must also
invalidate on ancestor-membership changes and on `Role.inheritsToDescendants`
flips — request-scoped caches (the common pattern) are unaffected.

Flag roles at seed time with
`seedSystemRoles({ inheritsToDescendants: ['owner', 'admin'] })` (additive:
listed slugs are flagged, omitted slugs are never unflagged; unknown slugs
throw). The default seed leaves every role exact-tenant.

## Operation Permission Guards

- Use `assertOperationPermission()` for hand-written mutations in SvelteKit form
  actions, custom endpoints, CLI scripts, and jobs. It derives the same
  `<collection>.<action>` slugs as `PermissionCatalogService` (`list`/`get` →
  `read`), requires the slug to exist in the catalog, then resolves permissions
  through `PermissionResolver`.
- `assertOperationPermission()` throws fail-closed by default. Use
  `{ onDeny: 'return' }`, `checkOperationPermission()`, or
  `hasOperationPermission()` when a structured/boolean result is needed.
- **Resource-tenant calling convention**: for resource-anchored authorization,
  pass the **resource's** tenant id — `tenantId: resourceTenantId` — not the
  session's current tenant. With `Role.inheritsToDescendants` flagged, a
  root-tenant admin then passes for any descendant resource with no app-side
  authority logic (and no membership fan-out), while per-child delegation and
  DENY precedence keep working. Do NOT pass a session-scoped `membership`
  alongside a different resource `tenantId` — a membership/tenant mismatch
  fails closed by design; omit `membership` and let the resolver look it up.
- System context and super-admin bypass context are honored for parity with
  Postgres RLS. Pass `{ allowSuperAdminBypass: false }` on money-class or
  separation-of-duties operations that must require an explicit permission grant.
- **Postgres RLS and membership inheritance**: RLS policies check the
  session-injected `smrt.permissions` list (resolved app-side by
  `PermissionResolver`), so a session whose `smrt.tenant_id` IS the child
  tenant gets inherited authority in RLS automatically. But RLS row filtering
  stays bound to the session's tenant setting — a root-tenant session acting
  on child-tenant rows is authorized by the app-level guard (resource-tenant
  convention above), not by RLS. This is a documented divergence, mirroring
  how #1829 handled bypass parity.
- Seed role mappings with `RolePermissionCollection.seedRolePermissions()` or
  `RoleCollection.seedSystemRoles({ seedPermissions: true })`. The default
  matrix maps owner/admin to all catalog permissions, member to read/create for
  ordinary app resources, and viewer to read-only. Member create grants
  intentionally exclude users/RBAC authority and security resources (`users`,
  `tenants`, `roles`, `permissions`, memberships, groups, sessions, magic-link
  tokens, and related join/override tables). Re-seeding is additive and
  idempotent; pruning stale mappings requires `{ prune: true }`.

**Critical**: `getGroupIdsForTenant(userId, tenantId)` (joins with groups table to scope by tenant). Never use `getGroupIds()` — it's cross-tenant.

## Hierarchical Tenants

- `TenantCollection.createChild()` auto-calculates hierarchy fields, enforces depth limit
- `moveToParent()` updates tenant + ALL descendants' paths/levels
- `cascadePermissions` (parent pushes down) + `inheritPermissions` (child accepts) — both must be true
- `getTree(rootId?)` returns nested structure for UI
- Two independent downward flows: the `TenantPermissionOverride` **cascade**
  (tenant-level permission config, flags above) and **membership-role
  inheritance** (`Role.inheritsToDescendants`, per-role opt-in — see
  "Membership selection" above). The cascade flags do not gate membership
  inheritance.

## SvelteKit Integration

```typescript
// hooks.server.ts
export const handle = createSessionHandler({ db, ttl: 604800, skipPaths: ['/api/public'] });
// Populates event.locals: { user, membership, permissions: string[], tenantId, sessionId }

// +page.server.ts
await createSessionCookie(event, userId, tenantId, { db });
await destroySessionCookie(event, { db });
await switchSessionTenant(event, tenantId, { db });
```

## Mobile `/api/mobile` Handlers (ADR 0001 Phase 3.5, #1748)

`createMobileAuthHandlers(options)` (from `/sveltekit`) returns the mountable
server side of the KMP mobile contract: `authStart` (`POST auth/start`,
server-brokered PKCE via `OidcLoginService`), `authComplete`
(`POST auth/complete`, code + echoed `state`/`codeVerifier` → bearer
session), `session.GET`/`session.DELETE` (bootstrap/logout), and
`guard`/`withSession` — the bearer middleware for app-owned mobile routes.
Core logic lives in `MobileAuthService` (framework-agnostic; exported from
the package root).

- **Bearer = session id** (same convention as `TerminalAuthService`); 401
  bodies are `{ error, code }` and drive the mobile client's re-auth flow.
- **Stateless handshake**: the OAuth `state` is an HMAC-signed token
  (secret: `stateSecret` ?? provider `clientSecret`) carrying
  nonce/provider/createdAt — full ID-token nonce verification with no
  server-side pending state. The `codeVerifier` never enters a URL: it is
  client-held per the frozen contract.
- **Wire DTOs** come from `@happyvertical/smrt-mobile-contract`
  (`MobileAuthStartRequest` etc.) — one owning package for the Kotlin,
  Swift, and TypeScript shapes (compile-checked descriptors + parity test).
- **Tenant options** honor `Role.inheritsToDescendants` (#1867): direct
  ACTIVE memberships plus descendants of flagged memberships (nearest
  flagged ancestor labels the option; any direct row pins; inactive direct
  rows exclude). Session binding defaults to the first DIRECT tenant —
  override with `resolveTenantId`.
- **Hooks**: `resolveUser` (invite-gating; default provisions via
  `getOrCreateFromOidc`), `resolveTenantId`, `buildExtras` (bootstrap
  `extras`; model JSON must use `toPublicJSON({ permissions })` — #1822).
- **Guard** wraps `withSessionPermissionContext`, so
  `assertOperationPermission`, tenancy context, and Postgres RLS all see the
  bearer caller; `OperationPermissionError` maps to 403 with a
  machine-readable `reason`.
- **Uploads**: `resolveMobileUploadDedupKey` + the documented contract in
  `docs/content/architecture/mobile-upload-contract.md` (`clientCaptureId`
  field, `Idempotency-Key` header fallback); domain ingestion stays
  app-side. Framework-model writes ride `sync/apply`, not this path.
- Configure `redirectUris` in production — RFC 8252 scheme rules always
  apply, but the allow list is the defense against redirecting authorization
  responses to attacker-controlled URIs.

## Security (S5 #1400)

- **Generated REST/MCP surface is READ-ONLY for every RBAC/identity model.**
  User, Tenant, Group, Membership, MembershipOverride, Role, Permission,
  RolePermission, GroupRole, GroupMember, and TenantPermissionOverride generate
  `list`/`get` only — `create`/`update`/`delete` are intentionally NOT
  generated. The merged `requireRouteAuth` gate (#1540) enforces *authentication*,
  not *authorization*, and these models are not `@TenantScoped`, so an
  auto-generated mutating route would let any authenticated user self-grant a
  role/permission, flip a tenant's cascade flags, or change another user's auth
  identity. Mutate them through the permission-gated services (`TenantService`,
  collection helpers) or consumer-owned, permission-checked handlers. A
  structural regression test (`security-audit-1400.test.ts`) enumerates the
  registry to assert no authority model exposes a mutating op. (`cli` stays
  enabled — local-operator surface, outside the network/agent threat model.)
- **`switchTenant` is fail-closed AND rotates the session id.**
  `SessionService.switchTenant` / `switchSessionTenant` verify the session's user
  has an ACTIVE membership in the target tenant before any write (the tenant id
  is the isolation key for every `@TenantScoped` query). A non-member/unknown-
  session switch returns `{ switched: false, sessionId: null, ... }` and mutates
  nothing. On a successful switch into a NON-null tenant the session id is
  ROTATED: a fresh `Session` (new secure id, fresh TTL, same user, new tenant,
  device context carried over) is minted and the old session is REVOKED — so a
  captured pre-switch id immediately stops validating, shrinking the blast radius
  of a leaked id across a tenant boundary. `switchTenant` returns a
  `SwitchTenantResult` (`{ switched, sessionId, session, rotated }`); callers MUST
  persist the returned `sessionId`. `switchSessionTenant` does this for you by
  re-setting the session cookie (preserving httpOnly/secure/sameSite) to the new
  id. A `null` clear stays in place (no rotation, no cookie change). The
  low-level `SessionCollection.setSessionTenant` is the UNGUARDED primitive (used
  for the null-clear path) — never call it with an untrusted tenant id.
- **OIDC `email_verified` is enforced.** `UserCollection.getOrCreateFromOidc`
  refuses to provision a user when the IdP explicitly returns
  `email_verified: false` (opt out with `{ allowUnverifiedEmail: true }`). An
  absent claim makes no assertion and is not enforced.

## Gotchas

- **seedSystemRoles() required**: call `RoleCollection.seedSystemRoles()` at app init (creates owner/admin/member/viewer)
- **PermissionResolver casts `as any`**: collections have protected constructors — known framework limitation
- **Session TTL in seconds**: `DEFAULT_SESSION_TTL = 7 * 24 * 60 * 60` (not milliseconds)
- **Users are cross-tenant**: one user, many tenants via Membership. Email globally unique.
- **Batch permission queries**: resolver fetches all permission IDs in one query, then maps to slugs (avoids N+1)
