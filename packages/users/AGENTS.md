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

## Permission Resolution — 4-Level Cascade

PermissionResolver evaluates in order (each level can add/remove permissions):

1. **Tenant hierarchy** — walk ancestors, apply TenantPermissionOverride at each level
2. **Membership role** — base permissions from user's role in tenant
3. **Group roles** — permissions from all groups user belongs to **in that tenant**
4. **Membership overrides** — final GRANT/DENY per-user (DENY takes absolute precedence)

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
// Populates event.locals: { user, permissions: string[], tenantId, sessionId }

// +page.server.ts
await createSessionCookie(event, userId, tenantId, { db });
await destroySessionCookie(event, { db });
await switchSessionTenant(event, tenantId, { db });
```

## Gotchas

- **seedSystemRoles() required**: call `RoleCollection.seedSystemRoles()` at app init (creates owner/admin/member/viewer)
- **PermissionResolver casts `as any`**: collections have protected constructors — known framework limitation
- **Session TTL in seconds**: `DEFAULT_SESSION_TTL = 7 * 24 * 60 * 60` (not milliseconds)
- **Users are cross-tenant**: one user, many tenants via Membership. Email globally unique.
- **Batch permission queries**: resolver fetches all permission IDs in one query, then maps to slugs (avoids N+1)
