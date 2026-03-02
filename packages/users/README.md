# @happyvertical/smrt-users

Multi-tenant user management with RBAC, hierarchical tenants, session handling, and SvelteKit integration.

## Installation

```bash
pnpm add @happyvertical/smrt-users
```

## Usage

### Roles and permissions

```typescript
import {
  RoleCollection, MembershipCollection, PermissionResolver,
} from '@happyvertical/smrt-users';

const db = { db: { type: 'sqlite', url: 'app.db' } };

// Seed system roles (owner, admin, member, viewer) — required at app init
const roles = await RoleCollection.create(db);
await roles.seedSystemRoles();

// Assign a user to a tenant with the admin role
const memberships = await MembershipCollection.create(db);
const adminRole = await roles.findBySlug('admin');
await (await memberships.create({
  userId: user.id, tenantId: tenant.id, roleId: adminRole.id,
})).save();

// Check permissions
const resolver = await PermissionResolver.create(db);
await resolver.hasPermission(user.id, tenant.id, 'articles.create');
```

### SvelteKit hooks

```typescript
// hooks.server.ts
import { createSessionHandler } from '@happyvertical/smrt-users/sveltekit';

export const handle = createSessionHandler({
  db: { type: 'postgres', url: process.env.DATABASE_URL },
  ttl: 7 * 24 * 60 * 60, // 7 days in seconds
  skipPaths: ['/api/health'],
});
// Populates event.locals: { user, permissions, tenantId, sessionId }

// +page.server.ts
import { createSessionCookie, destroySessionCookie } from '@happyvertical/smrt-users/sveltekit';

await createSessionCookie(event, userId, tenantId, { db }); // login
await destroySessionCookie(event, { db });                   // logout
```

## Key Concepts

### Permission cascade (4 levels)

PermissionResolver evaluates permissions in order, where each level can add or remove grants:

1. **Tenant hierarchy** -- walk ancestors, apply TenantPermissionOverride at each level
2. **Membership role** -- base permissions from the user's role in the tenant
3. **Group roles** -- permissions from all groups the user belongs to in that tenant
4. **Membership overrides** -- per-user GRANT/DENY (DENY always wins)

### Hierarchical tenants

Tenants support parent-child trees (max depth 10). Two flags control inheritance: `cascadePermissions` (parent pushes down) and `inheritPermissions` (child accepts). Both must be true for permissions to flow.

### Tenant policies

TenantService supports three modes: `flexible` (no auto-create), `personal` (auto-create on first login, deletable), `required` (auto-create, must keep at least one).

## API

### Models

| Export | Description |
|--------|-------------|
| `User` | Auth identity. Email auto-lowercased. `profileId` links to smrt-profiles (plain string). |
| `Tenant` | Organizational boundary. STI. Hierarchical via `parentTenantId`/`hierarchyPath`. |
| `Role` | Permission template. `tenantId = null` for system roles. `isSystem` blocks deletion. |
| `Permission` | Named capability. Slug format: `resource.action`. |
| `Session` | Server-side session. Secure UUID. TTL in seconds. |
| `Group` | Team within a tenant. Gains permissions via GroupRole. |
| `Membership` | User + Tenant + Role junction. UNIQUE(userId, tenantId). |
| `MembershipOverride` | Per-user permission grant/deny on a membership. |
| `TenantPermissionOverride` | Tenant-level permission override (INHERIT/GRANT/DENY). |
| `GroupMember`, `GroupRole`, `RolePermission` | Junction tables for groups and role-permission assignments. |

### Collections

| Export | Description |
|--------|-------------|
| `UserCollection`, `TenantCollection`, `RoleCollection` | Core CRUD. TenantCollection adds `createChild()`, `getTree()`. RoleCollection adds `seedSystemRoles()`. |
| `PermissionCollection`, `SessionCollection` | Permission CRUD with `findByIds()`. Session CRUD with `findValidSession()`, `deleteExpired()`. |
| `MembershipCollection` | Membership CRUD, `findByUserAndTenant()` |
| `MembershipOverrideCollection`, `TenantPermissionOverrideCollection` | Override management at membership and tenant levels |
| `GroupCollection`, `GroupMemberCollection`, `GroupRoleCollection`, `RolePermissionCollection` | Group and role-permission junction management |

### Services

| Export | Description |
|--------|-------------|
| `PermissionResolver` | Resolves effective permissions via 4-level cascade. `hasPermission()`, `resolvePermissions()`. |
| `SessionService` | High-level session management. `createSession()`, `loadSessionContext()`, `destroySession()`. |
| `TenantService` | Policy-driven tenant lifecycle. `ensureTenantForUser()`, `createTenantWithOwnership()`. |

### SvelteKit (`@happyvertical/smrt-users/sveltekit`)

| Export | Description |
|--------|-------------|
| `createSessionHandler` | SvelteKit handle hook that populates `event.locals` |
| `createSessionCookie` | Set session cookie after login |
| `destroySessionCookie` | Clear session cookie on logout |
| `switchSessionTenant` | Change tenant context for current session |
| `SessionLocals` | Type for `event.locals` (extend in `app.d.ts`) |

### Types & Constants

| Export | Description |
|--------|-------------|
| `UserStatus`, `TenantStatus`, `SessionStatus`, `MembershipStatus` | Status enums |
| `OverrideEffect`, `TenantPermissionEffect` | Override effect enums |
| `DEFAULT_ROLE_SLUGS`, `DEFAULT_ROLES`, `DEFAULT_TENANT_POLICY` | System role slugs, role configs, default tenant policy |
| `DEFAULT_SESSION_TTL`, `MAX_TENANT_HIERARCHY_DEPTH` | 604800 (7 days in seconds), 10 |
| `TenantHierarchyError` | Thrown when hierarchy depth limit is exceeded |

## Dependencies

- `@happyvertical/smrt-core` -- ORM, `@smrt()` decorator, SmrtObject/SmrtCollection
- `@happyvertical/smrt-types` -- shared enums (UserStatus, SessionStatus, etc.)
- `@happyvertical/smrt-profiles` -- optional peer dependency for profile linking
- `svelte` -- optional peer dependency for Svelte components

## License

MIT
