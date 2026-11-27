import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GlobalInterceptors } from '@happyvertical/smrt-core';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../models/index.js';
import { CliAuthRequestCollection } from '../collections/CliAuthRequestCollection.js';
import { GroupCollection } from '../collections/GroupCollection.js';
import { GroupMemberCollection } from '../collections/GroupMemberCollection.js';
import { GroupRoleCollection } from '../collections/GroupRoleCollection.js';
import { MembershipCollection } from '../collections/MembershipCollection.js';
import { MembershipOverrideCollection } from '../collections/MembershipOverrideCollection.js';
import { PermissionCollection } from '../collections/PermissionCollection.js';
import { ResourceGrantCollection } from '../collections/ResourceGrantCollection.js';
import { RoleCollection } from '../collections/RoleCollection.js';
import { RolePermissionCollection } from '../collections/RolePermissionCollection.js';
import { SessionCollection } from '../collections/SessionCollection.js';
import { TenantCollection } from '../collections/TenantCollection.js';
import { TenantGuestGrantCollection } from '../collections/TenantGuestGrantCollection.js';
import { TenantPermissionOverrideCollection } from '../collections/TenantPermissionOverrideCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import { syncPermissionCatalog, TenantService } from '../services/index.js';

/**
 * deleteTenant removes everything referencing the tenant in one transaction
 * (#5196 slice I). `HANDLED_TENANT_REFERENCES` is the contract: the schema
 * walk below fails when a table gains a foreign key to `tenants` without a
 * decision in `removeTenantDependents`.
 */
const HANDLED_TENANT_REFERENCES = [
  'groups',
  'memberships',
  'resource_grants',
  'roles',
  'sessions',
  'tenant_guest_grants',
  'tenant_permission_overrides',
  'tenants', // parent_tenant_id: refused while children exist
  'users_cli_auth_requests',
];

describe('TenantService.deleteTenant dependents (#5196)', () => {
  let dbPath: string;
  let options: { db: { type: 'sqlite'; url: string } };
  let service: TenantService;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-tenant-del-${randomUUID()}.db`);
    options = { db: { type: 'sqlite', url: dbPath } };
    await syncPermissionCatalog(options);
    service = new TenantService(options, {
      mode: 'flexible',
      maxTenants: 0,
      defaultName: 'x',
    });
    await service.initialize();
  });

  afterEach(() => {
    GlobalInterceptors.clear();
    if (existsSync(dbPath)) rmSync(dbPath, { force: true });
  });

  async function ownedTenant(name: string) {
    const users = await UserCollection.create(options);
    const user = await users.create({
      email: `owner-${randomUUID()}@example.com`,
    });
    await user.save();
    const { tenant } = await service.createTenantWithOwnership(
      user.id as string,
      name,
      { slug: `${name}-${randomUUID()}` },
    );
    return { userId: user.id as string, tenantId: tenant.id as string };
  }

  /** Every kind of row that references the tenant. */
  async function populate(userId: string, tenantId: string) {
    const sessions = await SessionCollection.create(options);
    const session = await sessions.createSession({ userId, tenantId });
    const cli = await CliAuthRequestCollection.create(options);
    await (
      await cli.create({
        userCode: `u-${randomUUID()}`,
        deviceCodeHash: `d-${randomUUID()}`,
        status: 'approved',
        userId,
        tenantId,
        sessionId: session.id as string,
      })
    ).save();
    const roles = await RoleCollection.create(options);
    const role = await roles.create({
      name: 'Custom',
      slug: `custom-${randomUUID()}`,
      tenantId,
    });
    await role.save();
    const permissions = await PermissionCollection.create(options);
    const permission = (await permissions.findBySlug('tenants.read'))!;
    await (await RolePermissionCollection.create(options)).addPermission(
      role.id as string,
      permission.id as string,
    );
    // An invited (pending) member holding the tenant role + an override.
    const invitee = await (await UserCollection.create(options)).create({
      email: `invitee-${randomUUID()}@example.com`,
    });
    await invitee.save();
    const membership = await (
      await MembershipCollection.create(options)
    ).create({
      userId: invitee.id as string,
      tenantId,
      roleId: role.id as string,
      status: 'invited' as never,
    });
    await membership.save();
    await (
      await (
        await MembershipOverrideCollection.create(options)
      ).create({
        membershipId: membership.id as string,
        permissionId: permission.id as string,
        effect: 'grant' as never,
      })
    ).save();
    const group = await (await GroupCollection.create(options)).create({
      name: 'G',
      slug: `g-${randomUUID()}`,
      tenantId,
    });
    await group.save();
    await (
      await (
        await GroupMemberCollection.create(options)
      ).create({
        groupId: group.id as string,
        userId,
      })
    ).save();
    await (
      await (
        await GroupRoleCollection.create(options)
      ).create({
        groupId: group.id as string,
        roleId: role.id as string,
      })
    ).save();
    const resources = await ResourceGrantCollection.create(options);
    const parent = await resources.create({
      tenantId,
      userId,
      resourceType: 'doc',
      resourceId: 'd1',
      permission: 'read',
      canDelegate: true,
    });
    await parent.save();
    await (
      await resources.create({
        tenantId,
        userId,
        resourceType: 'doc',
        resourceId: 'd1',
        permission: 'read',
        parentGrantId: parent.id as string,
      })
    ).save();
    await (
      await (
        await TenantPermissionOverrideCollection.create(options)
      ).create({
        tenantId,
        permissionId: permission.id as string,
        effect: 'deny' as never,
      })
    ).save();
    await (
      await (
        await TenantGuestGrantCollection.create(options)
      ).create({
        tenantId,
        permissionSlug: 'products.read',
      })
    ).save();
  }

  async function countRows(tenantId: string): Promise<Record<string, number>> {
    const db = await getDatabase(options.db);
    const out: Record<string, number> = {};
    const q = async (name: string, sql: string) => {
      const r: any = await db.query(sql, tenantId);
      out[name] = Number((r.rows ?? r)[0].n);
    };
    await q('sessions', 'SELECT COUNT(*) n FROM sessions WHERE tenant_id = ?');
    await q(
      'cli',
      'SELECT COUNT(*) n FROM users_cli_auth_requests WHERE tenant_id = ?',
    );
    await q(
      'memberships',
      'SELECT COUNT(*) n FROM memberships WHERE tenant_id = ?',
    );
    await q(
      'membershipOverrides',
      'SELECT COUNT(*) n FROM membership_overrides',
    );
    await q('groups', 'SELECT COUNT(*) n FROM groups WHERE tenant_id = ?');
    await q('groupMembers', 'SELECT COUNT(*) n FROM group_members');
    await q('groupRoles', 'SELECT COUNT(*) n FROM group_roles');
    await q('roles', 'SELECT COUNT(*) n FROM roles WHERE tenant_id = ?');
    await q(
      'rolePermissions',
      `SELECT COUNT(*) n FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE tenant_id = ?)`,
    );
    await q(
      'resourceGrants',
      'SELECT COUNT(*) n FROM resource_grants WHERE tenant_id = ?',
    );
    await q(
      'overrides',
      'SELECT COUNT(*) n FROM tenant_permission_overrides WHERE tenant_id = ?',
    );
    await q(
      'guestGrants',
      'SELECT COUNT(*) n FROM tenant_guest_grants WHERE tenant_id = ?',
    );
    return out;
  }

  it('declares a decision for every table with a foreign key to tenants', async () => {
    const db = await getDatabase(options.db);
    const tables: any = await db.query(
      `SELECT name, sql FROM sqlite_master WHERE type = 'table'`,
    );
    const referencing = new Set<string>();
    for (const t of tables.rows ?? tables) {
      if (/REFERENCES\s+"?tenants"?/i.test(String(t.sql))) {
        referencing.add(String(t.name));
      }
    }
    // Tables are created lazily; touching the collections materializes them.
    await populate(
      ...(Object.values(await ownedTenant('probe')) as [string, string]),
    );
    const after: any = await db.query(
      `SELECT name, sql FROM sqlite_master WHERE type = 'table'`,
    );
    for (const t of after.rows ?? after) {
      if (/REFERENCES\s+"?tenants"?/i.test(String(t.sql))) {
        referencing.add(String(t.name));
      }
    }
    const unhandled = [...referencing].filter(
      (name) => !HANDLED_TENANT_REFERENCES.includes(name),
    );
    expect(unhandled).toEqual([]);
    expect(referencing.size).toBeGreaterThan(0);
  });

  it('removes sessions, invitations, groups, roles, grants and the tenant together', async () => {
    const { userId, tenantId } = await ownedTenant('doomed');
    await populate(userId, tenantId);
    const kept = await ownedTenant('kept');
    await populate(kept.userId, kept.tenantId);

    const before = await countRows(tenantId);
    for (const [k, v] of Object.entries(before))
      expect(v, k).toBeGreaterThan(0);

    await service.deleteTenant(userId, tenantId);

    const tenants = await TenantCollection.create(options);
    expect(await tenants.get({ id: tenantId })).toBeFalsy();
    const after = await countRows(tenantId);
    for (const [k, v] of Object.entries(after)) {
      if (['membershipOverrides', 'groupMembers', 'groupRoles'].includes(k))
        continue;
      expect(v, k).toBe(0);
    }
    // The other tenant is untouched.
    const other = await countRows(kept.tenantId);
    for (const [k, v] of Object.entries(other)) expect(v, k).toBeGreaterThan(0);
    expect(await tenants.get({ id: kept.tenantId })).toBeTruthy();
  });

  it('rolls every dependent back when the tenant delete fails', async () => {
    const { userId, tenantId } = await ownedTenant('rollback');
    await populate(userId, tenantId);
    const before = await countRows(tenantId);

    GlobalInterceptors.register({
      name: 'fail-tenant-delete',
      beforeDelete(instance) {
        if ((instance as { id?: string }).id === tenantId) {
          throw new Error('injected tenant delete failure');
        }
      },
    });
    await expect(service.deleteTenant(userId, tenantId)).rejects.toThrow();
    GlobalInterceptors.clear();

    expect(await countRows(tenantId)).toEqual(before);
    expect(
      await (await TenantCollection.create(options)).get({ id: tenantId }),
    ).toBeTruthy();
  });

  it('refuses a tenant that still has child tenants and deletes nothing', async () => {
    const { userId, tenantId } = await ownedTenant('parent');
    await populate(userId, tenantId);
    const tenants = await TenantCollection.create(options);
    await (
      await tenants.create({
        name: 'Child',
        slug: `child-${randomUUID()}`,
        parentTenantId: tenantId,
      })
    ).save();
    const before = await countRows(tenantId);

    await expect(service.deleteTenant(userId, tenantId)).rejects.toThrow(
      /child tenants/,
    );
    expect(await countRows(tenantId)).toEqual(before);
  });
});
