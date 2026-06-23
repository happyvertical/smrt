# @happyvertical/smrt-users

Multi-tenant user management with RBAC, hierarchical tenants, session handling, and SvelteKit integration.

## Models (13)

| Model | Key Pattern |
|-------|-------------|
| User | Auth identity. `profileId` is plain string (not FK) to smrt-profiles. Email auto-lowercased. |
| Tenant | **STI** + hierarchical parent-child. `hierarchyPath` (materialized path), `hierarchyLevel`. Max depth 10. |
| Session | Server-side. Secure UUID. TTL in **seconds** (not ms). Status auto-updates to EXPIRED on access. |
| MagicLinkToken | Single-use email login token. Backed by `MagicLinkService`. |
| Role | `tenantId = null` → system role (available to all tenants). `isSystem: true` blocks deletion. |
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

**Critical**: `getGroupIdsForTenant(userId, tenantId)` (joins with groups table to scope by tenant). Never use `getGroupIds()` — it's cross-tenant.

## Hierarchical Tenants

- `TenantCollection.createChild()` auto-calculates hierarchy fields, enforces depth limit
- `moveToParent()` updates tenant + ALL descendants' paths/levels
- `cascadePermissions` (parent pushes down) + `inheritPermissions` (child accepts) — both must be true
- `getTree(rootId?)` returns nested structure for UI

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
