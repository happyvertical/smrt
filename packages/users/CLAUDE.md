# @happyvertical/smrt-users

Multi-tenant user management for the SMRT framework - users, tenants, roles, permissions, and groups with hierarchical permission resolution.

## Purpose

This package provides SMRT-wrapped models for multi-tenant user management:

- **User**: Authenticated identity linked to Profile
- **Tenant**: Organizational boundary (company, workspace)
- **Membership**: User belongs to Tenant with a Role
- **Role**: Permission template (system or tenant-specific)
- **Permission**: Named capability (e.g., `articles.create`)
- **Group**: Teams within a tenant that grant additional roles
- **MembershipOverride**: Per-user permission grant/deny

## Architecture

```
Profile (smrt-profiles)
   ↑
User (profileId reference)
   ↓
Membership (userId, tenantId, roleId)
   │
   ├─→ Role ──→ RolePermission ──→ Permission
   │      ↑
   └─→ MembershipOverride ──→ Permission (grant/deny)
         ↓
       Group ──→ GroupRole ──→ Role
         ↓
       GroupMember ──→ User
```

## Permission Resolution Algorithm

The `PermissionResolver` service resolves effective permissions:

1. **Get Membership**: Find user's membership in the tenant
2. **Base Permissions**: Get permissions from membership's role
3. **Group Permissions**: Add permissions from all groups user belongs to
4. **Apply Overrides**: Apply membership overrides (DENY takes precedence over GRANT)

```typescript
const resolver = await PermissionResolver.create({
  db: { type: 'sqlite', url: 'app.db' }
});

// Check a single permission
const canCreate = await resolver.hasPermission(userId, tenantId, 'articles.create');

// Get all permissions
const result = await resolver.resolvePermissions(userId, tenantId);
console.log(result.permissions); // Set<string> of permission slugs
console.log(result.groupIds);    // Groups that contributed permissions
```

## Key Concepts

### System vs Tenant Roles

- **System roles** (`tenantId = null`): Available to all tenants, cannot be deleted
- **Tenant roles** (`tenantId` set): Custom roles specific to a tenant

```typescript
// Seed default system roles (owner, admin, member, viewer)
const roles = await RoleCollection.create(options);
await roles.seedSystemRoles();

// Create tenant-specific role
const customRole = await roles.create({
  tenantId: tenant.id,
  name: 'Content Editor',
  description: 'Can edit content but not publish'
});
await customRole.save();
```

### Permission Overrides

Override individual permissions for specific users:

```typescript
// Grant extra permission to a user
await membershipOverrides.grantPermission(membership.id, specialPerm.id);

// Deny a permission (even if their role grants it)
await membershipOverrides.denyPermission(membership.id, dangerousPerm.id);
```

DENY overrides always take precedence over GRANT.

### Groups for Team-Based Access

Groups allow granting additional roles to sets of users:

```typescript
// Create a group
const editorsGroup = await groups.create({
  tenantId: tenant.id,
  name: 'Editorial Team'
});
await editorsGroup.save();

// Assign roles to the group
await groupRoles.addRole(editorsGroup.id, editorRole.id);

// Add users to the group
await groupMembers.addMember(editorsGroup.id, user.id);

// User now inherits editor role permissions
```

## Usage

### Basic Setup

```typescript
import {
  UserCollection,
  TenantCollection,
  RoleCollection,
  PermissionCollection,
  MembershipCollection,
  PermissionResolver,
  MembershipStatus,
  DEFAULT_ROLES,
} from '@happyvertical/smrt-users';

const options = {
  db: { type: 'sqlite', url: 'app.db' }
};

// Create collections
const users = await UserCollection.create(options);
const tenants = await TenantCollection.create(options);
const roles = await RoleCollection.create(options);
const permissions = await PermissionCollection.create(options);
const memberships = await MembershipCollection.create(options);
```

### Creating a User and Tenant

```typescript
// Create user linked to profile
const user = await users.create({
  email: 'john@example.com',
  profileId: 'profile-123'  // Link to smrt-profiles
});
await user.save();

// Create tenant
const tenant = await tenants.create({
  name: 'Acme Corp'
});
await tenant.save();

// Seed system roles if not done
await roles.seedSystemRoles();

// Get the admin role
const adminRole = await roles.findBySlug('admin');

// Create membership (user joins tenant as admin)
const membership = await memberships.create({
  userId: user.id,
  tenantId: tenant.id,
  roleId: adminRole.id,
  status: MembershipStatus.ACTIVE
});
await membership.save();
```

### Defining Permissions

```typescript
// Create application permissions
const createPerm = await permissions.create({
  slug: 'articles.create',
  name: 'Create Articles',
  description: 'Can create new articles',
  category: 'articles'
});
await createPerm.save();

const updatePerm = await permissions.create({
  slug: 'articles.update',
  name: 'Update Articles',
  category: 'articles'
});
await updatePerm.save();

// Assign permissions to role
await rolePermissions.addPermission(editorRole.id, createPerm.id);
await rolePermissions.addPermission(editorRole.id, updatePerm.id);
```

### Checking Permissions

```typescript
const resolver = await PermissionResolver.create(options);

// Single permission check
if (await resolver.hasPermission(userId, tenantId, 'articles.create')) {
  // User can create articles
}

// Check multiple permissions
const canEditAndPublish = await resolver.hasAllPermissions(
  userId,
  tenantId,
  ['articles.update', 'articles.publish']
);

// Check if user has any of the permissions
const canModify = await resolver.hasAnyPermission(
  userId,
  tenantId,
  ['articles.update', 'articles.delete']
);
```

## Models Reference

### User

| Field | Type | Description |
|-------|------|-------------|
| profileId | string | Link to smrt-profiles Profile |
| email | string | Unique email address |
| status | UserStatus | active, inactive, suspended, pending |
| lastLoginAt | Date \| null | Last login timestamp |

### Tenant

| Field | Type | Description |
|-------|------|-------------|
| name | string | Display name |
| status | TenantStatus | active, inactive, suspended |

### Role

| Field | Type | Description |
|-------|------|-------------|
| tenantId | string \| null | null = system role |
| name | string | Display name |
| description | string | Role description |
| isSystem | boolean | Cannot be deleted if true |

### Permission

| Field | Type | Description |
|-------|------|-------------|
| slug | string | Unique identifier (e.g., 'articles.create') |
| name | string | Display name |
| description | string | What this permission allows |
| category | string | Grouping for UI |

### Membership

| Field | Type | Description |
|-------|------|-------------|
| userId | foreignKey(User) | User reference |
| tenantId | foreignKey(Tenant) | Tenant reference |
| roleId | foreignKey(Role) | Role reference |
| status | MembershipStatus | active, inactive, pending |

### MembershipOverride

| Field | Type | Description |
|-------|------|-------------|
| membershipId | foreignKey(Membership) | Membership reference |
| permissionId | foreignKey(Permission) | Permission reference |
| effect | OverrideEffect | 'grant' or 'deny' |

### Group

| Field | Type | Description |
|-------|------|-------------|
| tenantId | foreignKey(Tenant) | Parent tenant |
| name | string | Group name |
| description | string | Group description |

## Default System Roles

| Slug | Name | Description |
|------|------|-------------|
| owner | Owner | Full access to all resources |
| admin | Administrator | Manage users and settings |
| member | Member | Standard access |
| viewer | Viewer | Read-only access |

## Testing

```bash
# Generate manifest and run tests
pnpm run test

# Or run manually
pnpm run generate:test
npx vitest run
```

## Dependencies

- `@happyvertical/smrt-core`: SMRT framework
- `@happyvertical/smrt-profiles` (peer): Profile linking

## Environment Variables

No specific environment variables required.

## Future Enhancements

- Auto-generate permissions from ObjectRegistry (scan SMRT objects for API/MCP endpoints)
- Permission templates for common patterns
- Audit logging for permission changes
