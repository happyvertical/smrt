/**
 * smrt#3048: a caller's list bounds must never truncate a framework-internal
 * authorization read, on real PostgreSQL with the smrt-tenancy interceptor on.
 *
 * `SmrtCollection.create()` forwards `defaultListLimit`/`maxListLimit` from
 * whatever options bag it is handed (#2367). Before this fix,
 * `checkResourceOperationPermission()` built its ResourceGrant collection from
 * the caller's options, so a bounded bag (for example a bounded collection's
 * own options) truncated the exact-tuple read before the DENY-wins scan: a
 * DENY row past the bound was dropped while a GRANT was kept, widening the
 * decision. `TenantService.canCreateTenant()` had the same shape: a truncated
 * owned-membership count let a user exceed `maxTenants`.
 *
 * Every assertion runs as a NON-super-admin principal.
 */

import type { SmrtCollectionOptions } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  registerTenantScopedClass,
  unregisterTenantScopedClass,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MembershipCollection } from '../collections/MembershipCollection.js';
import { ResourceGrantCollection } from '../collections/ResourceGrantCollection.js';
import { RoleCollection } from '../collections/RoleCollection.js';
import { TenantCollection } from '../collections/TenantCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import type { ResourceGrantEffect } from '../models/ResourceGrant.js';
import { checkResourceOperationPermission } from '../services/ResourceGrantService.js';
import { TenantService } from '../services/TenantService.js';
import { DEFAULT_ROLE_SLUGS, MembershipStatus } from '../types/index.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

/** The anytown registration shape from #3036. */
const TENANT_SCOPED = {
  field: 'tenantId',
  mode: 'required',
  autoFilter: true,
  allowSuperAdminBypass: true,
} as const;
const REGISTERED = ['TenantPermissionOverride', 'Membership'] as const;

/** Smaller than the number of same-tuple rows each scenario writes. */
const BOUND = 2;

describePostgres(
  'smrt#3048: caller list bounds never truncate authorization reads (PostgreSQL, tenancy on)',
  () => {
    let isolated: IsolatedTestDbResult | undefined;
    let options: SmrtCollectionOptions;
    let bounded: SmrtCollectionOptions;
    let tenants: TenantCollection;
    let users: UserCollection;
    let roles: RoleCollection;
    let memberships: MembershipCollection;
    let grants: ResourceGrantCollection;

    beforeEach(async () => {
      isolated = await createIsolatedTestDbFromManifest();
      if (isolated.config.type !== 'postgres') {
        throw new Error('Expected a PostgreSQL test database.');
      }
      options = { db: isolated.db };
      bounded = { ...options, defaultListLimit: BOUND, maxListLimit: BOUND };
      tenants = await TenantCollection.create(options);
      users = await UserCollection.create(options);
      roles = await RoleCollection.create(options);
      memberships = await MembershipCollection.create(options);
      grants = await ResourceGrantCollection.create(options);
      await roles.seedSystemRoles({ seedPermissions: true });
    });

    afterEach(async () => {
      disableTenancy();
      for (const className of REGISTERED) {
        unregisterTenantScopedClass(className);
      }
      await isolated?.cleanup();
      isolated = undefined;
    });

    function turnTenancyOn() {
      for (const className of REGISTERED) {
        registerTenantScopedClass(className, { ...TENANT_SCOPED });
      }
      enableTenancy();
    }

    async function memberPrincipal(email: string) {
      const tenant = await tenants.create({ name: `Tenant for ${email}` });
      await tenant.save();
      const role = await roles.findSystemRoleBySlug(DEFAULT_ROLE_SLUGS.MEMBER);
      if (!role?.id) throw new Error('Missing seeded member role.');
      const user = await users.create({ email });
      await user.save();
      await (
        await memberships.create({
          userId: user.id,
          tenantId: tenant.id,
          roleId: role.id,
          status: MembershipStatus.ACTIVE,
        })
      ).save();
      return { tenantId: tenant.id as string, userId: user.id as string };
    }

    const RESOURCE = {
      resourceType: 'construction-project',
      resourceId: 'project-3048',
    };

    /** Write same-tuple grant rows in order (insertion order = heap order). */
    async function writeGrants(
      principal: { tenantId: string; userId: string },
      effects: ResourceGrantEffect[],
    ) {
      await withTenant({ tenantId: principal.tenantId }, async () => {
        for (const effect of effects) {
          await (
            await grants.create({
              ...RESOURCE,
              tenantId: principal.tenantId,
              userId: principal.userId,
              permission: 'tenants.read',
              effect,
            })
          ).save();
        }
      });
    }

    function check(
      principal: { tenantId: string; userId: string },
      callerOptions: SmrtCollectionOptions,
    ) {
      const resource = { ...RESOURCE, tenantId: principal.tenantId };
      return withTenant(principal, () =>
        checkResourceOperationPermission({
          ...callerOptions,
          collection: 'tenants',
          action: 'read',
          tenantId: principal.tenantId,
          userId: principal.userId,
          resource,
          verifyResource: () => true,
        }),
      );
    }

    it('a DENY past the caller bound still denies', async () => {
      const principal = await memberPrincipal('deny-past-bound@example.com');
      // BOUND + 1 grants written first, the DENY last: a truncated read keeps
      // only grants.
      await writeGrants(principal, [
        ...Array.from({ length: BOUND + 1 }, () => 'grant' as const),
        'deny',
      ]);
      turnTenancyOn();

      const unbounded = await check(principal, options);
      expect(unbounded).toMatchObject({
        allowed: false,
        reason: 'resource_grant_denied',
      });
      const decision = await check(principal, bounded);
      expect(decision).toMatchObject({
        allowed: false,
        reason: 'resource_grant_denied',
      });
      expect(decision.grant?.effect).toBe('deny');
    });

    it('allow-only grants still allow under a caller bound', async () => {
      const principal = await memberPrincipal('allow-only@example.com');
      await writeGrants(
        principal,
        Array.from({ length: BOUND + 1 }, () => 'grant' as const),
      );
      turnTenancyOn();

      for (const callerOptions of [options, bounded]) {
        const decision = await check(principal, callerOptions);
        expect(decision).toMatchObject({
          allowed: true,
          reason: 'resource_grant_allowed',
        });
        expect(decision.grant?.effect).toBe('grant');
      }
    });

    it('a missing grant stays missing under a caller bound', async () => {
      const principal = await memberPrincipal('missing@example.com');
      turnTenancyOn();

      for (const callerOptions of [options, bounded]) {
        await expect(check(principal, callerOptions)).resolves.toEqual({
          allowed: false,
          reason: 'resource_grant_missing',
        });
      }
    });

    it('TenantService counts every owned tenant against maxTenants', async () => {
      const owner = await roles.findSystemRoleBySlug(DEFAULT_ROLE_SLUGS.OWNER);
      if (!owner?.id) throw new Error('Missing seeded owner role.');
      const user = await users.create({ email: 'tenant-quota@example.com' });
      await user.save();
      const maxTenants = BOUND + 1;
      for (let index = 0; index < maxTenants; index++) {
        const tenant = await tenants.create({ name: `Quota ${index}` });
        await tenant.save();
        await (
          await memberships.create({
            userId: user.id,
            tenantId: tenant.id,
            roleId: owner.id,
            status: MembershipStatus.ACTIVE,
          })
        ).save();
      }
      const policy = {
        mode: 'flexible',
        maxTenants,
        defaultName: 'Workspace',
      } as const;

      for (const callerOptions of [options, bounded]) {
        const service = await TenantService.create(callerOptions, policy);
        expect(await service.canCreateTenant(user.id as string)).toBe(false);
        await expect(
          service.createTenantWithOwnership(user.id as string, 'One too many'),
        ).rejects.toThrow(/maximum tenant limit/);
        expect(await service.getOwnedTenants(user.id as string)).toHaveLength(
          maxTenants,
        );
      }
    });
  },
);
