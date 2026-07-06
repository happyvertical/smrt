import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SmrtCollection, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { withSystemContext, withTenant } from '@happyvertical/smrt-tenancy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../models/index.js';
import { MembershipCollection } from '../collections/MembershipCollection.js';
import { PermissionCollection } from '../collections/PermissionCollection.js';
import { RoleCollection } from '../collections/RoleCollection.js';
import {
  DEFAULT_ROLE_PERMISSION_PATTERNS,
  RolePermissionCollection,
} from '../collections/RolePermissionCollection.js';
import { TenantCollection } from '../collections/TenantCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import type { Tenant } from '../models/Tenant.js';
import type { User } from '../models/User.js';
import {
  assertOperationPermission,
  deriveOperationPermissionSlug,
  hasOperationPermission,
  OperationPermissionError,
  PermissionCatalogService,
  registerPermissionDefinitions,
  syncPermissionCatalog,
} from '../services/index.js';

@smrt({
  api: { include: ['list', 'create', 'update'] },
  collection: 'operation_permission_records',
})
class OperationPermissionRecord extends SmrtObject {
  title: string = '';
}

class OperationPermissionRecordCollection extends SmrtCollection<OperationPermissionRecord> {
  static readonly _itemClass = OperationPermissionRecord;
}

interface ActorFixture {
  tenant: Tenant;
  user: User;
}

describe('operation permission guards', () => {
  let dbPath: string;
  let options: { db: { type: 'sqlite'; url: string } };
  let users: UserCollection;
  let tenants: TenantCollection;
  let roles: RoleCollection;
  let memberships: MembershipCollection;
  let permissions: PermissionCollection;
  let rolePermissions: RolePermissionCollection;
  const cleanupFns: Array<() => void> = [];

  async function createActor(permissionSlugs: string[]): Promise<ActorFixture> {
    await syncPermissionCatalog(options);

    const user = await users.create({
      email: `operation-${randomUUID()}@example.com`,
    });
    await user.save();

    const tenant = await tenants.create({ name: `Tenant ${randomUUID()}` });
    await tenant.save();

    const role = await roles.create({
      name: `Role ${randomUUID()}`,
      slug: `role-${randomUUID()}`,
    });
    await role.save();

    if (!role.id || !user.id || !tenant.id) {
      throw new Error('Expected persisted test records to have ids.');
    }

    for (const slug of permissionSlugs) {
      const permission = await permissions.findBySlug(slug);
      if (!permission?.id) {
        throw new Error(`Expected synced permission '${slug}'.`);
      }
      await rolePermissions.addPermission(role.id, permission.id);
    }

    const membership = await memberships.create({
      roleId: role.id,
      tenantId: tenant.id,
      userId: user.id,
    });
    await membership.save();

    return { tenant, user };
  }

  async function slugsForRole(roleSlug: string): Promise<string[]> {
    const role = await roles.findBySlug(roleSlug);
    if (!role?.id) {
      throw new Error(`Expected role '${roleSlug}' to exist.`);
    }

    const permissionIds = await rolePermissions.getPermissionIds(role.id);
    const permissionMap = await permissions.findByIds(permissionIds);
    return Array.from(permissionMap.values())
      .map((permission) => permission.slug ?? '')
      .filter(Boolean)
      .sort();
  }

  const authorityCreateSlugs = [
    'groupmembers.create',
    'grouproles.create',
    'groups.create',
    'membershipoverrides.create',
    'memberships.create',
    'permissions.create',
    'rolepermissions.create',
    'roles.create',
    'sessions.create',
    'tenantpermissionoverrides.create',
    'tenants.create',
    'users.create',
    'usersmagiclinktokens.create',
  ];

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-operation-permission-${randomUUID()}.db`);
    options = { db: { type: 'sqlite', url: dbPath } };
    users = await UserCollection.create(options);
    tenants = await TenantCollection.create(options);
    roles = await RoleCollection.create(options);
    memberships = await MembershipCollection.create(options);
    permissions = await PermissionCollection.create(options);
    rolePermissions = await RolePermissionCollection.create(options);
  });

  afterEach(() => {
    while (cleanupFns.length > 0) {
      cleanupFns.pop()?.();
    }

    if (existsSync(dbPath)) {
      rmSync(dbPath, { force: true });
    }
  });

  it('derives operation slugs from strings, classes, instances, and collections', async () => {
    const collection =
      await OperationPermissionRecordCollection.create(options);
    const record = new OperationPermissionRecord();
    const catalog = PermissionCatalogService.create().getCatalog();

    expect(
      deriveOperationPermissionSlug('operation_permission_records', 'update'),
    ).toBe('operation_permission_records.update');
    expect(
      deriveOperationPermissionSlug(OperationPermissionRecord, 'list'),
    ).toBe('operation_permission_records.read');
    expect(deriveOperationPermissionSlug(record, 'get')).toBe(
      'operation_permission_records.read',
    );
    expect(deriveOperationPermissionSlug(collection, 'create')).toBe(
      'operation_permission_records.create',
    );
    expect(catalog.permissions.map((permission) => permission.slug)).toContain(
      'operation_permission_records.read',
    );
  });

  it('allows holders and denies non-holders fail-closed', async () => {
    const holder = await createActor(['operation_permission_records.update']);
    const nonHolder = await createActor([]);

    const decision = await assertOperationPermission({
      ...options,
      action: 'update',
      collection: 'operation_permission_records',
      tenantId: holder.tenant.id,
      userId: holder.user.id,
    });
    expect(decision).toMatchObject({
      allowed: true,
      permission: 'operation_permission_records.update',
      reason: 'permission_granted',
    });
    await expect(
      hasOperationPermission({
        ...options,
        action: 'update',
        collection: OperationPermissionRecord,
        tenantId: holder.tenant.id,
        userId: holder.user.id,
      }),
    ).resolves.toBe(true);

    let thrown: unknown;
    try {
      await assertOperationPermission({
        ...options,
        action: 'update',
        collection: 'operation_permission_records',
        tenantId: nonHolder.tenant.id,
        userId: nonHolder.user.id,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(OperationPermissionError);
    expect((thrown as OperationPermissionError).decision).toMatchObject({
      allowed: false,
      permission: 'operation_permission_records.update',
      reason: 'permission_denied',
    });
  });

  it('resolves opt-in ancestor authority when guarding with the resource tenant id (#1866)', async () => {
    await syncPermissionCatalog(options);

    const root = await tenants.create({ name: `Network ${randomUUID()}` });
    await root.save();
    const child = await tenants.createChild(root.id!, {
      name: `Publication ${randomUUID()}`,
    });

    const permission = await permissions.findBySlug(
      'operation_permission_records.update',
    );
    if (!permission?.id) {
      throw new Error('Expected synced operation permission.');
    }

    const flaggedAdminRole = await roles.create({
      name: `Network Admin ${randomUUID()}`,
      inheritsToDescendants: true,
    });
    await flaggedAdminRole.save();
    await rolePermissions.addPermission(flaggedAdminRole.id!, permission.id);

    // The unflagged role holds the SAME permission: possession at the root is
    // not enough, the role itself must opt in to descendant inheritance.
    const unflaggedMemberRole = await roles.create({
      name: `Member ${randomUUID()}`,
    });
    await unflaggedMemberRole.save();
    await rolePermissions.addPermission(unflaggedMemberRole.id!, permission.id);

    const rootAdmin = await users.create({
      email: `root-admin-${randomUUID()}@example.com`,
    });
    await rootAdmin.save();
    await (
      await memberships.create({
        roleId: flaggedAdminRole.id,
        tenantId: root.id,
        userId: rootAdmin.id,
      })
    ).save();

    const rootMember = await users.create({
      email: `root-member-${randomUUID()}@example.com`,
    });
    await rootMember.save();
    await (
      await memberships.create({
        roleId: unflaggedMemberRole.id,
        tenantId: root.id,
        userId: rootMember.id,
      })
    ).save();

    const unrelatedRoot = await tenants.create({
      name: `Unrelated Network ${randomUUID()}`,
    });
    await unrelatedRoot.save();
    const unrelatedAdmin = await users.create({
      email: `unrelated-admin-${randomUUID()}@example.com`,
    });
    await unrelatedAdmin.save();
    await (
      await memberships.create({
        roleId: flaggedAdminRole.id,
        tenantId: unrelatedRoot.id,
        userId: unrelatedAdmin.id,
      })
    ).save();

    // Flagged root admin passes for a child resource tenant even with the
    // super-admin bypass suppressed — authority follows the hierarchy.
    const adminDecision = await assertOperationPermission({
      ...options,
      action: 'update',
      allowSuperAdminBypass: false,
      collection: 'operation_permission_records',
      tenantId: child.id,
      userId: rootAdmin.id,
    });
    expect(adminDecision).toMatchObject({
      allowed: true,
      permission: 'operation_permission_records.update',
      reason: 'permission_granted',
    });

    const memberDecision = await assertOperationPermission({
      ...options,
      action: 'update',
      allowSuperAdminBypass: false,
      collection: 'operation_permission_records',
      onDeny: 'return',
      tenantId: child.id,
      userId: rootMember.id,
    });
    expect(memberDecision).toMatchObject({
      allowed: false,
      reason: 'permission_denied',
    });

    const unrelatedDecision = await assertOperationPermission({
      ...options,
      action: 'update',
      allowSuperAdminBypass: false,
      collection: 'operation_permission_records',
      onDeny: 'return',
      tenantId: child.id,
      userId: unrelatedAdmin.id,
    });
    expect(unrelatedDecision).toMatchObject({
      allowed: false,
      reason: 'permission_denied',
    });
  });

  it('returns a structured deny for unknown catalog operations', async () => {
    const actor = await createActor(['operation_permission_records.update']);

    const decision = await assertOperationPermission({
      ...options,
      action: 'destroy',
      collection: 'operation_permission_records',
      onDeny: 'return',
      tenantId: actor.tenant.id,
      userId: actor.user.id,
    });

    expect(decision).toMatchObject({
      allowed: false,
      permission: 'operation_permission_records.destroy',
      reason: 'unknown_permission',
    });
  });

  it('honors system and super-admin bypass signals and lets callers suppress super-admin bypass', async () => {
    const actor = await createActor([]);
    const tenantId = actor.tenant.id;
    if (!tenantId) {
      throw new Error('Expected test tenant to have an id.');
    }

    await withSystemContext(async () => {
      const decision = await assertOperationPermission({
        ...options,
        action: 'update',
        collection: 'operation_permission_records',
      });

      expect(decision).toMatchObject({
        allowed: true,
        permission: 'operation_permission_records.update',
        reason: 'system_context_bypass',
      });
    });

    await withTenant({ superAdminBypass: true, tenantId }, async () => {
      const allowed = await assertOperationPermission({
        ...options,
        action: 'update',
        collection: 'operation_permission_records',
        tenantId: actor.tenant.id,
        userId: actor.user.id,
      });
      expect(allowed).toMatchObject({
        allowed: true,
        permission: 'operation_permission_records.update',
        reason: 'super_admin_bypass',
      });

      const suppressed = await assertOperationPermission({
        ...options,
        action: 'update',
        allowSuperAdminBypass: false,
        collection: 'operation_permission_records',
        onDeny: 'return',
        tenantId: actor.tenant.id,
        userId: actor.user.id,
      });
      expect(suppressed).toMatchObject({
        allowed: false,
        permission: 'operation_permission_records.update',
        reason: 'permission_denied',
      });
    });
  });

  it('seeds default role permissions from catalog patterns idempotently', async () => {
    await roles.seedSystemRoles();

    const first = await rolePermissions.seedRolePermissions();
    expect(first.added.admin).toContain('operation_permission_records.update');
    expect(first.added.owner).toContain('operation_permission_records.update');
    expect(first.added.member).toContain('operation_permission_records.create');
    expect(first.added.member).not.toContain(
      'operation_permission_records.update',
    );
    for (const slug of authorityCreateSlugs) {
      expect(first.added.owner).toContain(slug);
      expect(first.added.member).not.toContain(slug);
    }
    expect(first.added.viewer).toContain('operation_permission_records.read');
    expect(first.added.viewer).not.toContain(
      'operation_permission_records.create',
    );

    const adminSlugs = await slugsForRole('admin');
    const memberSlugs = await slugsForRole('member');
    const viewerSlugs = await slugsForRole('viewer');
    expect(adminSlugs).toContain('operation_permission_records.update');
    for (const slug of authorityCreateSlugs) {
      expect(adminSlugs).toContain(slug);
      expect(memberSlugs).not.toContain(slug);
    }
    expect(viewerSlugs).toContain('operation_permission_records.read');
    expect(viewerSlugs).not.toContain('operation_permission_records.create');
    expect(viewerSlugs).not.toContain('operation_permission_records.update');

    const second = await rolePermissions.seedRolePermissions();
    expect(Object.values(second.added).flat()).toEqual([]);
    expect(second.unchanged.admin).toContain(
      'operation_permission_records.update',
    );

    const unregister = registerPermissionDefinitions([
      {
        category: 'campaigns',
        name: 'Approve Campaigns',
        slug: 'campaigns.approve',
      },
    ]);
    cleanupFns.push(unregister);

    const third = await rolePermissions.seedRolePermissions();
    expect(third.added.admin).toContain('campaigns.approve');
    expect(third.added.owner).toContain('campaigns.approve');
    expect(third.added.viewer).not.toContain('campaigns.approve');
  });

  it('can seed role permissions through seedSystemRoles opt-in', async () => {
    await roles.seedSystemRoles({
      permissionMatrix: DEFAULT_ROLE_PERMISSION_PATTERNS,
      seedPermissions: true,
    });

    const adminSlugs = await slugsForRole('admin');
    expect(adminSlugs).toContain('operation_permission_records.update');
  });
});
