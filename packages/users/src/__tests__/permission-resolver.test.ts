/**
 * PermissionResolver Tests
 *
 * Tests for multi-tenant user management and permission resolution:
 * 1. Basic entity CRUD (User, Tenant, Role, Permission)
 * 2. Membership assignment and role inheritance
 * 3. Group membership and group roles
 * 4. Permission overrides (grant/deny)
 * 5. Full permission resolution algorithm
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GroupCollection } from '../collections/GroupCollection.js';
import { GroupMemberCollection } from '../collections/GroupMemberCollection.js';
import { GroupRoleCollection } from '../collections/GroupRoleCollection.js';
import { MembershipCollection } from '../collections/MembershipCollection.js';
import { MembershipOverrideCollection } from '../collections/MembershipOverrideCollection.js';
import { PermissionCollection } from '../collections/PermissionCollection.js';
import { RoleCollection } from '../collections/RoleCollection.js';
import { RolePermissionCollection } from '../collections/RolePermissionCollection.js';
import { TenantCollection } from '../collections/TenantCollection.js';
import { TenantPermissionOverrideCollection } from '../collections/TenantPermissionOverrideCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import { PermissionResolver } from '../services/PermissionResolver.js';
import { MembershipStatus, UserStatus } from '../types/index.js';

describe('User', () => {
  let dbPath: string;
  let users: UserCollection;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-user-test-${Date.now()}.db`);
    users = await UserCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch (err) {
        console.warn(`Test cleanup warning: failed to remove ${dbPath}:`, err);
      }
    }
  });

  it('should create a user', async () => {
    const user = await users.create({
      email: 'test@example.com',
      profileId: 'profile-123',
    });

    expect(user.id).toBeDefined();
    expect(user.email).toBe('test@example.com');
    expect(user.profileId).toBe('profile-123');
    expect(user.status).toBe(UserStatus.ACTIVE);
  });

  it('should preserve data through save/load cycle', async () => {
    const user = await users.create({
      email: 'persist@example.com',
      profileId: 'profile-456',
    });
    await user.save();

    const loaded = await users.get({ id: user.id });
    expect(loaded).toBeDefined();
    expect(loaded?.email).toBe('persist@example.com');
    expect(loaded?.profileId).toBe('profile-456');
  });

  it('should find user by email', async () => {
    await (
      await users.create({
        email: 'find@example.com',
        profileId: 'p1',
      })
    ).save();

    const found = await users.findByEmail('find@example.com');
    expect(found).toBeDefined();
    expect(found?.email).toBe('find@example.com');
  });

  it('should check if user is active', async () => {
    const active = await users.create({
      email: 'active@example.com',
      status: UserStatus.ACTIVE,
    });
    const suspended = await users.create({
      email: 'suspended@example.com',
      status: UserStatus.SUSPENDED,
    });

    expect(active.isActive()).toBe(true);
    expect(suspended.isActive()).toBe(false);
  });
});

describe('Tenant', () => {
  let dbPath: string;
  let tenants: TenantCollection;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-tenant-test-${Date.now()}.db`);
    tenants = await TenantCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
  });

  afterEach(() => {
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch (err) {
        console.warn(`Test cleanup warning: failed to remove ${dbPath}:`, err);
      }
    }
  });

  it('should create a tenant', async () => {
    const tenant = await tenants.create({
      name: 'Test Company',
    });

    expect(tenant.id).toBeDefined();
    expect(tenant.name).toBe('Test Company');
  });

  it('should preserve data through save/load cycle', async () => {
    const tenant = await tenants.create({
      name: 'Persist Company',
    });
    await tenant.save();

    const loaded = await tenants.get({ id: tenant.id });
    expect(loaded).toBeDefined();
    expect(loaded?.name).toBe('Persist Company');
  });
});

describe('Role and Permission', () => {
  let dbPath: string;
  let roles: RoleCollection;
  let permissions: PermissionCollection;
  let rolePermissions: RolePermissionCollection;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-role-test-${Date.now()}.db`);
    roles = await RoleCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    permissions = await PermissionCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    rolePermissions = await RolePermissionCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
  });

  afterEach(() => {
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch (err) {
        console.warn(`Test cleanup warning: failed to remove ${dbPath}:`, err);
      }
    }
  });

  it('should create system roles', async () => {
    const systemRole = await roles.create({
      name: 'Administrator',
      isSystem: true,
      tenantId: null,
    });

    expect(systemRole.isSystemRole()).toBe(true);
    expect(systemRole.isTenantRole()).toBe(false);
  });

  it('should seed default system roles', async () => {
    const seeded = await roles.seedSystemRoles();
    expect(seeded.length).toBeGreaterThanOrEqual(4);

    const owner = await roles.findBySlug('owner');
    expect(owner).toBeDefined();
    expect(owner?.isSystem).toBe(true);
  });

  it('seeds roles as exact-tenant only unless inheritsToDescendants opts them in', async () => {
    // Default: no role inherits down the tenant hierarchy.
    await roles.seedSystemRoles();
    for (const slug of ['owner', 'admin', 'member', 'viewer']) {
      const role = await roles.findBySlug(slug);
      expect(role?.inheritsToDescendants).toBe(false);
    }

    // Re-seeding with the opt-in list flags existing roles additively.
    await roles.seedSystemRoles({ inheritsToDescendants: ['owner', 'admin'] });
    expect((await roles.findBySlug('owner'))?.inheritsToDescendants).toBe(true);
    expect((await roles.findBySlug('admin'))?.inheritsToDescendants).toBe(true);
    expect((await roles.findBySlug('member'))?.inheritsToDescendants).toBe(
      false,
    );
    expect((await roles.findBySlug('viewer'))?.inheritsToDescendants).toBe(
      false,
    );

    // Omitting a previously flagged slug never unsets it (additive-only).
    await roles.seedSystemRoles({ inheritsToDescendants: [] });
    expect((await roles.findBySlug('owner'))?.inheritsToDescendants).toBe(true);
    expect((await roles.findBySlug('admin'))?.inheritsToDescendants).toBe(true);
  });

  it('seeds fresh roles with the inheritsToDescendants flag applied', async () => {
    await roles.seedSystemRoles({ inheritsToDescendants: ['owner'] });
    expect((await roles.findBySlug('owner'))?.inheritsToDescendants).toBe(true);
    expect((await roles.findBySlug('admin'))?.inheritsToDescendants).toBe(
      false,
    );
  });

  it('rejects unknown slugs in inheritsToDescendants', async () => {
    await expect(
      roles.seedSystemRoles({ inheritsToDescendants: ['amdin'] }),
    ).rejects.toThrow(/Unknown system role slug 'amdin'/);
  });

  it('should assign permission to role', async () => {
    const role = await roles.create({ name: 'Editor' });
    await role.save();

    const perm = await permissions.create({
      slug: 'articles.create',
      name: 'Create Articles',
    });
    await perm.save();

    await rolePermissions.addPermission(role.id!, perm.id!);

    const permIds = await rolePermissions.getPermissionIds(role.id!);
    expect(permIds).toContain(perm.id);
  });
});

describe('Membership', () => {
  let dbPath: string;
  let users: UserCollection;
  let tenants: TenantCollection;
  let roles: RoleCollection;
  let memberships: MembershipCollection;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-membership-test-${Date.now()}.db`);
    users = await UserCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    tenants = await TenantCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    roles = await RoleCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    memberships = await MembershipCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
  });

  afterEach(() => {
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch (err) {
        console.warn(`Test cleanup warning: failed to remove ${dbPath}:`, err);
      }
    }
  });

  it('should create a membership', async () => {
    const user = await users.create({ email: 'member@example.com' });
    await user.save();

    const tenant = await tenants.create({ name: 'Test Org' });
    await tenant.save();

    const role = await roles.create({ name: 'Member' });
    await role.save();

    const membership = await memberships.create({
      userId: user.id,
      tenantId: tenant.id,
      roleId: role.id,
    });
    await membership.save();

    expect(membership.isActive()).toBe(true);
  });

  it('should find membership by user and tenant', async () => {
    const user = await users.create({ email: 'find@example.com' });
    await user.save();

    const tenant = await tenants.create({ name: 'Find Org' });
    await tenant.save();

    const role = await roles.create({ name: 'Viewer' });
    await role.save();

    const membership = await memberships.create({
      userId: user.id,
      tenantId: tenant.id,
      roleId: role.id,
    });
    await membership.save();

    const found = await memberships.findByUserAndTenant(user.id!, tenant.id!);
    expect(found).toBeDefined();
    expect(found?.id).toBe(membership.id);
  });
});

describe('Groups', () => {
  let dbPath: string;
  let users: UserCollection;
  let tenants: TenantCollection;
  let groups: GroupCollection;
  let groupMembers: GroupMemberCollection;
  let roles: RoleCollection;
  let groupRoles: GroupRoleCollection;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-group-test-${Date.now()}.db`);
    users = await UserCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    tenants = await TenantCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    groups = await GroupCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    groupMembers = await GroupMemberCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    roles = await RoleCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    groupRoles = await GroupRoleCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
  });

  afterEach(() => {
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch (err) {
        console.warn(`Test cleanup warning: failed to remove ${dbPath}:`, err);
      }
    }
  });

  it('should create a group', async () => {
    const tenant = await tenants.create({ name: 'Group Org' });
    await tenant.save();

    const group = await groups.create({
      tenantId: tenant.id,
      name: 'Editorial Team',
      description: 'Content editors',
    });
    await group.save();

    expect(group.id).toBeDefined();
    expect(group.name).toBe('Editorial Team');
  });

  it('should add user to group', async () => {
    const tenant = await tenants.create({ name: 'Member Org' });
    await tenant.save();

    const user = await users.create({ email: 'groupmember@example.com' });
    await user.save();

    const group = await groups.create({
      tenantId: tenant.id,
      name: 'Test Group',
    });
    await group.save();

    await groupMembers.addMember(group.id!, user.id!);

    const isMember = await groupMembers.isMember(group.id!, user.id!);
    expect(isMember).toBe(true);
  });

  it('should assign role to group', async () => {
    const tenant = await tenants.create({ name: 'Role Org' });
    await tenant.save();

    const group = await groups.create({
      tenantId: tenant.id,
      name: 'Admin Group',
    });
    await group.save();

    const role = await roles.create({ name: 'Admin Role' });
    await role.save();

    await groupRoles.addRole(group.id!, role.id!);

    const hasRole = await groupRoles.hasRole(group.id!, role.id!);
    expect(hasRole).toBe(true);
  });

  it('resolves tenant-scoped group ids via the registry-resolved Group table', async () => {
    // getGroupIdsForTenant joins group_members to the Group table. The join
    // target is resolved from the registry (not a hardcoded `groups` literal),
    // so this exercises that the resolved table name is correct and the
    // tenant filter still scopes results.
    const tenantA = await tenants.create({ name: 'Tenant A' });
    await tenantA.save();
    const tenantB = await tenants.create({ name: 'Tenant B' });
    await tenantB.save();

    const user = await users.create({ email: 'multi-tenant@example.com' });
    await user.save();

    const groupA = await groups.create({
      tenantId: tenantA.id,
      name: 'A Team',
    });
    await groupA.save();
    const groupB = await groups.create({
      tenantId: tenantB.id,
      name: 'B Team',
    });
    await groupB.save();

    await groupMembers.addMember(groupA.id!, user.id!);
    await groupMembers.addMember(groupB.id!, user.id!);

    const idsForA = await groupMembers.getGroupIdsForTenant(
      user.id!,
      tenantA.id!,
    );
    expect(idsForA).toEqual([groupA.id]);

    const idsForB = await groupMembers.getGroupIdsForTenant(
      user.id!,
      tenantB.id!,
    );
    expect(idsForB).toEqual([groupB.id]);
  });
});

describe('PermissionResolver', () => {
  let dbPath: string;
  let users: UserCollection;
  let tenants: TenantCollection;
  let roles: RoleCollection;
  let permissions: PermissionCollection;
  let memberships: MembershipCollection;
  let rolePermissions: RolePermissionCollection;
  let groups: GroupCollection;
  let groupMembers: GroupMemberCollection;
  let groupRoles: GroupRoleCollection;
  let membershipOverrides: MembershipOverrideCollection;
  let tenantOverrides: TenantPermissionOverrideCollection;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-resolver-test-${Date.now()}.db`);
    const options = { db: { type: 'sqlite' as const, url: dbPath } };

    users = await UserCollection.create(options);
    tenants = await TenantCollection.create(options);
    roles = await RoleCollection.create(options);
    permissions = await PermissionCollection.create(options);
    memberships = await MembershipCollection.create(options);
    rolePermissions = await RolePermissionCollection.create(options);
    groups = await GroupCollection.create(options);
    groupMembers = await GroupMemberCollection.create(options);
    groupRoles = await GroupRoleCollection.create(options);
    membershipOverrides = await MembershipOverrideCollection.create(options);
    tenantOverrides = await TenantPermissionOverrideCollection.create(options);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch (err) {
        console.warn(`Test cleanup warning: failed to remove ${dbPath}:`, err);
      }
    }
  });

  it('should resolve permissions from role', async () => {
    // Setup
    const user = await users.create({ email: 'resolver@example.com' });
    await user.save();

    const tenant = await tenants.create({ name: 'Resolver Org' });
    await tenant.save();

    const editorRole = await roles.create({ name: 'Editor' });
    await editorRole.save();

    const createPerm = await permissions.create({
      slug: 'articles.create',
      name: 'Create Articles',
    });
    await createPerm.save();

    const updatePerm = await permissions.create({
      slug: 'articles.update',
      name: 'Update Articles',
    });
    await updatePerm.save();

    // Assign permissions to role
    await rolePermissions.addPermission(editorRole.id!, createPerm.id!);
    await rolePermissions.addPermission(editorRole.id!, updatePerm.id!);

    // Create membership
    const membership = await memberships.create({
      userId: user.id,
      tenantId: tenant.id,
      roleId: editorRole.id,
    });
    await membership.save();

    // Resolve permissions
    const resolver = await PermissionResolver.create({
      db: { type: 'sqlite', url: dbPath },
    });
    const result = await resolver.resolvePermissions(user.id!, tenant.id!);

    expect(result.permissions.has('articles.create')).toBe(true);
    expect(result.permissions.has('articles.update')).toBe(true);
    expect(result.permissions.has('articles.delete')).toBe(false);
  });

  it('should reuse a provided membership instead of querying it again', async () => {
    const user = await users.create({ email: 'cached-member@example.com' });
    await user.save();

    const tenant = await tenants.create({ name: 'Cached Member Org' });
    await tenant.save();

    const role = await roles.create({ name: 'Cached Editor' });
    await role.save();

    const permission = await permissions.create({
      slug: 'articles.cache-read',
      name: 'Read Cached Articles',
    });
    await permission.save();

    const userId = user.id;
    const tenantId = tenant.id;
    const roleId = role.id;
    const permissionId = permission.id;
    if (!userId || !tenantId || !roleId || !permissionId) {
      throw new Error('Expected persisted test records to have ids.');
    }

    await rolePermissions.addPermission(roleId, permissionId);

    const membership = await memberships.create({
      userId,
      tenantId,
      roleId,
    });
    await membership.save();

    const resolver = await PermissionResolver.create({
      db: { type: 'sqlite', url: dbPath },
    });
    const lookupSpy = vi.spyOn(
      MembershipCollection.prototype,
      'findByUserAndTenant',
    );

    const result = await resolver.resolvePermissions(userId, tenantId, {
      membership,
    });

    expect(lookupSpy).not.toHaveBeenCalled();
    expect(result.membershipId).toBe(membership.id);
    expect(result.permissions.has('articles.cache-read')).toBe(true);
  });

  it('should inherit permissions from group roles', async () => {
    // Setup
    const user = await users.create({ email: 'groupuser@example.com' });
    await user.save();

    const tenant = await tenants.create({ name: 'Group Resolver Org' });
    await tenant.save();

    // Basic role with no permissions
    const basicRole = await roles.create({ name: 'Basic' });
    await basicRole.save();

    // Group role with extra permissions
    const groupRole = await roles.create({ name: 'Editor Group Role' });
    await groupRole.save();

    const groupPerm = await permissions.create({
      slug: 'special.access',
      name: 'Special Access',
    });
    await groupPerm.save();

    await rolePermissions.addPermission(groupRole.id!, groupPerm.id!);

    // Create membership with basic role
    const membership = await memberships.create({
      userId: user.id,
      tenantId: tenant.id,
      roleId: basicRole.id,
    });
    await membership.save();

    // Create group with extra role
    const group = await groups.create({
      tenantId: tenant.id,
      name: 'Special Group',
    });
    await group.save();

    await groupRoles.addRole(group.id!, groupRole.id!);
    await groupMembers.addMember(group.id!, user.id!);

    // Resolve permissions
    const resolver = await PermissionResolver.create({
      db: { type: 'sqlite', url: dbPath },
    });
    const result = await resolver.resolvePermissions(user.id!, tenant.id!);

    // Should have group permission even though base role doesn't have it
    expect(result.permissions.has('special.access')).toBe(true);
    expect(result.groupIds).toContain(group.id);
  });

  it('should apply GRANT overrides', async () => {
    // Setup
    const user = await users.create({ email: 'override@example.com' });
    await user.save();

    const tenant = await tenants.create({ name: 'Override Org' });
    await tenant.save();

    const basicRole = await roles.create({ name: 'Basic' });
    await basicRole.save();

    const extraPerm = await permissions.create({
      slug: 'admin.access',
      name: 'Admin Access',
    });
    await extraPerm.save();

    // Membership without admin permission
    const membership = await memberships.create({
      userId: user.id,
      tenantId: tenant.id,
      roleId: basicRole.id,
    });
    await membership.save();

    // Grant admin permission via override
    await membershipOverrides.grantPermission(membership.id!, extraPerm.id!);

    // Resolve permissions
    const resolver = await PermissionResolver.create({
      db: { type: 'sqlite', url: dbPath },
    });
    const result = await resolver.resolvePermissions(user.id!, tenant.id!);

    expect(result.permissions.has('admin.access')).toBe(true);
  });

  it('should apply DENY overrides (takes precedence)', async () => {
    // Setup
    const user = await users.create({ email: 'deny@example.com' });
    await user.save();

    const tenant = await tenants.create({ name: 'Deny Org' });
    await tenant.save();

    const adminRole = await roles.create({ name: 'Admin' });
    await adminRole.save();

    const deletePerm = await permissions.create({
      slug: 'articles.delete',
      name: 'Delete Articles',
    });
    await deletePerm.save();

    // Admin role has delete permission
    await rolePermissions.addPermission(adminRole.id!, deletePerm.id!);

    // Membership with admin role
    const membership = await memberships.create({
      userId: user.id,
      tenantId: tenant.id,
      roleId: adminRole.id,
    });
    await membership.save();

    // DENY the delete permission for this specific user
    await membershipOverrides.denyPermission(membership.id!, deletePerm.id!);

    // Resolve permissions
    const resolver = await PermissionResolver.create({
      db: { type: 'sqlite', url: dbPath },
    });
    const result = await resolver.resolvePermissions(user.id!, tenant.id!);

    // Should NOT have delete permission due to DENY override
    expect(result.permissions.has('articles.delete')).toBe(false);
    expect(result.deniedPermissionIds).toContain(deletePerm.id);
  });

  it('should merge inherited tenant permissions before membership denies', async () => {
    const parent = await tenants.create({
      cascadePermissions: true,
      name: 'Parent Org',
    });
    await parent.save();

    const child = await tenants.create({
      inheritPermissions: true,
      name: 'Child Org',
      parentTenantId: parent.id!,
    });
    await child.save();

    const user = await users.create({ email: 'tenant-inherit@example.com' });
    await user.save();

    const role = await roles.create({ name: 'Editor' });
    await role.save();

    const inheritedPermission = await permissions.create({
      slug: 'articles.read',
      name: 'Read Articles',
    });
    await inheritedPermission.save();

    const rolePermission = await permissions.create({
      slug: 'articles.create',
      name: 'Create Articles',
    });
    await rolePermission.save();

    await tenantOverrides.grantPermission(parent.id!, inheritedPermission.id!);
    await rolePermissions.addPermission(role.id!, rolePermission.id!);

    const membership = await memberships.create({
      roleId: role.id!,
      tenantId: child.id!,
      userId: user.id!,
    });
    await membership.save();

    await membershipOverrides.denyPermission(
      membership.id!,
      inheritedPermission.id!,
    );

    const resolver = await PermissionResolver.create({
      db: { type: 'sqlite', url: dbPath },
    });
    const result = await resolver.resolvePermissions(user.id!, child.id!);

    expect(result.permissions.has('articles.create')).toBe(true);
    expect(result.permissions.has('articles.read')).toBe(false);
    expect(result.deniedPermissionIds).toContain(inheritedPermission.id);
  });

  it('tenant-level DENY removes a permission the role grants', async () => {
    // NEW behavior: a tenant-DENY is a hard, tenant-wide block that overrides
    // role/group grants — not just the inherited cascade. This case fails on
    // the pre-change resolver, which only let tenant-DENY shrink inheritance.
    const user = await users.create({ email: 'tenant-deny-role@example.com' });
    await user.save();

    const tenant = await tenants.create({ name: 'Tenant Deny Role Org' });
    await tenant.save();

    const role = await roles.create({ name: 'Admin' });
    await role.save();

    const deletePerm = await permissions.create({
      slug: 'articles.delete',
      name: 'Delete Articles',
    });
    await deletePerm.save();

    // Role grants delete...
    await rolePermissions.addPermission(role.id!, deletePerm.id!);

    const membership = await memberships.create({
      userId: user.id,
      tenantId: tenant.id,
      roleId: role.id,
    });
    await membership.save();

    // ...but the tenant DENYs it for everyone.
    await tenantOverrides.denyPermission(tenant.id!, deletePerm.id!);

    const resolver = await PermissionResolver.create({
      db: { type: 'sqlite', url: dbPath },
    });
    const result = await resolver.resolvePermissions(user.id!, tenant.id!);

    expect(result.permissions.has('articles.delete')).toBe(false);
  });

  it('tenant-level DENY removes a permission a group role grants', async () => {
    // Same hard tenant-wide block, but the grant comes from a group role rather
    // than the membership role.
    const user = await users.create({ email: 'tenant-deny-group@example.com' });
    await user.save();

    const tenant = await tenants.create({ name: 'Tenant Deny Group Org' });
    await tenant.save();

    const baseRole = await roles.create({ name: 'Basic' });
    await baseRole.save();

    const groupRole = await roles.create({ name: 'Special Group Role' });
    await groupRole.save();

    const groupPerm = await permissions.create({
      slug: 'special.access',
      name: 'Special Access',
    });
    await groupPerm.save();

    await rolePermissions.addPermission(groupRole.id!, groupPerm.id!);

    const membership = await memberships.create({
      userId: user.id,
      tenantId: tenant.id,
      roleId: baseRole.id,
    });
    await membership.save();

    const group = await groups.create({
      tenantId: tenant.id,
      name: 'Special Group',
    });
    await group.save();

    await groupRoles.addRole(group.id!, groupRole.id!);
    await groupMembers.addMember(group.id!, user.id!);

    // Tenant DENYs the group-granted permission.
    await tenantOverrides.denyPermission(tenant.id!, groupPerm.id!);

    const resolver = await PermissionResolver.create({
      db: { type: 'sqlite', url: dbPath },
    });
    const result = await resolver.resolvePermissions(user.id!, tenant.id!);

    expect(result.permissions.has('special.access')).toBe(false);
  });

  it("membership GRANT override re-adds a tenant-DENY'd permission (most specific wins)", async () => {
    // Precedence: tenant-DENY sits ABOVE role/group but BELOW the most-specific
    // membership overrides, so a membership GRANT can re-add a tenant-DENY'd slug.
    const user = await users.create({
      email: 'tenant-deny-regrant@example.com',
    });
    await user.save();

    const tenant = await tenants.create({ name: 'Tenant Deny Regrant Org' });
    await tenant.save();

    const role = await roles.create({ name: 'Editor' });
    await role.save();

    const perm = await permissions.create({
      slug: 'articles.publish',
      name: 'Publish Articles',
    });
    await perm.save();

    await rolePermissions.addPermission(role.id!, perm.id!);

    const membership = await memberships.create({
      userId: user.id,
      tenantId: tenant.id,
      roleId: role.id,
    });
    await membership.save();

    // Tenant DENYs it, but this user gets a more-specific membership GRANT.
    await tenantOverrides.denyPermission(tenant.id!, perm.id!);
    await membershipOverrides.grantPermission(membership.id!, perm.id!);

    const resolver = await PermissionResolver.create({
      db: { type: 'sqlite', url: dbPath },
    });
    const result = await resolver.resolvePermissions(user.id!, tenant.id!);

    expect(result.permissions.has('articles.publish')).toBe(true);
  });

  it('membership DENY stays absolute even with a tenant-DENY and role grant', async () => {
    // A membership DENY is the final, most-specific layer and always wins —
    // even alongside a tenant-DENY of the same slug.
    const user = await users.create({
      email: 'tenant-deny-absolute@example.com',
    });
    await user.save();

    const tenant = await tenants.create({ name: 'Tenant Deny Absolute Org' });
    await tenant.save();

    const role = await roles.create({ name: 'Admin' });
    await role.save();

    const perm = await permissions.create({
      slug: 'articles.destroy',
      name: 'Destroy Articles',
    });
    await perm.save();

    await rolePermissions.addPermission(role.id!, perm.id!);

    const membership = await memberships.create({
      userId: user.id,
      tenantId: tenant.id,
      roleId: role.id,
    });
    await membership.save();

    await tenantOverrides.denyPermission(tenant.id!, perm.id!);
    await membershipOverrides.denyPermission(membership.id!, perm.id!);

    const resolver = await PermissionResolver.create({
      db: { type: 'sqlite', url: dbPath },
    });
    const result = await resolver.resolvePermissions(user.id!, tenant.id!);

    expect(result.permissions.has('articles.destroy')).toBe(false);
    expect(result.deniedPermissionIds).toContain(perm.id);
  });

  it('tenant-DENY still blocks an inherited cascade grant (existing behavior)', async () => {
    // Regression guard for the original tenant-DENY semantics: a permission
    // granted by a parent tenant and cascaded down is still removed when the
    // child tenant DENYs it — even for a member with a role.
    const parent = await tenants.create({
      cascadePermissions: true,
      name: 'Cascade Parent Org',
    });
    await parent.save();

    const child = await tenants.create({
      inheritPermissions: true,
      name: 'Cascade Child Org',
      parentTenantId: parent.id!,
    });
    await child.save();

    const user = await users.create({
      email: 'tenant-deny-cascade@example.com',
    });
    await user.save();

    const role = await roles.create({ name: 'Member' });
    await role.save();

    const inheritedPerm = await permissions.create({
      slug: 'reports.view',
      name: 'View Reports',
    });
    await inheritedPerm.save();

    // Parent grants + cascades; child DENYs.
    await tenantOverrides.grantPermission(parent.id!, inheritedPerm.id!);
    await tenantOverrides.denyPermission(child.id!, inheritedPerm.id!);

    const membership = await memberships.create({
      userId: user.id,
      tenantId: child.id,
      roleId: role.id,
    });
    await membership.save();

    const resolver = await PermissionResolver.create({
      db: { type: 'sqlite', url: dbPath },
    });
    const result = await resolver.resolvePermissions(user.id!, child.id!);

    expect(result.permissions.has('reports.view')).toBe(false);
  });

  it('child-tenant GRANT overrides a parent-tenant DENY (most-specific tenant wins)', async () => {
    // Netting guard for the hard tenant-wide DENY block: a parent tenant DENYs a
    // permission org-wide but a child sub-tenant explicitly re-GRANTs it. The
    // child GRANT is more specific and must win — the parent DENY must NOT be
    // applied as a hard block over the child's own grant. Pre-netting-fix the
    // unconditionally-collected parent DENY wrongly stripped it.
    const parent = await tenants.create({
      cascadePermissions: true,
      name: 'Deny Parent Org',
    });
    await parent.save();

    const child = await tenants.create({
      inheritPermissions: true,
      name: 'Grant Child Org',
      parentTenantId: parent.id!,
    });
    await child.save();

    const user = await users.create({
      email: 'parent-deny-child-grant@example.com',
    });
    await user.save();

    const role = await roles.create({ name: 'Member' });
    await role.save();

    const perm = await permissions.create({
      slug: 'reports.export',
      name: 'Export Reports',
    });
    await perm.save();

    // Parent DENYs (and cascades); child re-GRANTs.
    await tenantOverrides.denyPermission(parent.id!, perm.id!);
    await tenantOverrides.grantPermission(child.id!, perm.id!);

    const membership = await memberships.create({
      userId: user.id,
      tenantId: child.id,
      roleId: role.id,
    });
    await membership.save();

    const resolver = await PermissionResolver.create({
      db: { type: 'sqlite', url: dbPath },
    });
    const result = await resolver.resolvePermissions(user.id!, child.id!);

    expect(result.permissions.has('reports.export')).toBe(true);
  });

  it('should return empty permissions for non-member', async () => {
    const user = await users.create({ email: 'nonmember@example.com' });
    await user.save();

    const tenant = await tenants.create({ name: 'No Member Org' });
    await tenant.save();

    // No membership created

    const resolver = await PermissionResolver.create({
      db: { type: 'sqlite', url: dbPath },
    });
    const result = await resolver.resolvePermissions(user.id!, tenant.id!);

    expect(result.permissions.size).toBe(0);
    expect(result.membershipId).toBeNull();
    expect(result.roleId).toBeNull();
  });

  it('should not inherit tenant permissions without an active membership', async () => {
    const user = await users.create({ email: 'tenant-nonmember@example.com' });
    await user.save();

    const parent = await tenants.create({
      cascadePermissions: true,
      name: 'Parent Org',
    });
    await parent.save();

    const child = await tenants.create({
      inheritPermissions: true,
      name: 'Child Org',
      parentTenantId: parent.id!,
    });
    await child.save();

    const inheritedPermission = await permissions.create({
      slug: 'articles.read',
      name: 'Read Articles',
    });
    await inheritedPermission.save();

    await tenantOverrides.grantPermission(parent.id!, inheritedPermission.id!);

    const resolver = await PermissionResolver.create({
      db: { type: 'sqlite', url: dbPath },
    });
    const result = await resolver.resolvePermissions(user.id!, child.id!);

    expect(result.permissions.size).toBe(0);
    expect(result.permissions.has('articles.read')).toBe(false);
    expect(result.membershipId).toBeNull();
  });

  it('should check hasPermission convenience method', async () => {
    const user = await users.create({ email: 'hasperm@example.com' });
    await user.save();

    const tenant = await tenants.create({ name: 'HasPerm Org' });
    await tenant.save();

    const role = await roles.create({ name: 'Writer' });
    await role.save();

    const writePerm = await permissions.create({
      slug: 'articles.write',
      name: 'Write Articles',
    });
    await writePerm.save();

    await rolePermissions.addPermission(role.id!, writePerm.id!);

    const membership = await memberships.create({
      userId: user.id,
      tenantId: tenant.id,
      roleId: role.id,
    });
    await membership.save();

    const resolver = await PermissionResolver.create({
      db: { type: 'sqlite', url: dbPath },
    });

    expect(
      await resolver.hasPermission(user.id!, tenant.id!, 'articles.write'),
    ).toBe(true);
    expect(
      await resolver.hasPermission(user.id!, tenant.id!, 'articles.delete'),
    ).toBe(false);
  });

  it('should check hasAllPermissions', async () => {
    const user = await users.create({ email: 'hasall@example.com' });
    await user.save();

    const tenant = await tenants.create({ name: 'HasAll Org' });
    await tenant.save();

    const role = await roles.create({ name: 'FullEditor' });
    await role.save();

    const p1 = await permissions.create({ slug: 'perm.a', name: 'A' });
    await p1.save();
    const p2 = await permissions.create({ slug: 'perm.b', name: 'B' });
    await p2.save();

    await rolePermissions.addPermission(role.id!, p1.id!);
    await rolePermissions.addPermission(role.id!, p2.id!);

    const membership = await memberships.create({
      userId: user.id,
      tenantId: tenant.id,
      roleId: role.id,
    });
    await membership.save();

    const resolver = await PermissionResolver.create({
      db: { type: 'sqlite', url: dbPath },
    });

    expect(
      await resolver.hasAllPermissions(user.id!, tenant.id!, [
        'perm.a',
        'perm.b',
      ]),
    ).toBe(true);
    expect(
      await resolver.hasAllPermissions(user.id!, tenant.id!, [
        'perm.a',
        'perm.c',
      ]),
    ).toBe(false);
  });

  it('should check hasAnyPermission', async () => {
    const user = await users.create({ email: 'hasany@example.com' });
    await user.save();

    const tenant = await tenants.create({ name: 'HasAny Org' });
    await tenant.save();

    const role = await roles.create({ name: 'Limited' });
    await role.save();

    const p1 = await permissions.create({
      slug: 'only.this',
      name: 'Only This',
    });
    await p1.save();

    await rolePermissions.addPermission(role.id!, p1.id!);

    const membership = await memberships.create({
      userId: user.id,
      tenantId: tenant.id,
      roleId: role.id,
    });
    await membership.save();

    const resolver = await PermissionResolver.create({
      db: { type: 'sqlite', url: dbPath },
    });

    expect(
      await resolver.hasAnyPermission(user.id!, tenant.id!, [
        'only.this',
        'other',
      ]),
    ).toBe(true);
    expect(
      await resolver.hasAnyPermission(user.id!, tenant.id!, [
        'other',
        'another',
      ]),
    ).toBe(false);
  });
});

describe('PermissionResolver hierarchical membership inheritance (#1866)', () => {
  let dbPath: string;
  let users: UserCollection;
  let tenants: TenantCollection;
  let roles: RoleCollection;
  let permissions: PermissionCollection;
  let memberships: MembershipCollection;
  let rolePermissions: RolePermissionCollection;
  let groups: GroupCollection;
  let groupMembers: GroupMemberCollection;
  let groupRoles: GroupRoleCollection;
  let membershipOverrides: MembershipOverrideCollection;
  let tenantOverrides: TenantPermissionOverrideCollection;
  let resolver: PermissionResolver;

  beforeEach(async () => {
    dbPath = join(
      tmpdir(),
      `smrt-inherit-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    const options = { db: { type: 'sqlite' as const, url: dbPath } };

    users = await UserCollection.create(options);
    tenants = await TenantCollection.create(options);
    roles = await RoleCollection.create(options);
    permissions = await PermissionCollection.create(options);
    memberships = await MembershipCollection.create(options);
    rolePermissions = await RolePermissionCollection.create(options);
    groups = await GroupCollection.create(options);
    groupMembers = await GroupMemberCollection.create(options);
    groupRoles = await GroupRoleCollection.create(options);
    membershipOverrides = await MembershipOverrideCollection.create(options);
    tenantOverrides = await TenantPermissionOverrideCollection.create(options);
    resolver = await PermissionResolver.create(options);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch (err) {
        console.warn(`Test cleanup warning: failed to remove ${dbPath}:`, err);
      }
    }
  });

  /** root -> child -> grandchild tenant chain. */
  async function createTenantChain() {
    const root = await tenants.create({ name: 'Network Root' });
    await root.save();
    const child = await tenants.createChild(root.id!, { name: 'Child Org' });
    const grandchild = await tenants.createChild(child.id!, {
      name: 'Grandchild Org',
    });
    return { root, child, grandchild };
  }

  /** A role granting the given permission slugs (created on the fly). */
  async function createRoleGranting(
    name: string,
    slugs: string[],
    roleOptions: { inheritsToDescendants?: boolean } = {},
  ) {
    const role = await roles.create({
      name,
      inheritsToDescendants: roleOptions.inheritsToDescendants ?? false,
    });
    await role.save();
    for (const slug of slugs) {
      let permission = await permissions.list({ where: { slug }, limit: 1 });
      let permissionRecord = permission[0];
      if (!permissionRecord) {
        permissionRecord = await permissions.create({ slug, name: slug });
        await permissionRecord.save();
      }
      await rolePermissions.addPermission(role.id!, permissionRecord.id!);
    }
    return role;
  }

  async function createMember(tenantId: string, roleId: string, email: string) {
    const user = await users.create({ email });
    await user.save();
    const membership = await memberships.create({
      userId: user.id,
      tenantId,
      roleId,
    });
    await membership.save();
    return { user, membership };
  }

  it('resolves a flagged root membership in a grandchild tenant (nearest-ancestor inheritance)', async () => {
    const { root, child, grandchild } = await createTenantChain();
    const adminRole = await createRoleGranting(
      'Network Admin',
      ['articles.update'],
      { inheritsToDescendants: true },
    );
    const { user, membership } = await createMember(
      root.id!,
      adminRole.id!,
      'network-admin@example.com',
    );

    const grandchildResult = await resolver.resolvePermissions(
      user.id!,
      grandchild.id!,
    );
    expect(grandchildResult.permissions.has('articles.update')).toBe(true);
    expect(grandchildResult.inheritedFromTenantId).toBe(root.id);
    expect(grandchildResult.membershipId).toBe(membership.id);
    expect(grandchildResult.roleId).toBe(adminRole.id);

    const childResult = await resolver.resolvePermissions(user.id!, child.id!);
    expect(childResult.permissions.has('articles.update')).toBe(true);
    expect(childResult.inheritedFromTenantId).toBe(root.id);

    // hasPermission delegates to the same resolution path.
    expect(
      await resolver.hasPermission(user.id!, grandchild.id!, 'articles.update'),
    ).toBe(true);
  });

  it('does not inherit when the ancestor role is unflagged (regression: exact-tenant only)', async () => {
    const { root, grandchild } = await createTenantChain();
    const unflaggedAdmin = await createRoleGranting(
      'Unflagged Admin',
      ['articles.update'],
      { inheritsToDescendants: false },
    );
    const { user } = await createMember(
      root.id!,
      unflaggedAdmin.id!,
      'plain-admin@example.com',
    );

    const result = await resolver.resolvePermissions(user.id!, grandchild.id!);
    expect(result.permissions.size).toBe(0);
    expect(result.membershipId).toBeNull();
    expect(result.inheritedFromTenantId).toBeNull();
  });

  it('resolves empty for a user with no memberships anywhere', async () => {
    const { grandchild } = await createTenantChain();
    const user = await users.create({ email: 'nobody@example.com' });
    await user.save();

    const result = await resolver.resolvePermissions(user.id!, grandchild.id!);
    expect(result.permissions.size).toBe(0);
    expect(result.inheritedFromTenantId).toBeNull();
  });

  it('child tenant-level DENY subtracts an inherited role grant', async () => {
    const { root, child } = await createTenantChain();
    const adminRole = await createRoleGranting(
      'Network Admin',
      ['articles.update', 'articles.delete'],
      { inheritsToDescendants: true },
    );
    const { user } = await createMember(
      root.id!,
      adminRole.id!,
      'denied-in-child@example.com',
    );

    const deletePerm = (
      await permissions.list({ where: { slug: 'articles.delete' }, limit: 1 })
    )[0];
    await tenantOverrides.denyPermission(child.id!, deletePerm.id!);

    const result = await resolver.resolvePermissions(user.id!, child.id!);
    expect(result.permissions.has('articles.update')).toBe(true);
    expect(result.permissions.has('articles.delete')).toBe(false);
    expect(result.inheritedFromTenantId).toBe(root.id);
  });

  it('membership DENY override on the ancestor membership stays absolute', async () => {
    const { root, child } = await createTenantChain();
    const adminRole = await createRoleGranting(
      'Network Admin',
      ['articles.update'],
      { inheritsToDescendants: true },
    );
    const { user, membership } = await createMember(
      root.id!,
      adminRole.id!,
      'override-deny@example.com',
    );

    const updatePerm = (
      await permissions.list({ where: { slug: 'articles.update' }, limit: 1 })
    )[0];
    await membershipOverrides.denyPermission(membership.id!, updatePerm.id!);

    const result = await resolver.resolvePermissions(user.id!, child.id!);
    expect(result.permissions.has('articles.update')).toBe(false);
    expect(result.deniedPermissionIds).toContain(updatePerm.id);
  });

  it('membership GRANT override travels with the ancestor membership', async () => {
    const { root, child } = await createTenantChain();
    const adminRole = await createRoleGranting('Network Admin', [], {
      inheritsToDescendants: true,
    });
    const { user, membership } = await createMember(
      root.id!,
      adminRole.id!,
      'override-grant@example.com',
    );

    const extraPerm = await permissions.create({
      slug: 'special.grant',
      name: 'Special Grant',
    });
    await extraPerm.save();
    await membershipOverrides.grantPermission(membership.id!, extraPerm.id!);

    const result = await resolver.resolvePermissions(user.id!, child.id!);
    expect(result.permissions.has('special.grant')).toBe(true);
    expect(result.inheritedFromTenantId).toBe(root.id);
  });

  it('a direct membership in the child attenuates: the lesser direct role wins over inheritance', async () => {
    const { root, child } = await createTenantChain();
    const adminRole = await createRoleGranting(
      'Network Admin',
      ['articles.update', 'articles.delete'],
      { inheritsToDescendants: true },
    );
    const viewerRole = await createRoleGranting('Viewer', ['articles.read']);

    const { user } = await createMember(
      root.id!,
      adminRole.id!,
      'attenuated@example.com',
    );
    const childMembership = await memberships.create({
      userId: user.id,
      tenantId: child.id,
      roleId: viewerRole.id,
    });
    await childMembership.save();

    const result = await resolver.resolvePermissions(user.id!, child.id!);
    expect(result.permissions.has('articles.read')).toBe(true);
    expect(result.permissions.has('articles.update')).toBe(false);
    expect(result.permissions.has('articles.delete')).toBe(false);
    expect(result.membershipId).toBe(childMembership.id);
    expect(result.inheritedFromTenantId).toBeNull();
  });

  it('an inactive direct membership pins resolution to the empty set (no inheritance bypass)', async () => {
    const { root, child } = await createTenantChain();
    const adminRole = await createRoleGranting(
      'Network Admin',
      ['articles.update'],
      { inheritsToDescendants: true },
    );
    const { user } = await createMember(
      root.id!,
      adminRole.id!,
      'suspended-in-child@example.com',
    );

    const suspended = await memberships.create({
      userId: user.id,
      tenantId: child.id,
      roleId: adminRole.id,
      status: MembershipStatus.INACTIVE,
    });
    await suspended.save();

    const result = await resolver.resolvePermissions(user.id!, child.id!);
    expect(result.permissions.size).toBe(0);
    expect(result.membershipId).toBeNull();
    expect(result.inheritedFromTenantId).toBeNull();
  });

  it('skips an active unflagged intermediate membership and resolves through a higher flagged one', async () => {
    const { root, child, grandchild } = await createTenantChain();
    const adminRole = await createRoleGranting(
      'Network Admin',
      ['articles.update'],
      { inheritsToDescendants: true },
    );
    const memberRole = await createRoleGranting('Member', ['articles.read']);

    const { user } = await createMember(
      root.id!,
      adminRole.id!,
      'skip-mid@example.com',
    );
    const midMembership = await memberships.create({
      userId: user.id,
      tenantId: child.id,
      roleId: memberRole.id,
    });
    await midMembership.save();

    const result = await resolver.resolvePermissions(user.id!, grandchild.id!);
    expect(result.permissions.has('articles.update')).toBe(true);
    // Only the flagged ancestor role resolves; the unflagged mid role's grants
    // do not union in.
    expect(result.permissions.has('articles.read')).toBe(false);
    expect(result.inheritedFromTenantId).toBe(root.id);
  });

  it('the nearest flagged ancestor membership wins (no union across the chain)', async () => {
    const { root, child, grandchild } = await createTenantChain();
    const adminRole = await createRoleGranting(
      'Network Admin',
      ['articles.delete'],
      { inheritsToDescendants: true },
    );
    const editorRole = await createRoleGranting(
      'Regional Editor',
      ['articles.update'],
      { inheritsToDescendants: true },
    );

    const { user } = await createMember(
      root.id!,
      adminRole.id!,
      'nearest-wins@example.com',
    );
    const childMembership = await memberships.create({
      userId: user.id,
      tenantId: child.id,
      roleId: editorRole.id,
    });
    await childMembership.save();

    const result = await resolver.resolvePermissions(user.id!, grandchild.id!);
    expect(result.permissions.has('articles.update')).toBe(true);
    expect(result.permissions.has('articles.delete')).toBe(false);
    expect(result.inheritedFromTenantId).toBe(child.id);
    expect(result.membershipId).toBe(childMembership.id);
  });

  it('target-tenant group roles still contribute when resolution is inherited', async () => {
    const { root, child } = await createTenantChain();
    const adminRole = await createRoleGranting(
      'Network Admin',
      ['articles.update'],
      { inheritsToDescendants: true },
    );
    const groupRole = await createRoleGranting('Child Group Role', [
      'special.child-access',
    ]);
    const { user } = await createMember(
      root.id!,
      adminRole.id!,
      'group-in-child@example.com',
    );

    const group = await groups.create({
      tenantId: child.id,
      name: 'Child Special Group',
    });
    await group.save();
    await groupRoles.addRole(group.id!, groupRole.id!);
    await groupMembers.addMember(group.id!, user.id!);

    const result = await resolver.resolvePermissions(user.id!, child.id!);
    expect(result.permissions.has('articles.update')).toBe(true);
    expect(result.permissions.has('special.child-access')).toBe(true);
    expect(result.groupIds).toContain(group.id);
  });

  it('honors an explicit `membership: null` option by applying inheritance', async () => {
    const { root, child } = await createTenantChain();
    const adminRole = await createRoleGranting(
      'Network Admin',
      ['articles.update'],
      { inheritsToDescendants: true },
    );
    const { user } = await createMember(
      root.id!,
      adminRole.id!,
      'null-membership-option@example.com',
    );

    const result = await resolver.resolvePermissions(user.id!, child.id!, {
      membership: null,
    });
    expect(result.permissions.has('articles.update')).toBe(true);
    expect(result.inheritedFromTenantId).toBe(root.id);
  });

  it('fails closed on malformed hierarchy paths', async () => {
    const { root, child } = await createTenantChain();
    const adminRole = await createRoleGranting(
      'Network Admin',
      ['articles.update'],
      { inheritsToDescendants: true },
    );
    const { user } = await createMember(
      root.id!,
      adminRole.id!,
      'malformed-path@example.com',
    );

    // Self-referential path: the tenant appears in its own ancestor chain.
    child.hierarchyPath = `${root.id}/${child.id}`;
    await child.save();
    let result = await resolver.resolvePermissions(user.id!, child.id!);
    expect(result.permissions.size).toBe(0);

    // Duplicate ancestor ids.
    child.hierarchyPath = `${root.id}/${root.id}`;
    await child.save();
    result = await resolver.resolvePermissions(user.id!, child.id!);
    expect(result.permissions.size).toBe(0);

    // Deeper than MAX_TENANT_HIERARCHY_DEPTH.
    const fakeAncestors = Array.from(
      { length: 10 },
      (_, index) => `fake-ancestor-${index}`,
    );
    child.hierarchyPath = [root.id, ...fakeAncestors].join('/');
    await child.save();
    result = await resolver.resolvePermissions(user.id!, child.id!);
    expect(result.permissions.size).toBe(0);

    // Sanity: restoring the real path restores inheritance.
    child.hierarchyPath = root.id!;
    await child.save();
    result = await resolver.resolvePermissions(user.id!, child.id!);
    expect(result.permissions.has('articles.update')).toBe(true);
  });

  it('fails closed when hierarchyPath disagrees with the actual parent chain', async () => {
    const { root, child } = await createTenantChain();

    // The user's flagged authority lives on an UNRELATED tenant...
    const unrelated = await tenants.create({ name: 'Unrelated Network' });
    await unrelated.save();
    const adminRole = await createRoleGranting(
      'Unrelated Admin',
      ['articles.update'],
      { inheritsToDescendants: true },
    );
    const { user } = await createMember(
      unrelated.id!,
      adminRole.id!,
      'stale-path@example.com',
    );

    // ...and a stale materialized path on the child claims that tenant as an
    // ancestor while parentTenantId still points at the real root. The path
    // passes the structural guards (short, no dupes, not self-referential)
    // but must not be trusted as an authorization source.
    child.hierarchyPath = unrelated.id!;
    await child.save();

    const result = await resolver.resolvePermissions(user.id!, child.id!);
    expect(result.permissions.size).toBe(0);
    expect(result.inheritedFromTenantId).toBeNull();
  });
});
