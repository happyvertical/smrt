/**
 * smrt#3047: permission resolution cost and equivalence, on real PostgreSQL
 * with the smrt-tenancy interceptor on.
 *
 * The report: `resolvePermissions()` for an owner holding ~4,895 permissions
 * spent ~880 ms of CPU hydrating ~9,800 `RolePermission`/`Permission` objects
 * (each re-running manifest discovery) while the database did almost nothing.
 *
 * Two contracts are pinned here:
 *
 * 1. WORK — resolving a ~5,000-permission owner hydrates a bounded number of
 *    SmrtObject instances (not one per permission) and stays inside a generous
 *    wall-clock budget.
 * 2. EQUIVALENCE — a scenario matrix covering direct roles, inheritsToDescendants
 *    (#3036), the tenant override cascade, group roles, membership overrides,
 *    the declared ancestor-read policy (#2939) and resource-scoped grants
 *    (#3024) resolves to the golden snapshot recorded against the pre-#3047
 *    (hydrating) resolver. The snapshot stores ids as fixture labels and large
 *    slug sets as count + digest, so it is stable across runs.
 *
 * Every assertion runs as a NON-super-admin principal.
 */

import { SmrtObject } from '@happyvertical/smrt-core';
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GroupCollection } from '../collections/GroupCollection.js';
import { GroupMemberCollection } from '../collections/GroupMemberCollection.js';
import { GroupRoleCollection } from '../collections/GroupRoleCollection.js';
import { MembershipCollection } from '../collections/MembershipCollection.js';
import { MembershipOverrideCollection } from '../collections/MembershipOverrideCollection.js';
import { PermissionCollection } from '../collections/PermissionCollection.js';
import { ResourceGrantCollection } from '../collections/ResourceGrantCollection.js';
import { RoleCollection } from '../collections/RoleCollection.js';
import { RolePermissionCollection } from '../collections/RolePermissionCollection.js';
import { TenantCollection } from '../collections/TenantCollection.js';
import { TenantPermissionOverrideCollection } from '../collections/TenantPermissionOverrideCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import type { Tenant } from '../models/Tenant.js';
import type { AncestorReadPolicy } from '../services/AncestorReadPolicy.js';
import {
  type PermissionResolutionResult,
  PermissionResolver,
} from '../services/PermissionResolver.js';
import { checkResourceOperationPermission } from '../services/ResourceGrantService.js';
import {
  MembershipStatus,
  OverrideEffect,
  TenantPermissionEffect,
} from '../types/index.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

/** The anytown registration shape from #3036. */
const TENANT_SCOPED = {
  field: 'tenantId',
  mode: 'required',
  autoFilter: true,
  allowSuperAdminBypass: true,
} as const;
const REGISTERED = ['TenantPermissionOverride', 'Membership'] as const;

const POLICY: AncestorReadPolicy = {
  roles: ['owner', 'admin', 'member', 'viewer'],
  collections: ['tenants'],
  maxDepth: 1,
};

/** Catalog size of the #3047 report (4,895) rounded up. */
const SYNTHETIC_CATALOG_SIZE = 5_000;

function turnTenancyOn() {
  for (const className of REGISTERED) {
    registerTenantScopedClass(className, { ...TENANT_SCOPED });
  }
  enableTenancy();
}

function turnTenancyOff() {
  disableTenancy();
  for (const className of REGISTERED) {
    unregisterTenantScopedClass(className);
  }
}

/**
 * Stable rendering of a slug set for the golden snapshot.
 *
 * The manifest-derived catalog depends on every manifest loaded into the
 * test process (other packages' test manifests included), so a raw digest
 * would drift with the environment. The snapshot therefore pins the exact
 * CRUD slugs of the identity/RBAC resources the fixture exercises, and
 * classifies everything else against the live catalog as none/some/all.
 * The exact, full-catalog comparison lives in the primitive-equivalence test.
 */
const CORE_RESOURCES = new Set([
  'tenants',
  'users',
  'roles',
  'permissions',
  'memberships',
  'groups',
  'rolepermissions',
  'resourcegrants',
]);
const CORE_ACTIONS = new Set(['read', 'create', 'update', 'delete']);

function isCoreSlug(slug: string): boolean {
  const [resource, action, ...rest] = slug.split('.');
  return (
    rest.length === 0 &&
    CORE_RESOURCES.has(resource ?? '') &&
    CORE_ACTIONS.has(action ?? '')
  );
}

function describeSlugs(slugs: Iterable<string>, catalog: Set<string>) {
  const all = [...slugs];
  const outside = all.filter((slug) => !isCoreSlug(slug));
  const catalogOutside = [...catalog].filter((slug) => !isCoreSlug(slug));
  let outsideCore: 'none' | 'some' | 'all' = 'some';
  if (outside.length === 0) {
    outsideCore = 'none';
  } else if (
    outside.length === catalogOutside.length &&
    outside.every((slug) => catalog.has(slug))
  ) {
    outsideCore = 'all';
  }
  return { core: all.filter(isCoreSlug).sort(), outsideCore };
}

describePostgres(
  'smrt#3047: permission resolution cost and equivalence',
  () => {
    let isolated: IsolatedTestDbResult | undefined;
    let options: { db: IsolatedTestDbResult['db'] };
    let tenants: TenantCollection;
    let users: UserCollection;
    let roles: RoleCollection;
    let memberships: MembershipCollection;
    let permissions: PermissionCollection;
    let rolePermissions: RolePermissionCollection;
    let tenantOverrides: TenantPermissionOverrideCollection;
    let membershipOverrides: MembershipOverrideCollection;
    let groups: GroupCollection;
    let groupMembers: GroupMemberCollection;
    let groupRoles: GroupRoleCollection;

    beforeEach(async () => {
      isolated = await createIsolatedTestDbFromManifest();
      if (isolated.config.type !== 'postgres') {
        throw new Error('Expected a PostgreSQL test database.');
      }
      options = { db: isolated.db };
      tenants = await TenantCollection.create(options);
      users = await UserCollection.create(options);
      roles = await RoleCollection.create(options);
      memberships = await MembershipCollection.create(options);
      permissions = await PermissionCollection.create(options);
      rolePermissions = await RolePermissionCollection.create(options);
      tenantOverrides =
        await TenantPermissionOverrideCollection.create(options);
      membershipOverrides = await MembershipOverrideCollection.create(options);
      groups = await GroupCollection.create(options);
      groupMembers = await GroupMemberCollection.create(options);
      groupRoles = await GroupRoleCollection.create(options);

      await roles.seedSystemRoles({
        inheritsToDescendants: ['owner', 'admin'],
        seedPermissions: true,
      });
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      turnTenancyOff();
      await isolated?.cleanup();
      isolated = undefined;
    });

    async function systemRoleId(slug: string): Promise<string> {
      const role = await roles.findSystemRoleBySlug(slug);
      if (!role?.id) throw new Error(`Missing seeded system role ${slug}`);
      return role.id;
    }

    async function permissionId(slug: string): Promise<string> {
      const permission = await permissions.findBySlug(slug);
      if (!permission?.id) throw new Error(`Catalog lacks ${slug}`);
      return permission.id;
    }

    async function addMember(
      tenant: Tenant,
      roleId: string,
      email: string,
      status: MembershipStatus = MembershipStatus.ACTIVE,
    ) {
      const user = await users.create({ email });
      await user.save();
      const membership = await memberships.create({
        userId: user.id,
        tenantId: tenant.id,
        roleId,
        status,
      });
      await membership.save();
      return {
        userId: user.id as string,
        membershipId: membership.id as string,
      };
    }

    /**
     * Grow the owner role to the reported catalog size with raw SQL (the
     * fixture's cost is not what is being measured).
     */
    async function growOwnerCatalog(): Promise<number> {
      const db = isolated?.db;
      if (!db) throw new Error('Expected the isolated PostgreSQL database.');
      const ownerId = await systemRoleId('owner');
      const existing = await db.query(
        'SELECT COUNT(*)::int AS n FROM role_permissions WHERE role_id = ?',
        ownerId,
      );
      const missing = SYNTHETIC_CATALOG_SIZE - Number(existing.rows[0]?.n ?? 0);
      await db.query(
        `INSERT INTO permissions (id, slug, context, name, description, category)
       SELECT gen_random_uuid(),
              'bench' || lpad(g::text, 4, '0') || '.read',
              '',
              'Bench ' || g,
              '',
              'bench-3047'
         FROM generate_series(1, ?::int) AS g`,
        missing,
      );
      await db.query(
        `INSERT INTO role_permissions (id, slug, context, role_id, permission_id)
       SELECT gen_random_uuid(), gen_random_uuid()::text, '', ?::uuid, p.id
         FROM permissions p
        WHERE p.category = 'bench-3047'`,
        ownerId,
      );
      return SYNTHETIC_CATALOG_SIZE;
    }

    it('resolves a 5,000-permission owner without per-permission hydration', async () => {
      const network = await tenants.create({ name: 'Bench network' });
      const site = await tenants.createChild(network.id as string, {
        name: 'Bench site',
      });
      const expected = await growOwnerCatalog();
      const { userId } = await addMember(
        network,
        await systemRoleId('owner'),
        'bench-owner@example.com',
      );
      turnTenancyOn();
      const resolver = await PermissionResolver.create(options);
      const resolve = () =>
        withTenant({ tenantId: site.id as string, userId }, () =>
          resolver.resolvePermissions(userId, site.id as string),
        );

      // Warm once (first-touch manifest/registry work is legitimately one-off).
      const warm = await resolve();
      expect(warm.permissions.size).toBe(expected);
      expect(warm.inheritedFromTenantId).toBe(network.id);

      const initialize = vi.spyOn(SmrtObject.prototype, 'initialize');
      const timings: number[] = [];
      for (let run = 0; run < 3; run++) {
        const started = performance.now();
        const result = await resolve();
        timings.push(performance.now() - started);
        expect(result.permissions.size).toBe(expected);
      }
      const hydratedPerResolution = initialize.mock.calls.length / 3;
      const best = Math.min(...timings);
      // Surface the measurement in CI logs for regression triage.
      console.info(
        `[smrt#3047] owner resolution over ${expected} permissions: ` +
          `best ${best.toFixed(1)} ms (runs ${timings.map((t) => t.toFixed(1)).join(', ')}), ` +
          `${hydratedPerResolution} SmrtObject hydrations per resolution`,
      );

      // Work guard: hydration is bounded by memberships/tenants/roles, never by
      // the size of the permission catalog. (Pre-#3047: ~2 per permission.)
      expect(hydratedPerResolution).toBeLessThan(50);
      // Generous wall-clock budget (the target is well under 50 ms; shared CI
      // runners get 5x headroom). Pre-#3047 this took ~900 ms.
      expect(best).toBeLessThan(250);
    });

    it('projection reads return exactly what the hydrating reads returned', async () => {
      const tenant = await tenants.create({ name: 'Primitive site' });
      await growOwnerCatalog();
      const custom = await roles.create({
        name: 'Primitive custom',
        slug: 'primitive-custom',
        tenantId: tenant.id,
      });
      await custom.save();
      await rolePermissions.addPermission(
        custom.id as string,
        await permissionId('tenants.read'),
      );
      const roleIds = [
        await systemRoleId('owner'),
        await systemRoleId('admin'),
        await systemRoleId('member'),
        await systemRoleId('viewer'),
        custom.id as string,
      ];

      const principals = new Map<string, string>();
      for (const roleId of roleIds) {
        const { userId } = await addMember(
          tenant,
          roleId,
          `primitive-${roleId}@example.com`,
        );
        principals.set(roleId, userId);
      }

      turnTenancyOn();
      const resolver = await PermissionResolver.create(options);
      for (const roleId of roleIds) {
        // Role -> permission ids: projection vs the hydrated RolePermission rows.
        const projected = await rolePermissions.getPermissionIds(roleId);
        const hydrated = (await rolePermissions.findByRole(roleId)).map(
          (row) => row.permissionId as string,
        );
        expect([...projected].sort()).toEqual([...hydrated].sort());

        // Ids -> slugs: the resolver's projection vs hydrated Permission rows,
        // observed through a membership holding exactly this role (the tenant
        // has no overrides, so the resolved set is the role's slugs).
        const expected = new Set<string>();
        for (const permission of (
          await permissions.findByIds(hydrated)
        ).values()) {
          if (permission.slug) expected.add(permission.slug);
        }
        const userId = principals.get(roleId) as string;
        const resolved = await withTenant(
          { tenantId: tenant.id as string, userId },
          () => resolver.resolvePermissions(userId, tenant.id as string),
        );
        expect(resolved.permissions.size).toBeGreaterThan(0);
        expect([...resolved.permissions].sort()).toEqual([...expected].sort());
      }
    });

    it('resolves the scenario matrix exactly as the pre-#3047 resolver did', async () => {
      const labels = new Map<string, string>();
      const label = (id: string | null | undefined) =>
        id ? (labels.get(id) ?? `unlabelled:${id}`) : null;

      // network (root) -> publication -> desk; sibling is publication's peer.
      const network = await tenants.create({ name: 'Network Root' });
      const publication = await tenants.createChild(network.id as string, {
        name: 'Eckville Echo',
      });
      const sibling = await tenants.createChild(network.id as string, {
        name: 'Lacombe Globe',
      });
      const desk = await tenants.createChild(publication.id as string, {
        name: 'Sports Desk',
      });
      for (const [name, tenant] of Object.entries({
        network,
        publication,
        sibling,
        desk,
      })) {
        labels.set(tenant.id as string, `tenant:${name}`);
      }

      const owner = await systemRoleId('owner');
      const admin = await systemRoleId('admin');
      const member = await systemRoleId('member');
      const viewer = await systemRoleId('viewer');

      // A tenant-scoped custom role reached only through a group.
      const editor = await roles.create({
        name: 'Desk editor',
        slug: 'desk-editor',
        tenantId: desk.id,
      });
      await editor.save();
      for (const slug of ['tenants.update', 'users.read', 'roles.read']) {
        await rolePermissions.addPermission(
          editor.id as string,
          await permissionId(slug),
        );
      }

      const principals = {
        ownerAtPublication: await addMember(
          publication,
          owner,
          'owner-pub@example.com',
        ),
        adminAtNetwork: await addMember(
          network,
          admin,
          'admin-net@example.com',
        ),
        memberAtPublication: await addMember(
          publication,
          member,
          'member-pub@example.com',
        ),
        viewerAtDesk: await addMember(desk, viewer, 'viewer-desk@example.com'),
        memberAtNetwork: await addMember(
          network,
          member,
          'member-net@example.com',
        ),
        inactiveAtDesk: await addMember(
          desk,
          viewer,
          'inactive-desk@example.com',
          MembershipStatus.INACTIVE,
        ),
        groupedAtDesk: await addMember(
          desk,
          viewer,
          'grouped-desk@example.com',
        ),
      };
      // The inactive desk principal also holds inheriting authority above it:
      // the direct inactive membership must pin resolution to empty.
      const inactiveUser = principals.inactiveAtDesk.userId;
      await (
        await memberships.create({
          userId: inactiveUser,
          tenantId: network.id,
          roleId: owner,
          status: MembershipStatus.ACTIVE,
        })
      ).save();

      // Group role: the grouped principal gets desk-editor through a desk group.
      const group = await groups.create({
        tenantId: desk.id,
        name: 'Editors',
        slug: 'editors',
      });
      await group.save();
      await groupMembers.addMember(
        group.id as string,
        principals.groupedAtDesk.userId,
      );
      await groupRoles.addRole(group.id as string, editor.id as string);

      // Tenant cascade: the network DENYs tenants.delete and roles.read for
      // every inheriting descendant; the publication GRANTs users.create back
      // in; the desk DENYs users.read (which the group role grants).
      await tenantOverrides.setOverride(
        network.id as string,
        await permissionId('tenants.delete'),
        TenantPermissionEffect.DENY,
      );
      await tenantOverrides.setOverride(
        network.id as string,
        await permissionId('roles.read'),
        TenantPermissionEffect.DENY,
      );
      await tenantOverrides.setOverride(
        publication.id as string,
        await permissionId('users.create'),
        TenantPermissionEffect.GRANT,
      );
      await tenantOverrides.setOverride(
        desk.id as string,
        await permissionId('users.read'),
        TenantPermissionEffect.DENY,
      );
      await tenantOverrides.setOverride(
        desk.id as string,
        await permissionId('tenants.update'),
        TenantPermissionEffect.DENY,
      );

      // Membership overrides: the publication member re-adds a tenant-denied
      // slug and loses one of its role grants.
      await membershipOverrides.setOverride(
        principals.memberAtPublication.membershipId,
        await permissionId('roles.read'),
        OverrideEffect.GRANT,
      );
      await membershipOverrides.setOverride(
        principals.memberAtPublication.membershipId,
        await permissionId('tenants.read'),
        OverrideEffect.DENY,
      );
      // ...and the grouped desk principal re-grants the desk-denied slug.
      await membershipOverrides.setOverride(
        principals.groupedAtDesk.membershipId,
        await permissionId('tenants.update'),
        OverrideEffect.GRANT,
      );

      const permissionSlugById = new Map<string, string>();
      for (const permission of await permissions.list({})) {
        if (permission.id && permission.slug) {
          permissionSlugById.set(permission.id, permission.slug);
        }
      }

      function render(result: PermissionResolutionResult) {
        return {
          permissions: describeSlugs(
            result.permissions,
            new Set(permissionSlugById.values()),
          ),
          hasMembership: result.membershipId !== null,
          role: result.roleId === null ? null : 'set',
          groups: result.groupIds.length,
          deniedPermissions: result.deniedPermissionIds
            .map((id) => permissionSlugById.get(id) ?? `unknown:${id}`)
            .sort(),
          inheritedFrom: label(result.inheritedFromTenantId),
          ancestorReadFrom: result.ancestorReadFromTenantIds
            .map((id) => label(id))
            .sort(),
        };
      }

      turnTenancyOn();
      const plain = await PermissionResolver.create(options);
      const withPolicy = await PermissionResolver.create(options, {
        ancestorReadPolicy: POLICY,
      });

      const cases: Array<
        [string, PermissionResolver, keyof typeof principals, Tenant]
      > = [
        ['owner direct', plain, 'ownerAtPublication', publication],
        ['owner direct, other tenant', plain, 'ownerAtPublication', sibling],
        ['admin inherited two hops', plain, 'adminAtNetwork', desk],
        ['admin inherited one hop', plain, 'adminAtNetwork', sibling],
        ['admin at own root', plain, 'adminAtNetwork', network],
        [
          'member direct with overrides',
          plain,
          'memberAtPublication',
          publication,
        ],
        ['member does not inherit', plain, 'memberAtNetwork', publication],
        ['viewer direct under cascade', plain, 'viewerAtDesk', desk],
        ['inactive direct pins empty', plain, 'inactiveAtDesk', desk],
        [
          'inactive user inherits elsewhere',
          plain,
          'inactiveAtDesk',
          publication,
        ],
        ['group role with overrides', plain, 'groupedAtDesk', desk],
        ['ancestor-read off', plain, 'viewerAtDesk', publication],
        ['ancestor-read one hop', withPolicy, 'viewerAtDesk', publication],
        ['ancestor-read beyond maxDepth', withPolicy, 'viewerAtDesk', network],
        ['ancestor-read never lateral', withPolicy, 'viewerAtDesk', sibling],
        ['ancestor-read with group', withPolicy, 'groupedAtDesk', publication],
        [
          'policy ignores direct',
          withPolicy,
          'memberAtPublication',
          publication,
        ],
      ];

      const matrix: Record<string, unknown> = {};
      for (const [name, resolver, principal, tenant] of cases) {
        const { userId } = principals[principal];
        const result = await withTenant(
          { tenantId: tenant.id as string, userId },
          () => resolver.resolvePermissions(userId, tenant.id as string),
        );
        // Resolution does not depend on the ambient tenant context.
        const outside = await resolver.resolvePermissions(
          userId,
          tenant.id as string,
        );
        expect(render(outside)).toEqual(render(result));
        matrix[name] = render(result);
      }

      // Resource-scoped grants (#3024) ride on the resolved tenant permission.
      const grantResource = {
        tenantId: publication.id as string,
        resourceType: 'construction-project',
        resourceId: 'project-3047',
      };
      const grants = await ResourceGrantCollection.create(options);
      await withTenant({ tenantId: publication.id as string }, async () => {
        await (
          await grants.create({
            ...grantResource,
            userId: principals.memberAtPublication.userId,
            permission: 'tenants.read',
            effect: 'grant',
          })
        ).save();
        await (
          await grants.create({
            ...grantResource,
            userId: principals.memberAtPublication.userId,
            permission: 'roles.read',
            effect: 'grant',
          })
        ).save();
        await (
          await grants.create({
            ...grantResource,
            userId: principals.ownerAtPublication.userId,
            permission: 'tenants.read',
            effect: 'deny',
          })
        ).save();
      });
      const resourceChecks: Array<
        [string, keyof typeof principals, string, string]
      > = [
        [
          'member granted, tenant permission revoked',
          'memberAtPublication',
          'tenants',
          'read',
        ],
        [
          'member granted, override re-added',
          'memberAtPublication',
          'roles',
          'read',
        ],
        ['owner denied on resource', 'ownerAtPublication', 'tenants', 'read'],
        ['owner without a grant', 'ownerAtPublication', 'users', 'read'],
        [
          'owner lacks the cascade-denied permission',
          'ownerAtPublication',
          'roles',
          'read',
        ],
      ];
      for (const [name, principal, collection, action] of resourceChecks) {
        const { userId } = principals[principal];
        const decision = await withTenant(
          { tenantId: grantResource.tenantId, userId },
          () =>
            checkResourceOperationPermission({
              ...options,
              collection,
              action,
              tenantId: grantResource.tenantId,
              userId,
              resource: grantResource,
              verifyResource: () => true,
            }),
        );
        matrix[`resource: ${name}`] = {
          allowed: decision.allowed,
          reason: decision.reason,
        };
      }

      expect(matrix).toMatchSnapshot();
    });
  },
);
