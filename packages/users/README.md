# @happyvertical/smrt-users

Multi-tenant user management for the SMRT framework.

## Installation

```bash
pnpm add @happyvertical/smrt-users
```

## Features

- **Multi-tenant architecture**: Users belong to multiple tenants with different roles
- **Role-based access control (RBAC)**: Assign permissions through roles
- **Group-based permissions**: Grant additional roles via group membership
- **Permission overrides**: Grant or deny specific permissions per user
- **System roles**: Pre-defined roles available to all tenants

## Quick Start

```typescript
import {
  UserCollection,
  TenantCollection,
  RoleCollection,
  MembershipCollection,
  PermissionResolver,
} from '@happyvertical/smrt-users';

// Create collections
const users = await UserCollection.create({
  db: { type: 'sqlite', url: 'app.db' }
});
const tenants = await TenantCollection.create(options);
const roles = await RoleCollection.create(options);
const memberships = await MembershipCollection.create(options);

// Seed system roles
await roles.seedSystemRoles();

// Create a user and tenant
const user = await users.create({ email: 'user@example.com' });
await user.save();

const tenant = await tenants.create({ name: 'My Company' });
await tenant.save();

// Add user to tenant with admin role
const adminRole = await roles.findBySlug('admin');
const membership = await memberships.create({
  userId: user.id,
  tenantId: tenant.id,
  roleId: adminRole.id,
});
await membership.save();

// Check permissions
const resolver = await PermissionResolver.create(options);
const hasAccess = await resolver.hasPermission(
  user.id,
  tenant.id,
  'users.manage'
);
```

## Permission Resolution

Permissions are resolved in the following order:

1. Base permissions from user's role in the tenant
2. Additional permissions from group roles
3. Membership overrides (DENY takes precedence over GRANT)

```typescript
const result = await resolver.resolvePermissions(userId, tenantId);
console.log(result.permissions);  // Set<string> of permission slugs
console.log(result.roleId);       // User's role ID
console.log(result.groupIds);     // Groups contributing permissions
```

## Documentation

See [CLAUDE.md](./CLAUDE.md) for detailed documentation and examples.

## License

MIT
