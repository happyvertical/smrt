/**
 * Guest grants on PostgreSQL semantics (#5196, slice I).
 *
 * One suite, two backends:
 * - in-process PGlite: `pnpm --filter @happyvertical/smrt-users test:pglite`
 *   (sets SMRT_TEST_PGLITE=1), runnable anywhere;
 * - real PostgreSQL: gated on DATABASE_URL (`isPostgresAvailable()`) and run
 *   by `test:postgres` and the on-demand validation workflow.
 * Without either it skips cleanly.
 *
 * Proves what SQLite cannot: native uuid column types, a missing grants table
 * surfacing as 42P01 and resolving to nothing, real foreign keys (NO ACTION)
 * across the `deleteTenant` dependents, and grant/revoke authorizing against
 * the grant's own tenant.
 */

import { randomUUID } from 'node:crypto';
import {
  field,
  getTestDatabase,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../models/index.js';
import { CliAuthRequestCollection } from '../collections/CliAuthRequestCollection.js';
import { GroupCollection } from '../collections/GroupCollection.js';
import { GroupMemberCollection } from '../collections/GroupMemberCollection.js';
import { MembershipCollection } from '../collections/MembershipCollection.js';
import { PermissionCollection } from '../collections/PermissionCollection.js';
import { ResourceGrantCollection } from '../collections/ResourceGrantCollection.js';
import { RoleCollection } from '../collections/RoleCollection.js';
import { RolePermissionCollection } from '../collections/RolePermissionCollection.js';
import { SessionCollection } from '../collections/SessionCollection.js';
import { TenantCollection } from '../collections/TenantCollection.js';
import { TenantGuestGrantCollection } from '../collections/TenantGuestGrantCollection.js';
import { TenantPermissionOverrideCollection } from '../collections/TenantPermissionOverrideCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import {
  GuestPermissionResolver,
  OperationPermissionError,
  TenantGuestGrantService,
  TenantService,
} from '../services/index.js';
import { TenantStatus } from '../types/index.js';

@smrt({
  packageName: '@test/gpg5196',
  tenantScoped: true,
  collection: 'gpg5196_products',
})
class GpgProduct5196 extends SmrtObject {
  @field() title = '';
}

const usePglite = process.env.SMRT_TEST_PGLITE === '1';
const describeBackend =
  usePglite || isPostgresAvailable() ? describe : describe.skip;
const backendName = usePglite ? 'PGlite' : 'PostgreSQL';

const CLASSES = [
  'User',
  'Tenant',
  'Role',
  'Permission',
  'RolePermission',
  'Membership',
  'MembershipOverride',
  'Group',
  'GroupMember',
  'GroupRole',
  'Session',
  'ResourceGrant',
  'TenantGuestGrant',
  'TenantPermissionOverride',
  'UsersCliAuthRequest',
  'GpgProduct5196',
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  return (result as { rows?: Array<Record<string, unknown>> }).rows ?? [];
}

describeBackend(`guest grants on ${backendName} (#5196)`, () => {
  let db: DatabaseInterface;
  let options: { db: unknown };
  let isolated: IsolatedTestDbResult | undefined;
  let adminDb: DatabaseInterface | undefined;
  const tenantIds: string[] = [];
  const userIds: string[] = [];
  const permissionIds: string[] = [];
  const roleIds: string[] = [];

  let tenants: TenantCollection;
  let grants: TenantGuestGrantCollection;
  let permissions: PermissionCollection;
  let overrides: TenantPermissionOverrideCollection;
  let resolver: GuestPermissionResolver;

  beforeEach(async () => {
    tenantIds.length = 0;
    userIds.length = 0;
    permissionIds.length = 0;
    roleIds.length = 0;
    if (usePglite) {
      db = await getTestDatabase({
        type: 'pglite',
        url: ':memory:',
        classes: CLASSES,
      });
      options = { db };
    } else {
      // Tables are created once in the shared test database; rows written
      // here commit, so afterEach removes exactly what the test created.
      isolated = await createIsolatedTestDbFromManifest();
      if (isolated.config.type !== 'postgres') {
        throw new Error('Expected a Postgres test database.');
      }
      const config = { type: 'postgres' as const, url: isolated.config.url };
      adminDb = await getDatabase(config);
      db = adminDb;
      options = { db: config };
    }
    tenants = await TenantCollection.create(options);
    grants = await TenantGuestGrantCollection.create(options);
    permissions = await PermissionCollection.create(options);
    overrides = await TenantPermissionOverrideCollection.create(options);
    resolver = await GuestPermissionResolver.create(options, {
      collections: ['gpg5196_products'],
      createCollections: ['gpg5196_products'],
    });
  });

  afterEach(async () => {
    if (usePglite) {
      if (typeof db.close === 'function') await db.close();
      return;
    }
    if (adminDb) {
      const run = async (sql: string, ids: string[]) => {
        if (ids.length === 0) return;
        try {
          await adminDb?.query(sql, [ids]);
        } catch {
          // best-effort cleanup against a shared test database
        }
      };
      const byTenant = (table: string) =>
        `DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`;
      await run(
        `DELETE FROM membership_overrides WHERE membership_id IN
           (SELECT id FROM memberships WHERE tenant_id = ANY($1::uuid[]))`,
        tenantIds,
      );
      await run(
        `DELETE FROM group_members WHERE group_id IN
           (SELECT id FROM groups WHERE tenant_id = ANY($1::uuid[]))`,
        tenantIds,
      );
      await run(
        `DELETE FROM group_roles WHERE group_id IN
           (SELECT id FROM groups WHERE tenant_id = ANY($1::uuid[]))`,
        tenantIds,
      );
      for (const table of [
        'users_cli_auth_requests',
        'sessions',
        'memberships',
        'groups',
        'resource_grants',
        'tenant_permission_overrides',
        'tenant_guest_grants',
      ]) {
        await run(byTenant(table), tenantIds);
      }
      await run(
        'DELETE FROM role_permissions WHERE role_id = ANY($1::uuid[])',
        roleIds,
      );
      await run('DELETE FROM roles WHERE id = ANY($1::uuid[])', roleIds);
      await run('DELETE FROM tenants WHERE id = ANY($1::uuid[])', tenantIds);
      await run(
        'DELETE FROM permissions WHERE id = ANY($1::uuid[])',
        permissionIds,
      );
      await run('DELETE FROM users WHERE id = ANY($1::uuid[])', userIds);
    }
    if (isolated) await isolated.cleanup();
    isolated = undefined;
    adminDb = undefined;
  });

  async function tenant(label: string, parentTenantId?: string) {
    const slug = `${label}-${randomUUID()}`;
    const row = await tenants.create({ name: slug, slug, parentTenantId });
    await row.save();
    tenantIds.push(row.id as string);
    return row;
  }

  async function permission(slug: string) {
    const existing = await permissions.findBySlug(slug);
    if (existing) return existing;
    const row = await permissions.create({ slug, name: slug });
    await row.save();
    permissionIds.push(row.id as string);
    return row;
  }

  const grant = (tenantId: string, permissionSlug: string) =>
    grants.create({ tenantId, permissionSlug });

  describe('GuestPermissionResolver', () => {
    it('uses native uuid columns and resolves a granted slug', async () => {
      const t = await tenant('uuid');
      await grant(t.id as string, 'gpg5196_products.read');
      expect([
        ...(await resolver.resolveGuestPermissions(t.id as string)),
      ]).toEqual(['gpg5196_products.read']);
      const columns = rowsOf(
        await db.query(
          `SELECT column_name, data_type FROM information_schema.columns
            WHERE table_name = 'tenant_guest_grants'
              AND column_name IN ('id', 'tenant_id')
            ORDER BY column_name`,
        ),
      );
      expect(columns).toEqual([
        { column_name: 'id', data_type: 'uuid' },
        { column_name: 'tenant_id', data_type: 'uuid' },
      ]);
      const stored = rowsOf(
        await db.query('SELECT id, tenant_id FROM tenant_guest_grants'),
      );
      expect(String(stored[0].id)).toMatch(UUID);
      expect(String(stored[0].tenant_id)).toBe(t.id);
    });

    it('an unknown or malformed tenant id resolves to nothing', async () => {
      expect((await resolver.resolveGuestPermissions(randomUUID())).size).toBe(
        0,
      );
      expect((await resolver.resolveGuestPermissions('not-a-uuid')).size).toBe(
        0,
      );
    });

    it('keeps grants per tenant', async () => {
      const a = await tenant('a');
      const b = await tenant('b');
      await grant(a.id as string, 'gpg5196_products.read');
      expect(
        (await resolver.resolveGuestPermissions(a.id as string)).size,
      ).toBe(1);
      expect(
        (await resolver.resolveGuestPermissions(b.id as string)).size,
      ).toBe(0);
    });

    it('a missing grants table resolves to nothing (42P01)', async () => {
      const t = await tenant('missing');
      await grant(t.id as string, 'gpg5196_products.read');
      expect(
        (await resolver.resolveGuestPermissions(t.id as string)).size,
      ).toBe(1);

      // Renamed, not dropped: a real PostgreSQL database shares this table
      // with later suites, and the rename is trivially undone.
      await db.query(
        'ALTER TABLE tenant_guest_grants RENAME TO tenant_guest_grants_gone',
      );
      try {
        expect(
          (await resolver.resolveGuestPermissions(t.id as string)).size,
        ).toBe(0);
        const fresh = await GuestPermissionResolver.create(options, {
          collections: ['gpg5196_products'],
        });
        expect((await fresh.resolveGuestPermissions(t.id as string)).size).toBe(
          0,
        );
      } finally {
        await db.query(
          'ALTER TABLE tenant_guest_grants_gone RENAME TO tenant_guest_grants',
        );
      }
    });

    it('an inactive tenant or ancestor resolves to nothing', async () => {
      const parent = await tenant('parent');
      const child = await tenant('child', parent.id as string);
      await grant(child.id as string, 'gpg5196_products.read');
      expect(
        (await resolver.resolveGuestPermissions(child.id as string)).size,
      ).toBe(1);

      parent.status = TenantStatus.SUSPENDED;
      await parent.save();
      expect(
        (await resolver.resolveGuestPermissions(child.id as string)).size,
      ).toBe(0);

      parent.status = TenantStatus.ACTIVE;
      await parent.save();
      child.status = TenantStatus.SUSPENDED;
      await child.save();
      expect(
        (await resolver.resolveGuestPermissions(child.id as string)).size,
      ).toBe(0);
    });

    it('a DENY on the tenant or an ancestor removes the slug', async () => {
      const parent = await tenant('deny-parent');
      const child = await tenant('deny-child', parent.id as string);
      const perm = await permission('gpg5196_products.read');
      await grant(child.id as string, 'gpg5196_products.read');
      expect(
        (await resolver.resolveGuestPermissions(child.id as string)).size,
      ).toBe(1);

      await overrides.denyPermission(parent.id as string, perm.id as string);
      expect(
        (await resolver.resolveGuestPermissions(child.id as string)).size,
      ).toBe(0);

      await overrides.removeAllOverrides(parent.id as string);
      expect(
        (await resolver.resolveGuestPermissions(child.id as string)).size,
      ).toBe(1);
      await overrides.denyPermission(child.id as string, perm.id as string);
      expect(
        (await resolver.resolveGuestPermissions(child.id as string)).size,
      ).toBe(0);
    });
  });

  describe('TenantGuestGrantService', () => {
    async function actorIn(tenantId: string, slugs: string[], userId?: string) {
      const users = await UserCollection.create(options);
      const roles = await RoleCollection.create(options);
      const rolePermissions = await RolePermissionCollection.create(options);
      const memberships = await MembershipCollection.create(options);
      let id = userId;
      if (!id) {
        const user = await users.create({
          email: `gg-${randomUUID()}@example.com`,
        });
        await user.save();
        id = user.id as string;
        userIds.push(id);
      }
      const role = await roles.create({
        name: `Role ${randomUUID()}`,
        slug: `role-${randomUUID()}`,
      });
      await role.save();
      roleIds.push(role.id as string);
      for (const slug of slugs) {
        const perm = await permission(slug);
        await rolePermissions.addPermission(
          role.id as string,
          perm.id as string,
        );
      }
      await (
        await memberships.create({ roleId: role.id, tenantId, userId: id })
      ).save();
      return id;
    }

    const asActor = (userId: string) => ({
      userId,
      allowSystemContextBypass: false,
      allowSuperAdminBypass: false,
    });

    it('grant and revoke bind the grant tenant, never the caller tenant', async () => {
      const own = await tenant('own');
      const other = await tenant('other');
      const service = new TenantGuestGrantService(options);
      const userId = await actorIn(own.id as string, [
        'tenantguestgrants.create',
        'tenantguestgrants.delete',
        'tenantguestgrants.read',
      ]);
      await actorIn(other.id as string, [], userId);

      await expect(
        service.grant(
          other.id as string,
          'gpg5196_products.read',
          asActor(userId),
        ),
      ).rejects.toBeInstanceOf(OperationPermissionError);
      expect(await grants.findByTenant(other.id as string)).toEqual([]);

      const created = await service.grant(
        own.id as string,
        'gpg5196_products.read',
        asActor(userId),
      );
      expect(created.tenantId).toBe(own.id);
      expect(created.grantedBy).toBe(userId);
      expect(await grants.findByTenant(other.id as string)).toEqual([]);

      await expect(
        service.revoke(
          other.id as string,
          'gpg5196_products.read',
          asActor(userId),
        ),
      ).rejects.toBeInstanceOf(OperationPermissionError);
      expect(await grants.findByTenant(own.id as string)).toHaveLength(1);
      expect(
        await service.revoke(
          own.id as string,
          'gpg5196_products.read',
          asActor(userId),
        ),
      ).toBe(true);
      expect(await grants.findByTenant(own.id as string)).toEqual([]);
    });
  });

  describe('deleteTenant', () => {
    async function ownedTenant(service: TenantService, name: string) {
      const users = await UserCollection.create(options);
      const user = await users.create({
        email: `own-${randomUUID()}@example.com`,
      });
      await user.save();
      userIds.push(user.id as string);
      const { tenant: created } = await service.createTenantWithOwnership(
        user.id as string,
        name,
        { slug: `${name}-${randomUUID()}` },
      );
      tenantIds.push(created.id as string);
      return { userId: user.id as string, tenantId: created.id as string };
    }

    async function populate(userId: string, tenantId: string) {
      const session = await (
        await SessionCollection.create(options)
      ).createSession({
        userId,
        tenantId,
      });
      await (
        await (
          await CliAuthRequestCollection.create(options)
        ).create({
          userCode: `u-${randomUUID()}`,
          deviceCodeHash: `d-${randomUUID()}`,
          status: 'approved',
          userId,
          tenantId,
          sessionId: session.id as string,
        })
      ).save();
      const role = await (await RoleCollection.create(options)).create({
        name: 'Custom',
        slug: `custom-${randomUUID()}`,
        tenantId,
      });
      await role.save();
      roleIds.push(role.id as string);
      const perm = await permission('tenants.read');
      await (await RolePermissionCollection.create(options)).addPermission(
        role.id as string,
        perm.id as string,
      );
      const invitee = await (await UserCollection.create(options)).create({
        email: `inv-${randomUUID()}@example.com`,
      });
      await invitee.save();
      userIds.push(invitee.id as string);
      await (
        await (
          await MembershipCollection.create(options)
        ).create({
          userId: invitee.id as string,
          tenantId,
          roleId: role.id as string,
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
      await overrides.denyPermission(tenantId, perm.id as string);
      await grant(tenantId, 'gpg5196_products.read');
    }

    async function count(tenantId: string): Promise<number> {
      let total = 0;
      for (const table of [
        'sessions',
        'users_cli_auth_requests',
        'memberships',
        'groups',
        'roles',
        'resource_grants',
        'tenant_permission_overrides',
        'tenant_guest_grants',
      ]) {
        const r = rowsOf(
          await db.query(
            `SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ${usePglite ? '$1' : '$1'}`,
            [tenantId],
          ),
        );
        total += Number(r[0].n);
      }
      return total;
    }

    it('removes sessions, invitations, groups, roles and grants with the tenant', async () => {
      const service = new TenantService(options, {
        mode: 'flexible',
        maxTenants: 0,
        defaultName: 'x',
      });
      await service.initialize();
      const { userId, tenantId } = await ownedTenant(service, 'doomed');
      await populate(userId, tenantId);
      const kept = await ownedTenant(service, 'kept');
      await populate(kept.userId, kept.tenantId);
      expect(await count(tenantId)).toBeGreaterThan(8);

      await service.deleteTenant(userId, tenantId);

      expect(await tenants.get({ id: tenantId })).toBeFalsy();
      expect(await count(tenantId)).toBe(0);
      expect(await count(kept.tenantId)).toBeGreaterThan(8);
      expect(await tenants.get({ id: kept.tenantId })).toBeTruthy();
    });

    it('rolls everything back when a dependent cannot be removed', async () => {
      const service = new TenantService(options, {
        mode: 'flexible',
        maxTenants: 0,
        defaultName: 'x',
      });
      await service.initialize();
      const { userId, tenantId } = await ownedTenant(service, 'atomic');
      await populate(userId, tenantId);
      // A child tenant makes the delete refuse after nothing was removed;
      // a role referenced from ANOTHER tenant's membership makes it fail
      // mid-way, after sessions, groups and grants were already deleted.
      const outsider = await ownedTenant(service, 'outsider');
      const role = (
        await (await RoleCollection.create(options)).findTenantRoles(tenantId)
      )[0];
      await (
        await (
          await MembershipCollection.create(options)
        ).create({
          userId: outsider.userId,
          tenantId: outsider.tenantId,
          roleId: role.id as string,
        })
      ).save();
      const before = await count(tenantId);

      await expect(service.deleteTenant(userId, tenantId)).rejects.toThrow();

      expect(await count(tenantId)).toBe(before);
      expect(await tenants.get({ id: tenantId })).toBeTruthy();
    });
  });
});
