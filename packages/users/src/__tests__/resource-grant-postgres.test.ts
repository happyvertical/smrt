import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { MembershipCollection } from '../collections/MembershipCollection.js';
import { PermissionCollection } from '../collections/PermissionCollection.js';
import { ResourceGrantCollection } from '../collections/ResourceGrantCollection.js';
import { RoleCollection } from '../collections/RoleCollection.js';
import { RolePermissionCollection } from '../collections/RolePermissionCollection.js';
import { TenantCollection } from '../collections/TenantCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import {
  checkResourceOperationPermission,
  ResourceGrantService,
  syncPermissionCatalog,
} from '../services/index.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

describePostgres('ResourceGrant persistence on PostgreSQL', () => {
  let isolated: IsolatedTestDbResult | undefined;

  afterEach(async () => {
    await isolated?.cleanup();
    isolated = undefined;
  });

  it('persists a service grant and makes revocation effective', async () => {
    // Use the fixture's already initialized adapter. Passing its config would
    // invoke a second global schema sync and bypass this test's migration path.
    isolated = await createIsolatedTestDbFromManifest();
    if (isolated.config.type !== 'postgres')
      throw new Error('Expected a PostgreSQL test database.');
    const options = { db: isolated.db };
    const users = await UserCollection.create(options);
    const tenants = await TenantCollection.create(options);
    const roles = await RoleCollection.create(options);
    const memberships = await MembershipCollection.create(options);
    const permissions = await PermissionCollection.create(options);
    const rolePermissions = await RolePermissionCollection.create(options);
    const grants = await ResourceGrantCollection.create(options);
    await syncPermissionCatalog(options);
    const user = await users.create({
      email: 'resource-grant-postgres@example.com',
    });
    const tenant = await tenants.create({ name: 'Resource grants PostgreSQL' });
    const role = await roles.create({
      name: 'Grant admin',
      slug: 'grant-admin',
    });
    await user.save();
    await tenant.save();
    await role.save();
    if (!user.id || !tenant.id || !role.id)
      throw new Error('Expected persisted PostgreSQL fixture ids.');
    const permission = await permissions.findBySlug('users.create');
    if (!permission?.id)
      throw new Error('Expected users.create catalog permission.');
    await rolePermissions.addPermission(role.id, permission.id);
    await (
      await memberships.create({
        roleId: role.id,
        tenantId: tenant.id,
        userId: user.id,
      })
    ).save();
    const actor = {
      ...options,
      collection: 'users',
      action: 'create',
      tenantId: tenant.id,
      userId: user.id,
    };
    const resource = {
      tenantId: tenant.id,
      resourceType: 'construction-project',
      resourceId: 'project-a',
    };
    const service = new ResourceGrantService(options);
    const grant = await service.create({
      actor,
      authorization: { ...actor, resource, verifyResource: () => true },
      grant: {
        ...resource,
        userId: user.id,
        permission: 'users.create',
        canDelegate: true,
      },
    });
    if (!grant.id) throw new Error('Expected persisted resource grant id.');
    expect(await grants.get({ id: grant.id })).toMatchObject({
      canDelegate: true,
      resourceId: 'project-a',
    });
    await expect(
      checkResourceOperationPermission({
        ...actor,
        resource,
        verifyResource: () => true,
      }),
    ).resolves.toMatchObject({ allowed: true });
    await service.revoke(grant.id, { actor, verifyResource: () => true });
    await expect(
      checkResourceOperationPermission({
        ...actor,
        resource,
        verifyResource: () => true,
      }),
    ).resolves.toMatchObject({
      allowed: false,
      reason: 'resource_grant_missing',
    });
  });
});
