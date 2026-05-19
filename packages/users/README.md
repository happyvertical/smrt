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

### Manifest-derived permission catalog

SMRT objects now contribute permissions automatically based on their public
surface area.

```typescript
import { SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  api: { include: ['list', 'create', 'publish'] },
  cli: { include: ['get', 'archive'] },
  collection: 'articles',
  mcp: { include: ['update'] },
  tenantScoped: { mode: 'required' },
})
class Article extends SmrtObject {
  tenantId: string = '';
  title: string = '';

  async publish(): Promise<boolean> {
    return true;
  }

  async archive(): Promise<boolean> {
    return true;
  }
}
```

This produces the following permission slugs:

- `articles.read` from `list` or `get`
- `articles.create`
- `articles.update`
- `articles.publish`
- `articles.archive`

Non-public methods and actions that are not exposed through API, CLI, or MCP are
not added to the catalog.

### Sync the permission catalog

Use `syncPermissionCatalog()` during bootstrapping, migrations, or deploy hooks
to upsert discovered permissions into the `Permission` table.

```typescript
import { syncPermissionCatalog } from '@happyvertical/smrt-users';

const db = {
  db: {
    type: 'postgres' as const,
    url: process.env.DATABASE_URL!,
  },
};

const result = await syncPermissionCatalog(db);

console.log('created', result.created);
console.log('updated', result.updated);
console.log('unchanged', result.unchanged);
```

Catalog sync is additive and fail-closed:

- it creates missing `Permission` rows
- it updates `name`, `description`, and `category` by slug
- it does not auto-grant permissions to roles
- it does not delete stale permissions in v1

### App-defined permissions in `smrt.config.ts`

Use package config for permissions that do not come from the manifest.

```typescript
// smrt.config.ts
import { defineConfig } from '@happyvertical/smrt-config';

export default defineConfig({
  packages: {
    users: {
      permissions: {
        custom: [
          {
            category: 'app',
            description: 'Allows access to the operations dashboard',
            name: 'View Operations Dashboard',
            slug: 'operations.dashboard',
          },
          {
            category: 'audits',
            name: 'Inspect Audit Rows',
            postgres: {
              bindings: [
                {
                  action: 'select',
                  tableName: 'audit_logs',
                },
                {
                  action: 'insert',
                  tableName: 'audit_logs',
                },
              ],
            },
            slug: 'audits.inspect',
          },
        ],
        postgres: {
          enabled: true,
        },
      },
    },
  },
});
```

Custom permissions merge with manifest-derived permissions by slug. If the same
slug is registered with conflicting metadata, SMRT throws so the mismatch is
visible early.

### Runtime permission registration

Use `registerPermissionDefinitions()` when a package or integration needs to
declare permissions at runtime.

```typescript
import {
  registerPermissionDefinitions,
  syncPermissionCatalog,
} from '@happyvertical/smrt-users';

const unregister = registerPermissionDefinitions([
  {
    category: 'billing',
    description: 'Allows exporting invoices',
    name: 'Export Invoices',
    slug: 'invoices.export',
  },
]);

try {
  await syncPermissionCatalog({
    db: { type: 'sqlite', url: 'app.db' },
  });
} finally {
  unregister();
}
```

### Postgres RLS enforcement

For Postgres, SMRT can generate and apply row-level security policies directly
from the permission catalog.

```typescript
import {
  applyPostgresPermissionPolicies,
  generatePostgresPermissionSql,
  syncPermissionCatalog,
} from '@happyvertical/smrt-users';

const db = {
  db: {
    type: 'postgres' as const,
    url: process.env.DATABASE_URL!,
  },
};

await syncPermissionCatalog(db);

const preview = generatePostgresPermissionSql(db);
console.log(preview.targets);
console.log(preview.skipped);

await applyPostgresPermissionPolicies(db);
```

Automatic policy generation currently applies only to objects that are:

- tenant-scoped with `tenantScoped: { mode: 'required' }`
- backed by a real Postgres table
- mapped to a single tenant field

Automatic CRUD policy mapping is fixed in v1:

- `SELECT` -> `<collection>.read`
- `INSERT` -> `<collection>.create`
- `UPDATE` -> `<collection>.update`
- `DELETE` -> `<collection>.delete`

Optional-tenancy and global tables are skipped and returned in
`result.skipped` instead of generating unsafe policies. Custom permissions can
participate in RLS by adding explicit Postgres bindings as shown above.

### SvelteKit hooks

```typescript
// hooks.server.ts
import { createSessionHandler } from '@happyvertical/smrt-users/sveltekit';

export const handle = createSessionHandler({
  db: { type: 'postgres', url: process.env.DATABASE_URL },
  enterTenantContext: true,
  postgresRls: true,
  ttl: 7 * 24 * 60 * 60, // 7 days in seconds
  skipPaths: ['/api/health'],
});
// Populates event.locals: { user, permissions, tenantId, sessionId }

// +page.server.ts
import { createSessionCookie, destroySessionCookie } from '@happyvertical/smrt-users/sveltekit';

await createSessionCookie(event, userId, tenantId, { db }); // login
await destroySessionCookie(event, { db });                   // logout
```

### OIDC login with Kanidm or Dex

Kanidm and Dex both work through the generic SMRT OIDC flow. Configure one or
more providers under `packages.users.auth.oidc.providers`, then add login and
callback route handlers.

```typescript
// smrt.config.ts
import { defineConfig } from '@happyvertical/smrt-config';

export default defineConfig({
  packages: {
    users: {
      auth: {
        oidc: {
          defaultProvider: 'kanidm',
          providers: {
            kanidm: {
              kind: 'kanidm',
              issuer: process.env.KANIDM_ISSUER!,
              clientId: process.env.KANIDM_CLIENT_ID!,
              clientSecret: process.env.KANIDM_CLIENT_SECRET,
              redirectUri: 'http://localhost:5173/auth/kanidm/callback',
            },
            dex: {
              kind: 'dex',
              issuer: process.env.DEX_ISSUER!,
              clientId: process.env.DEX_CLIENT_ID!,
              clientSecret: process.env.DEX_CLIENT_SECRET,
              redirectUri: 'http://localhost:5173/auth/dex/callback',
            },
          },
        },
      },
    },
  },
});
```

```typescript
// src/routes/auth/[provider]/login/+server.ts
import { createOidcLoginHandler } from '@happyvertical/smrt-users/sveltekit';

export const GET = createOidcLoginHandler({
  db: { type: 'postgres', url: process.env.DATABASE_URL! },
});
```

```typescript
// src/routes/auth/[provider]/callback/+server.ts
import { createOidcCallbackHandler } from '@happyvertical/smrt-users/sveltekit';

export const GET = createOidcCallbackHandler({
  db: { type: 'postgres', url: process.env.DATABASE_URL! },
  successRedirect: '/dashboard',
});
```

The callback verifies `state`, PKCE, issuer, audience, nonce, and the provider
JWKS-signed ID token, falling back to the OIDC UserInfo endpoint when the ID
token omits required profile claims like `email`. Temporary transaction cookies
are HMAC-signed with the provider `clientSecret` when present; public clients
can pass `transactionCookieSecret` to the route helpers. On success it creates
or reuses a SMRT `Profile`, links an `OidcIdentity`, creates or reuses a `User`,
records `lastLoginAt`, and sets the standard SMRT session cookie.

With `postgresRls: true`, SMRT opens a request-scoped Postgres transaction,
loads the session, resolves permissions, and sets session variables used by the
generated RLS helpers:

- `smrt.tenant_id`
- `smrt.user_id`
- `smrt.session_id`
- `smrt.permissions`
- `smrt.super_admin_bypass`
- `smrt.system_context`

With `enterTenantContext: true`, the same request also enters
`@happyvertical/smrt-tenancy` context so regular collection access is scoped to
the current tenant in application code.

### Request-scoped database access

Generated SvelteKit helpers and custom server code can read the current
request-scoped database, which is especially useful when Postgres RLS is enabled
and you want collection operations to use the active transaction.

```typescript
import {
  getRequestScopedDatabase,
  withSessionPermissionContext,
} from '@happyvertical/smrt-users';

const response = await withSessionPermissionContext(
  {
    db: { type: 'postgres', url: process.env.DATABASE_URL! },
    enterTenantContext: true,
    postgresRls: true,
    sessionId,
  },
  async (context) => {
    const database = getRequestScopedDatabase();

    console.log(context.permissions);
    console.log(database === context.database); // true

    return new Response('ok');
  },
);
```

## Key Concepts

### Permission cascade (4 levels)

PermissionResolver evaluates permissions in order, where each level can add or remove grants:

1. **Tenant hierarchy** -- walk ancestors, apply TenantPermissionOverride at each level
2. **Membership role** -- base permissions from the user's role in the tenant
3. **Group roles** -- permissions from all groups the user belongs to in that tenant
4. **Membership overrides** -- per-user GRANT/DENY (DENY always wins)

Tenant-level inherited permissions are part of the effective permission set
returned by `resolvePermissions()` and `SessionService.loadSessionContext()`.

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
| `PermissionCatalogService`, `syncPermissionCatalog()` | Discovers manifest/config/runtime permissions and upserts them into `Permission` rows. |
| `registerPermissionDefinitions()` | Register app or integration permissions at runtime and receive an unregister cleanup function. |
| `generatePostgresPermissionSql()`, `applyPostgresPermissionPolicies()` | Preview or apply Postgres RLS helper functions and table policies. |
| `SessionService` | High-level session management. `createSession()`, `loadSessionContext()`, `destroySession()`. |
| `OidcLoginService` | Generic OIDC authorization-code login with PKCE for Kanidm, Dex, and other standards-compliant providers. |
| `withSessionPermissionContext()` | Loads a session, optionally enters tenancy context, and exposes a request-scoped database/permission context. |
| `getCurrentSessionPermissionContext()`, `getRequestScopedDatabase()` | Read the active request/session context inside app code. |
| `TenantService` | Policy-driven tenant lifecycle. `ensureTenantForUser()`, `createTenantWithOwnership()`. |

### SvelteKit (`@happyvertical/smrt-users/sveltekit`)

| Export | Description |
|--------|-------------|
| `createSessionHandler` | SvelteKit handle hook that populates `event.locals`, and can also enter tenancy context and Postgres RLS request transactions |
| `createSessionCookie` | Set session cookie after login |
| `destroySessionCookie` | Clear session cookie on logout |
| `switchSessionTenant` | Change tenant context for current session |
| `beginOidcLogin`, `completeOidcLogin` | Low-level SvelteKit helpers for custom OIDC login routes |
| `createOidcLoginHandler`, `createOidcCallbackHandler` | Ready-to-use SvelteKit route handlers for OIDC login and callback |
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
- `jose` -- JWT/JWKS verification for OIDC and magic-link tokens
- `svelte` -- optional peer dependency for Svelte components

## License

MIT
