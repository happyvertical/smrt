/**
 * smrt#3036: permission resolution under the smrt-tenancy interceptor with a
 * MATERIALIZED tenant hierarchy, on real PostgreSQL.
 *
 * The consumer shape this reproduces (anytown/anytown.ai#1256, #1308):
 * `TenantPermissionOverride` and `Membership` registered tenant-scoped with
 * `autoFilter`, `enableTenancy()` on, the real seeded system roles and
 * permission catalog, and resolution running inside the tenant request context
 * of the tenant being resolved.
 *
 * Before the fix, a populated `hierarchyPath` made own-tenant resolution throw
 * `TenantIsolationError` (the ancestor override batch names tenants other than
 * the ambient one), and every other framework-owned cross-tenant read —
 * the ancestor membership lookup behind `inheritsToDescendants` and the
 * descendant membership lookup behind the declared ancestor-read policy — was
 * silently narrowed to the ambient tenant, so both features did nothing.
 *
 * Every assertion here runs as a NON-super-admin principal.
 */

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
import { PermissionCollection } from '../collections/PermissionCollection.js';
import { RoleCollection } from '../collections/RoleCollection.js';
import { TenantCollection } from '../collections/TenantCollection.js';
import { TenantPermissionOverrideCollection } from '../collections/TenantPermissionOverrideCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import { materializeTenantHierarchy } from '../migrations/materializeTenantHierarchy.js';
import type { Tenant } from '../models/Tenant.js';
import type { AncestorReadPolicy } from '../services/AncestorReadPolicy.js';
import { PermissionResolver } from '../services/PermissionResolver.js';
import { MembershipStatus, TenantPermissionEffect } from '../types/index.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

/** The consumer's registration, verbatim from the #3036 report. */
const TENANT_SCOPED = {
  field: 'tenantId',
  mode: 'required',
  autoFilter: true,
  allowSuperAdminBypass: true,
} as const;
const REGISTERED = ['TenantPermissionOverride', 'Membership'] as const;

/** Declared, read-only, one hop — the policy anytown#1308 adopts. */
const POLICY: AncestorReadPolicy = {
  roles: ['owner', 'admin', 'member', 'viewer'],
  collections: ['tenants'],
  maxDepth: 1,
};

const WRITE_ACTIONS = ['create', 'update', 'delete'];

describePostgres(
  'smrt#3036: resolution with a materialized hierarchy and the interceptor on',
  () => {
    let isolated: IsolatedTestDbResult | undefined;
    let options: { db: IsolatedTestDbResult['db'] };
    let tenants: TenantCollection;
    let users: UserCollection;
    let roles: RoleCollection;
    let memberships: MembershipCollection;
    let permissions: PermissionCollection;
    let tenantOverrides: TenantPermissionOverrideCollection;
    let network: Tenant;
    let publication: Tenant;
    let sibling: Tenant;
    let desk: Tenant;

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
      tenantOverrides =
        await TenantPermissionOverrideCollection.create(options);

      await roles.seedSystemRoles({
        inheritsToDescendants: ['owner', 'admin'],
        seedPermissions: true,
      });

      // network (root) -> publication -> desk; sibling is publication's peer.
      network = await tenants.create({ name: 'Network Root' });
      publication = await tenants.createChild(network.id as string, {
        name: 'Eckville Echo',
      });
      sibling = await tenants.createChild(network.id as string, {
        name: 'Lacombe Globe',
      });
      desk = await tenants.createChild(publication.id as string, {
        name: 'Sports Desk',
      });
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

    async function memberOf(tenant: Tenant, roleSlug: string, email: string) {
      const role = await roles.findSystemRoleBySlug(roleSlug);
      if (!role?.id) throw new Error(`Missing seeded system role ${roleSlug}`);
      const user = await users.create({ email });
      const membership = await memberships.create({
        userId: user.id,
        tenantId: tenant.id,
        roleId: role.id,
        status: MembershipStatus.ACTIVE,
      });
      await membership.save();
      return user.id as string;
    }

    /** Resolve inside the tenant request context of the tenant resolved. */
    async function resolveAt(
      resolver: PermissionResolver,
      userId: string,
      tenant: Tenant,
    ) {
      return await withTenant({ tenantId: tenant.id as string, userId }, () =>
        resolver.resolvePermissions(userId, tenant.id as string),
      );
    }

    it('fixture really has a materialized hierarchy (the #3036 trigger)', async () => {
      const reloadedDesk = await tenants.get({ id: desk.id as string });
      expect(reloadedDesk?.hierarchyPath).toBe(
        `${network.id}/${publication.id}`,
      );
      expect(reloadedDesk?.hierarchyLevel).toBe(2);
    });

    it('own-tenant resolution is unchanged by the interceptor', async () => {
      const userId = await memberOf(publication, 'member', 'own@example.com');
      const resolver = await PermissionResolver.create(options);

      // Baseline with tenancy off.
      const baseline = await resolver.resolvePermissions(
        userId,
        publication.id as string,
      );
      expect(baseline.permissions.size).toBeGreaterThan(0);
      expect(baseline.permissions.has('tenants.read')).toBe(true);

      turnTenancyOn();
      const result = await resolveAt(resolver, userId, publication);
      expect([...result.permissions].sort()).toEqual(
        [...baseline.permissions].sort(),
      );

      // Also with no ambient tenant context at all (a 'required' class would
      // otherwise refuse the framework's own membership read outright).
      const noContext = await resolver.resolvePermissions(
        userId,
        publication.id as string,
      );
      expect([...noContext.permissions].sort()).toEqual(
        [...baseline.permissions].sort(),
      );
    });

    it('ancestor tenant overrides still cascade and deny across the chain', async () => {
      const userId = await memberOf(
        publication,
        'member',
        'cascade@example.com',
      );
      const [granted] = await permissions.list({
        where: { slug: 'tenants.read' },
        limit: 1,
      });
      if (!granted?.id) throw new Error('catalog lacks tenants.read');

      // A network-level DENY is a hard block for every descendant that
      // inherits. Reading it requires the batched cross-tenant override read.
      const deny = await tenantOverrides.create({
        tenantId: network.id,
        permissionId: granted.id,
        effect: TenantPermissionEffect.DENY,
      });
      await deny.save();

      turnTenancyOn();
      const resolver = await PermissionResolver.create(options);
      const result = await resolveAt(resolver, userId, publication);
      expect(result.permissions.size).toBeGreaterThan(0);
      expect(result.permissions.has('tenants.read')).toBe(false);
    });

    it('a stored path never cascades an unrelated tenant in; the real chain always does', async () => {
      const db = isolated?.db;
      if (!db) throw new Error('Expected the isolated PostgreSQL database.');
      const userId = await memberOf(
        publication,
        'member',
        'forged@example.com',
      );
      const [deletePerm] = await permissions.list({
        where: { slug: 'tenants.delete' },
        limit: 1,
      });
      const [readPerm] = await permissions.list({
        where: { slug: 'tenants.read' },
        limit: 1,
      });
      if (!deletePerm?.id || !readPerm?.id) throw new Error('catalog gap');

      // An unrelated tenant GRANTs a write; the real root DENYs a read.
      const unrelated = await tenants.create({ name: 'Unrelated' });
      await (
        await tenantOverrides.create({
          tenantId: unrelated.id,
          permissionId: deletePerm.id,
          effect: TenantPermissionEffect.GRANT,
        })
      ).save();
      await (
        await tenantOverrides.create({
          tenantId: network.id,
          permissionId: readPerm.id,
          effect: TenantPermissionEffect.DENY,
        })
      ).save();
      turnTenancyOn();
      const resolver = await PermissionResolver.create(options);

      // Forged path naming the unrelated tenant (raw SQL: saves derive it).
      await db.query(
        'UPDATE tenants SET hierarchy_path = ? WHERE id = ?',
        unrelated.id,
        publication.id,
      );
      let result = await resolveAt(resolver, userId, publication);
      expect(result.permissions.has('tenants.delete')).toBe(false);
      expect(result.permissions.has('tenants.read')).toBe(false);
      expect(result.permissions.size).toBeGreaterThan(0);

      // Never-materialized legacy shape: the real chain applies in BOTH
      // directions — the root's DENY lands, and so does a root GRANT (the
      // cascade semantics the backfill would produce anyway).
      await db.query(
        'UPDATE tenants SET hierarchy_path = ?, hierarchy_level = 0 WHERE id = ?',
        '',
        publication.id,
      );
      result = await resolveAt(resolver, userId, publication);
      expect(result.permissions.has('tenants.read')).toBe(false);
      expect(result.permissions.has('tenants.delete')).toBe(false);
      // Written the way a network administrator would: in the network's context.
      await withTenant({ tenantId: network.id as string }, async () => {
        await tenantOverrides.create({
          tenantId: network.id,
          permissionId: deletePerm.id,
          effect: TenantPermissionEffect.GRANT,
        });
      });
      result = await resolveAt(resolver, userId, publication);
      expect(result.permissions.has('tenants.delete')).toBe(true);
      // The display chain matches what authorization applied.
      const chain = await resolver.getTenantInheritanceChain(
        publication.id as string,
      );
      expect(chain.map((link) => link.tenant.id)).toEqual([
        network.id,
        publication.id,
      ]);
    });

    it('the display chain reports an unreadable ancestor as an access error, not a broken chain', async () => {
      const [readPerm] = await permissions.list({
        where: { slug: 'tenants.read' },
        limit: 1,
      });
      if (!readPerm?.id) throw new Error('catalog gap');
      await (
        await tenantOverrides.create({
          tenantId: network.id,
          permissionId: readPerm.id,
          effect: TenantPermissionEffect.DENY,
        })
      ).save();
      turnTenancyOn();
      registerTenantScopedClass('Tenant', {
        field: 'id',
        mode: 'optional',
        autoFilter: true,
      });
      try {
        const resolver = await PermissionResolver.create(options);
        // Under the desk's own scope the interceptor refuses the ancestor
        // read: an ACCESS error, never a claim that the hierarchy is broken.
        const error = await withTenant({ tenantId: desk.id as string }, () =>
          resolver.getTenantInheritanceChain(desk.id as string),
        ).catch((caught: unknown) => caught);
        expect((error as Error).name).toBe('TenantIsolationError');
        expect((error as { code?: string }).code).not.toBe('PARENT_NOT_FOUND');
        // Authorization is unaffected: the cascade reads outside the filter,
        // so the ROOT's DENY still reaches the desk two hops down.
        const tenantPermissions = await withTenant(
          { tenantId: desk.id as string },
          () => resolver.resolveTenantPermissions(desk.id as string),
        );
        expect([...tenantPermissions.deniedPermissions]).toEqual([
          'tenants.read',
        ]);
      } finally {
        unregisterTenantScopedClass('Tenant');
      }
    });

    it('fails closed when the real parent chain is broken', async () => {
      const db = isolated?.db;
      if (!db) throw new Error('Expected the isolated PostgreSQL database.');
      const userId = await memberOf(publication, 'member', 'cycle@example.com');
      // A cycle the framework can no longer write; only raw SQL produces it.
      await db.query(
        'UPDATE tenants SET parent_tenant_id = ? WHERE id = ?',
        desk.id,
        network.id,
      );
      turnTenancyOn();
      const resolver = await PermissionResolver.create(options);
      await expect(
        resolveAt(resolver, userId, publication),
      ).rejects.toMatchObject({ code: 'CIRCULAR_REFERENCE' });
    });

    it('declared ancestor read grants exactly the listed read ops at the ancestor', async () => {
      const userId = await memberOf(publication, 'member', 'up@example.com');
      turnTenancyOn();
      const resolver = await PermissionResolver.create(options, {
        ancestorReadPolicy: POLICY,
      });

      const atRoot = await resolveAt(resolver, userId, network);
      expect([...atRoot.permissions]).toEqual(['tenants.read']);
      expect(atRoot.ancestorReadFromTenantIds).toEqual([publication.id]);
      expect(atRoot.membershipId).toBeNull();
    });

    it('never grants a write at the ancestor', async () => {
      const userId = await memberOf(publication, 'owner', 'writer@example.com');
      turnTenancyOn();
      const resolver = await PermissionResolver.create(options, {
        ancestorReadPolicy: POLICY,
      });

      // The owner holds writes at home...
      const home = await resolveAt(resolver, userId, publication);
      expect(home.permissions.has('tenants.update')).toBe(true);

      // ...but only reads travel upward.
      const atRoot = await resolveAt(resolver, userId, network);
      expect(atRoot.permissions.has('tenants.read')).toBe(true);
      for (const slug of atRoot.permissions) {
        const action = slug.split('.').pop() as string;
        expect(WRITE_ACTIONS).not.toContain(action);
      }
      expect(atRoot.permissions.has('tenants.update')).toBe(false);
      expect(atRoot.permissions.has('tenants.delete')).toBe(false);
      expect(atRoot.permissions.has('tenants.create')).toBe(false);
    });

    it('is never lateral', async () => {
      const userId = await memberOf(
        publication,
        'member',
        'lateral@example.com',
      );
      turnTenancyOn();
      const resolver = await PermissionResolver.create(options, {
        ancestorReadPolicy: POLICY,
      });
      const atSibling = await resolveAt(resolver, userId, sibling);
      expect(atSibling.permissions.size).toBe(0);
    });

    it('honours maxDepth', async () => {
      const userId = await memberOf(desk, 'member', 'deep@example.com');
      turnTenancyOn();
      const resolver = await PermissionResolver.create(options, {
        ancestorReadPolicy: POLICY,
      });
      const oneHop = await resolveAt(resolver, userId, publication);
      expect([...oneHop.permissions]).toEqual(['tenants.read']);
      const twoHops = await resolveAt(resolver, userId, network);
      expect(twoHops.permissions.size).toBe(0);
    });

    it('inheritsToDescendants flows owner/admin authority downward', async () => {
      const adminId = await memberOf(network, 'admin', 'admin@example.com');
      const plainId = await memberOf(network, 'member', 'plain@example.com');
      turnTenancyOn();
      const resolver = await PermissionResolver.create(options);

      const atRoot = await resolveAt(resolver, adminId, network);
      expect(atRoot.permissions.size).toBeGreaterThan(0);

      for (const target of [publication, desk]) {
        const inherited = await resolveAt(resolver, adminId, target);
        expect([...inherited.permissions].sort()).toEqual(
          [...atRoot.permissions].sort(),
        );
        expect(inherited.inheritedFromTenantId).toBe(network.id);
      }

      // `member` is not flagged, so it confers nothing downward.
      const plain = await resolveAt(resolver, plainId, publication);
      expect(plain.permissions.size).toBe(0);
      expect(plain.inheritedFromTenantId).toBeNull();
    });

    it('legacy rows (parent set, path empty) resolve after the backfill', async () => {
      // The live consumer shape: correct parent_tenant_id, never-materialized
      // path, written by something other than the framework.
      const db = isolated?.db;
      if (!db) throw new Error('Expected the isolated PostgreSQL database.');
      const legacyRoot = await tenants.create({ name: 'Legacy Network' });
      const legacyChild = await tenants.create({ name: 'Legacy Publication' });
      await db.query(
        'UPDATE tenants SET parent_tenant_id = ? WHERE id = ?',
        legacyRoot.id,
        legacyChild.id,
      );
      const memberId = await memberOf(
        legacyChild,
        'member',
        'legacy@example.com',
      );
      const adminId = await memberOf(
        legacyRoot,
        'admin',
        'legacy-admin@example.com',
      );
      turnTenancyOn();
      const resolver = await PermissionResolver.create(options, {
        ancestorReadPolicy: POLICY,
      });

      // Dormant: both hierarchy features fail closed on the empty path.
      expect(
        (await resolveAt(resolver, memberId, legacyRoot)).permissions.size,
      ).toBe(0);
      expect(
        (await resolveAt(resolver, adminId, legacyChild)).permissions.size,
      ).toBe(0);

      const dry = await materializeTenantHierarchy(db, {
        dryRun: true,
      });
      expect(dry.changes.map((change) => change.id)).toEqual([legacyChild.id]);
      expect(dry.problems).toEqual([]);
      const applied = await materializeTenantHierarchy(db);
      expect(applied.changes.map((change) => change.id)).toEqual([
        legacyChild.id,
      ]);
      expect((await materializeTenantHierarchy(db)).changes).toEqual([]);

      // Upward: exactly the declared read.
      const up = await resolveAt(resolver, memberId, legacyRoot);
      expect([...up.permissions]).toEqual(['tenants.read']);
      // Own tenant: intact, not a TenantIsolationError.
      const own = await resolveAt(resolver, memberId, legacyChild);
      expect(own.permissions.has('tenants.read')).toBe(true);
      expect(own.permissions.size).toBeGreaterThan(1);
      // Downward: the flagged admin role now reaches the child.
      const down = await resolveAt(resolver, adminId, legacyChild);
      expect(down.inheritedFromTenantId).toBe(legacyRoot.id);
      expect(down.permissions.has('tenants.update')).toBe(true);
    });

    it('does not widen what the consumer interceptor lets callers read', async () => {
      const userId = await memberOf(publication, 'member', 'rows@example.com');
      await memberOf(sibling, 'member', 'other@example.com');
      turnTenancyOn();
      const resolver = await PermissionResolver.create(options, {
        ancestorReadPolicy: POLICY,
      });
      await resolveAt(resolver, userId, network);

      // Resolution ran framework reads outside the filter; the caller's own
      // reads afterwards are still filtered and still refuse a lateral filter.
      const rows = await withTenant(
        { tenantId: publication.id as string, userId },
        () => memberships.list({}),
      );
      expect(rows.map((row) => row.tenantId)).toEqual([publication.id]);
      await expect(
        withTenant({ tenantId: publication.id as string, userId }, () =>
          memberships.list({ where: { tenantId: sibling.id as string } }),
        ),
      ).rejects.toThrow(/Tenant isolation violation/);
    });
  },
);
