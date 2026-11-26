import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GlobalInterceptors } from '@happyvertical/smrt-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../models/index.js';
import { MembershipCollection } from '../collections/MembershipCollection.js';
import { PermissionCollection } from '../collections/PermissionCollection.js';
import { RoleCollection } from '../collections/RoleCollection.js';
import { RolePermissionCollection } from '../collections/RolePermissionCollection.js';
import { TenantCollection } from '../collections/TenantCollection.js';
import { TenantGuestGrantCollection } from '../collections/TenantGuestGrantCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import {
  isStorableGuestPermissionSlug,
  OperationPermissionError,
  syncPermissionCatalog,
  TenantGuestGrantService,
  TenantService,
} from '../services/index.js';
import { DEFAULT_ROLE_SLUGS } from '../types/index.js';

describe('TenantGuestGrantService (#5196)', () => {
  let dbPath: string;
  let options: { db: { type: 'sqlite'; url: string } };
  let tenants: TenantCollection;
  let grants: TenantGuestGrantCollection;
  let service: TenantGuestGrantService;

  async function makeTenant(): Promise<string> {
    const tenant = await tenants.create({
      name: `T ${randomUUID()}`,
      slug: `t-${randomUUID()}`,
    });
    await tenant.save();
    return tenant.id as string;
  }

  /** A user holding `slugs` through a role in exactly `tenantId`. */
  async function makeActor(
    tenantId: string,
    slugs: string[],
    existingUserId?: string,
  ): Promise<string> {
    const users = await UserCollection.create(options);
    const roles = await RoleCollection.create(options);
    const permissions = await PermissionCollection.create(options);
    const rolePermissions = await RolePermissionCollection.create(options);
    const memberships = await MembershipCollection.create(options);
    let userId = existingUserId;
    if (!userId) {
      const user = await users.create({
        email: `guest-grant-${randomUUID()}@example.com`,
      });
      await user.save();
      userId = user.id as string;
    }
    const role = await roles.create({
      name: `Role ${randomUUID()}`,
      slug: `role-${randomUUID()}`,
    });
    await role.save();
    for (const slug of slugs) {
      const permission = await permissions.findBySlug(slug);
      if (!permission?.id) throw new Error(`missing permission ${slug}`);
      await rolePermissions.addPermission(role.id as string, permission.id);
    }
    const membership = await memberships.create({
      roleId: role.id as string,
      tenantId,
      userId,
    });
    await membership.save();
    return userId;
  }

  const asActor = (userId: string) => ({
    userId,
    allowSystemContextBypass: false,
    allowSuperAdminBypass: false,
  });

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-guest-grant-svc-${randomUUID()}.db`);
    options = { db: { type: 'sqlite', url: dbPath } };
    await syncPermissionCatalog(options);
    tenants = await TenantCollection.create(options);
    grants = await TenantGuestGrantCollection.create(options);
    service = new TenantGuestGrantService(options);
  });

  afterEach(() => {
    GlobalInterceptors.clear();
    if (existsSync(dbPath)) rmSync(dbPath, { force: true });
  });

  it('grants, lists, and revokes; grant is idempotent', async () => {
    const tenantId = await makeTenant();
    const userId = await makeActor(tenantId, [
      'tenantguestgrants.create',
      'tenantguestgrants.delete',
      'tenantguestgrants.read',
    ]);
    const actor = asActor(userId);

    const first = await service.grant(tenantId, 'products.read', actor);
    const again = await service.grant(tenantId, 'products.read', actor);
    await service.grant(tenantId, 'forms.create', actor);
    expect(again.id).toBe(first.id);
    expect(first.grantedBy).toBe(userId);
    expect(
      (await service.list(tenantId, actor)).map((g) => g.permissionSlug).sort(),
    ).toEqual(['forms.create', 'products.read']);

    expect(await service.revoke(tenantId, 'products.read', actor)).toBe(true);
    expect(await service.revoke(tenantId, 'products.read', actor)).toBe(false);
    expect(await grants.getGrantedSlugs(tenantId)).toEqual(['forms.create']);
  });

  it('denies a caller lacking permission on THAT tenant even if they manage another', async () => {
    const own = await makeTenant();
    const other = await makeTenant();
    const userId = await makeActor(own, [
      'tenantguestgrants.create',
      'tenantguestgrants.delete',
    ]);
    // Member of `other` with no grant authority there.
    await makeActor(other, [], userId);

    await expect(
      service.grant(other, 'products.read', asActor(userId)),
    ).rejects.toBeInstanceOf(OperationPermissionError);
    expect(await grants.findByTenant(other)).toEqual([]);

    await service.grant(own, 'products.read', asActor(userId));
    await expect(
      service.revoke(other, 'products.read', asActor(userId)),
    ).rejects.toBeInstanceOf(OperationPermissionError);
  });

  it('rejects slugs other than <collection>.read / <collection>.create', async () => {
    const tenantId = await makeTenant();
    const userId = await makeActor(tenantId, ['tenantguestgrants.create']);
    for (const slug of [
      'products.update',
      'products.delete',
      'products.manage',
      'products',
      '*',
      '*.read',
      'products.read ',
      '',
    ]) {
      await expect(
        service.grant(tenantId, slug, asActor(userId)),
      ).rejects.toThrow(/accept only/);
    }
    expect(await grants.findByTenant(tenantId)).toEqual([]);
    expect(isStorableGuestPermissionSlug('products.read')).toBe(true);
    expect(isStorableGuestPermissionSlug('products.create')).toBe(true);
  });

  describe('deleteTenant', () => {
    async function ownerSetup() {
      const tenantService = new TenantService(options, {
        mode: 'flexible',
        maxTenants: 0,
        defaultName: 'x',
      });
      await tenantService.initialize();
      const users = await UserCollection.create(options);
      const user = await users.create({
        email: `owner-${randomUUID()}@example.com`,
      });
      await user.save();
      const { tenant } = await tenantService.createTenantWithOwnership(
        user.id as string,
        'Doomed',
        { slug: `doomed-${randomUUID()}` },
      );
      expect(DEFAULT_ROLE_SLUGS.OWNER).toBeTruthy();
      return {
        tenantService,
        userId: user.id as string,
        tenantId: tenant.id as string,
      };
    }

    it('removes the tenant and its grants together', async () => {
      const { tenantService, userId, tenantId } = await ownerSetup();
      await grants.create({ tenantId, permissionSlug: 'products.read' });
      await grants.create({ tenantId, permissionSlug: 'forms.create' });
      const keptTenant = await makeTenant();
      await grants.create({
        tenantId: keptTenant,
        permissionSlug: 'products.read',
      });

      await tenantService.deleteTenant(userId, tenantId);

      expect(await tenants.get({ id: tenantId })).toBeFalsy();
      expect(await grants.findByTenant(tenantId)).toEqual([]);
      expect(await grants.findByTenant(keptTenant)).toHaveLength(1);
    });

    it('rolls the grant removal back when the tenant delete fails', async () => {
      const { tenantService, userId, tenantId } = await ownerSetup();
      await grants.create({ tenantId, permissionSlug: 'products.read' });

      GlobalInterceptors.register({
        name: 'fail-tenant-delete',
        beforeDelete(instance) {
          if ((instance as { id?: string }).id === tenantId) {
            throw new Error('injected tenant delete failure');
          }
        },
      });

      await expect(
        tenantService.deleteTenant(userId, tenantId),
      ).rejects.toThrow();
      GlobalInterceptors.clear();

      expect(await tenants.get({ id: tenantId })).toBeTruthy();
      expect(await grants.getGrantedSlugs(tenantId)).toEqual(['products.read']);
    });
  });
});
