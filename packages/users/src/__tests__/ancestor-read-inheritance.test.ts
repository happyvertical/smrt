/**
 * Declared read-only ancestor visibility (smrt#2939).
 *
 * Membership authority is downward-only by default: a direct membership in the
 * target tenant, or the nearest ACTIVE ancestor membership whose role is
 * flagged `inheritsToDescendants`. These tests cover the opt-in exception that
 * lets a DESCENDANT membership contribute declared, read-only permissions when
 * the permission context is resolved at an ancestor.
 *
 * The invariants under test, in order: default OFF, read-only, declared roles
 * and collections only, no lateral (sibling) visibility, bounded depth, single
 * resolution point, and — the one that is easiest to get wrong — that a grant
 * of the READ OPERATION at an ancestor is not visibility of a sibling tenant's
 * ROWS.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearCache, setConfig } from '@happyvertical/smrt-config';
import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GroupCollection } from '../collections/GroupCollection.js';
import { GroupMemberCollection } from '../collections/GroupMemberCollection.js';
import { GroupRoleCollection } from '../collections/GroupRoleCollection.js';
import { MembershipCollection } from '../collections/MembershipCollection.js';
import { MembershipOverrideCollection } from '../collections/MembershipOverrideCollection.js';
import { PermissionCollection } from '../collections/PermissionCollection.js';
import { RoleCollection } from '../collections/RoleCollection.js';
import { RolePermissionCollection } from '../collections/RolePermissionCollection.js';
import { TenantCollection } from '../collections/TenantCollection.js';
import { TenantIntegrationCollection } from '../collections/TenantIntegrationCollection.js';
import { TenantPermissionOverrideCollection } from '../collections/TenantPermissionOverrideCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import {
  type AncestorReadPolicy,
  isAncestorReadableSlug,
  normalizeAncestorReadPolicy,
} from '../services/AncestorReadPolicy.js';
import { PermissionResolver } from '../services/PermissionResolver.js';
import { MembershipStatus } from '../types/index.js';

const NETWORK_POLICY: AncestorReadPolicy = {
  roles: ['member'],
  collections: ['publications', 'tenants'],
};

describe('AncestorReadPolicy declaration', () => {
  it('is off for an absent, malformed, or half-declared policy', () => {
    expect(normalizeAncestorReadPolicy(undefined)).toBeNull();
    expect(normalizeAncestorReadPolicy(null)).toBeNull();
    expect(
      normalizeAncestorReadPolicy({ roles: [], collections: ['publications'] }),
    ).toBeNull();
    expect(
      normalizeAncestorReadPolicy({ roles: ['member'], collections: [] }),
    ).toBeNull();
    expect(
      normalizeAncestorReadPolicy({
        roles: ['member'],
        collections: ['publications'],
        maxDepth: 0,
      }),
    ).toBeNull();
  });

  it('normalizes slugs and defaults depth to the immediate parent', () => {
    const policy = normalizeAncestorReadPolicy({
      roles: ['Member', 'member', ' editor '],
      collections: ['Publications'],
    });
    expect(policy).not.toBeNull();
    expect([...(policy?.roleSlugs ?? [])].sort()).toEqual(['editor', 'member']);
    expect(policy?.collectionPatterns).toEqual(['publications']);
    expect(policy?.maxDepth).toBe(1);
  });

  it('admits only read slugs on declared collections', () => {
    const policy = normalizeAncestorReadPolicy({
      roles: ['member'],
      collections: ['publications', 'site_*'],
    });
    if (!policy) throw new Error('policy should normalize');

    expect(isAncestorReadableSlug('publications.read', policy)).toBe(true);
    expect(isAncestorReadableSlug('publications.list', policy)).toBe(true);
    expect(isAncestorReadableSlug('publications.get', policy)).toBe(true);
    expect(isAncestorReadableSlug('site_pages.read', policy)).toBe(true);

    expect(isAncestorReadableSlug('publications.create', policy)).toBe(false);
    expect(isAncestorReadableSlug('publications.update', policy)).toBe(false);
    expect(isAncestorReadableSlug('publications.delete', policy)).toBe(false);
    expect(isAncestorReadableSlug('publications.publish', policy)).toBe(false);
    expect(isAncestorReadableSlug('articles.read', policy)).toBe(false);
    expect(isAncestorReadableSlug('fields.policy.personalize', policy)).toBe(
      false,
    );
    expect(isAncestorReadableSlug('publications', policy)).toBe(false);
  });
});

describe('PermissionResolver: read-only ancestor visibility', () => {
  let dbPath: string;
  let options: { db: { type: 'sqlite'; url: string } };
  let users: UserCollection;
  let tenants: TenantCollection;
  let roles: RoleCollection;
  let permissions: PermissionCollection;
  let memberships: MembershipCollection;
  let rolePermissions: RolePermissionCollection;
  let tenantOverrides: TenantPermissionOverrideCollection;
  let membershipOverrides: MembershipOverrideCollection;
  let groups: GroupCollection;
  let groupMembers: GroupMemberCollection;
  let groupRoles: GroupRoleCollection;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-ancestor-read-${randomUUID()}.db`);
    options = { db: { type: 'sqlite' as const, url: dbPath } };
    users = await UserCollection.create(options);
    tenants = await TenantCollection.create(options);
    roles = await RoleCollection.create(options);
    permissions = await PermissionCollection.create(options);
    memberships = await MembershipCollection.create(options);
    rolePermissions = await RolePermissionCollection.create(options);
    tenantOverrides = await TenantPermissionOverrideCollection.create(options);
    membershipOverrides = await MembershipOverrideCollection.create(options);
    groups = await GroupCollection.create(options);
    groupMembers = await GroupMemberCollection.create(options);
    groupRoles = await GroupRoleCollection.create(options);
  });

  afterEach(() => {
    clearCache();
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch (err) {
        console.warn(`Test cleanup warning: failed to remove ${dbPath}:`, err);
      }
    }
  });

  /** network root -> publication -> desk. */
  async function createNetwork() {
    const network = await tenants.create({ name: 'Network Root' });
    await network.save();
    const publication = await tenants.createChild(network.id as string, {
      name: 'Eckville Echo',
    });
    const sibling = await tenants.createChild(network.id as string, {
      name: 'Bentley Bulletin',
    });
    const desk = await tenants.createChild(publication.id as string, {
      name: 'Sports Desk',
    });
    return { network, publication, sibling, desk };
  }

  async function createRoleGranting(
    slug: string,
    name: string,
    slugs: string[],
    roleOptions: { tenantId?: string | null; isSystem?: boolean } = {},
  ) {
    const role = await roles.create({
      name,
      slug,
      tenantId: roleOptions.tenantId ?? null,
      isSystem: roleOptions.isSystem ?? true,
    });
    await role.save();
    for (const permissionSlug of slugs) {
      const existing = await permissions.list({
        where: { slug: permissionSlug },
        limit: 1,
      });
      let record = existing[0];
      if (!record) {
        record = await permissions.create({
          slug: permissionSlug,
          name: permissionSlug,
        });
        await record.save();
      }
      await rolePermissions.addPermission(
        role.id as string,
        record.id as string,
      );
    }
    return role;
  }

  async function createMember(
    tenantId: string,
    roleId: string,
    email: string,
    status: MembershipStatus = MembershipStatus.ACTIVE,
  ) {
    const user = await users.create({ email });
    await user.save();
    const membership = await memberships.create({
      userId: user.id,
      tenantId,
      roleId,
      status,
    });
    await membership.save();
    return { user, membership };
  }

  /** A `member` role holding read AND write on both declared collections. */
  async function createPublicationMemberRole() {
    return await createRoleGranting('member', 'Member', [
      'publications.read',
      'publications.create',
      'publications.update',
      'publications.delete',
      'tenants.read',
      'articles.read',
    ]);
  }

  it('resolves empty at the ancestor when no policy is declared (default OFF)', async () => {
    const { network, publication } = await createNetwork();
    const memberRole = await createPublicationMemberRole();
    const { user } = await createMember(
      publication.id as string,
      memberRole.id as string,
      'pub-member@example.com',
    );

    const resolver = await PermissionResolver.create(options);
    const result = await resolver.resolvePermissions(
      user.id as string,
      network.id as string,
    );

    expect(result.permissions.size).toBe(0);
    expect(result.membershipId).toBeNull();
    expect(result.inheritedFromTenantId).toBeNull();
    expect(result.ancestorReadFromTenantIds).toEqual([]);
  });

  it('grants only the declared read slugs at the ancestor when opted in', async () => {
    const { network, publication } = await createNetwork();
    const memberRole = await createPublicationMemberRole();
    const { user } = await createMember(
      publication.id as string,
      memberRole.id as string,
      'pub-member@example.com',
    );

    const resolver = await PermissionResolver.create(options, {
      ancestorReadPolicy: NETWORK_POLICY,
    });
    const result = await resolver.resolvePermissions(
      user.id as string,
      network.id as string,
    );

    expect([...result.permissions].sort()).toEqual([
      'publications.read',
      'tenants.read',
    ]);
    expect(result.ancestorReadFromTenantIds).toEqual([publication.id]);
    // The grant is authorization only: no membership was selected.
    expect(result.membershipId).toBeNull();
    expect(result.roleId).toBeNull();
    expect(result.inheritedFromTenantId).toBeNull();
  });

  it('never contributes a write action, even when the descendant role holds it', async () => {
    const { network, publication } = await createNetwork();
    const memberRole = await createPublicationMemberRole();
    const { user } = await createMember(
      publication.id as string,
      memberRole.id as string,
      'pub-member@example.com',
    );

    const resolver = await PermissionResolver.create(options, {
      ancestorReadPolicy: NETWORK_POLICY,
    });
    const result = await resolver.resolvePermissions(
      user.id as string,
      network.id as string,
    );

    for (const slug of [
      'publications.create',
      'publications.update',
      'publications.delete',
    ]) {
      expect(result.permissions.has(slug)).toBe(false);
    }
    // ...and the same principal still holds them in its OWN tenant.
    const own = await resolver.resolvePermissions(
      user.id as string,
      publication.id as string,
    );
    expect(own.permissions.has('publications.create')).toBe(true);
  });

  it('cannot grant a permission the descendant role does not already hold', async () => {
    const { network, publication } = await createNetwork();
    // Declares `tenants` but the role holds no `tenants.read`.
    const memberRole = await createRoleGranting('member', 'Member', [
      'publications.read',
    ]);
    const { user } = await createMember(
      publication.id as string,
      memberRole.id as string,
      'pub-member@example.com',
    );

    const resolver = await PermissionResolver.create(options, {
      ancestorReadPolicy: NETWORK_POLICY,
    });
    const result = await resolver.resolvePermissions(
      user.id as string,
      network.id as string,
    );

    expect([...result.permissions]).toEqual(['publications.read']);
  });

  it('a descendant tenant GRANT cannot widen what travels upward', async () => {
    const { network, publication } = await createNetwork();
    // The declared system role grants publications.read but NOT tenants.read.
    const memberRole = await createRoleGranting('member', 'Member', [
      'publications.read',
    ]);
    const { user } = await createMember(
      publication.id as string,
      memberRole.id as string,
      'granted@example.com',
    );

    // The descendant tenant's own administrator adds tenants.read there.
    const extra = await permissions.create({
      slug: 'tenants.read',
      name: 'tenants.read',
    });
    await extra.save();
    await tenantOverrides.grantPermission(
      publication.id as string,
      extra.id as string,
    );

    const resolver = await PermissionResolver.create(options, {
      ancestorReadPolicy: NETWORK_POLICY,
    });

    // It IS effective at home...
    const own = await resolver.resolvePermissions(
      user.id as string,
      publication.id as string,
    );
    expect(own.permissions.has('tenants.read')).toBe(true);

    // ...but it is not what the ancestor declared, so it stays there.
    const result = await resolver.resolvePermissions(
      user.id as string,
      network.id as string,
    );
    expect([...result.permissions]).toEqual(['publications.read']);
  });

  it('a membership GRANT cannot widen what travels upward', async () => {
    const { network, publication } = await createNetwork();
    const memberRole = await createRoleGranting('member', 'Member', [
      'publications.read',
    ]);
    const { user, membership } = await createMember(
      publication.id as string,
      memberRole.id as string,
      'mgrant@example.com',
    );

    const extra = await permissions.create({
      slug: 'tenants.read',
      name: 'tenants.read',
    });
    await extra.save();
    await membershipOverrides.grantPermission(
      membership.id as string,
      extra.id as string,
    );

    const resolver = await PermissionResolver.create(options, {
      ancestorReadPolicy: NETWORK_POLICY,
    });
    const own = await resolver.resolvePermissions(
      user.id as string,
      publication.id as string,
    );
    expect(own.permissions.has('tenants.read')).toBe(true);

    const result = await resolver.resolvePermissions(
      user.id as string,
      network.id as string,
    );
    expect([...result.permissions]).toEqual(['publications.read']);
  });

  it('a group role cannot widen what travels upward', async () => {
    const { network, publication } = await createNetwork();
    const memberRole = await createRoleGranting('member', 'Member', [
      'publications.read',
    ]);
    const { user } = await createMember(
      publication.id as string,
      memberRole.id as string,
      'grouped@example.com',
    );

    // A tenant-scoped custom role, carried by a group in the descendant.
    const groupRole = await createRoleGranting(
      'editors',
      'Editors (tenant-local)',
      ['tenants.read'],
      { tenantId: publication.id as string, isSystem: false },
    );
    const group = await groups.create({
      name: 'Desk',
      tenantId: publication.id,
    });
    await group.save();
    await groupRoles.addRole(group.id as string, groupRole.id as string);
    await groupMembers.addMember(group.id as string, user.id as string);

    const resolver = await PermissionResolver.create(options, {
      ancestorReadPolicy: NETWORK_POLICY,
    });
    const own = await resolver.resolvePermissions(
      user.id as string,
      publication.id as string,
    );
    expect(own.permissions.has('tenants.read')).toBe(true);

    const result = await resolver.resolvePermissions(
      user.id as string,
      network.id as string,
    );
    expect([...result.permissions]).toEqual(['publications.read']);
  });

  it('contributes nothing for a role that is not declared', async () => {
    const { network, publication } = await createNetwork();
    const contributorRole = await createRoleGranting(
      'contributor',
      'Contributor',
      ['publications.read', 'tenants.read'],
    );
    const { user } = await createMember(
      publication.id as string,
      contributorRole.id as string,
      'contributor@example.com',
    );

    const resolver = await PermissionResolver.create(options, {
      ancestorReadPolicy: NETWORK_POLICY,
    });
    const result = await resolver.resolvePermissions(
      user.id as string,
      network.id as string,
    );

    expect(result.permissions.size).toBe(0);
    expect(result.ancestorReadFromTenantIds).toEqual([]);
  });

  it('ignores a tenant-scoped role that merely shares a declared slug', async () => {
    const { network, publication } = await createNetwork();
    // A descendant tenant's own administrator can create a custom role and
    // choose its slug. Minting one named `member` must not opt that tenant
    // into the ancestor's allow-list.
    const mintedRole = await createRoleGranting(
      'member',
      'Member (tenant-local)',
      ['publications.read', 'tenants.read'],
      { tenantId: publication.id as string, isSystem: false },
    );
    const { user } = await createMember(
      publication.id as string,
      mintedRole.id as string,
      'minted@example.com',
    );

    const resolver = await PermissionResolver.create(options, {
      ancestorReadPolicy: NETWORK_POLICY,
    });
    const result = await resolver.resolvePermissions(
      user.id as string,
      network.id as string,
    );

    expect(result.permissions.size).toBe(0);
    expect(result.ancestorReadFromTenantIds).toEqual([]);
  });

  it('ignores a global role that is not flagged isSystem', async () => {
    const { network, publication } = await createNetwork();
    const unflagged = await createRoleGranting(
      'member',
      'Member (unflagged)',
      ['publications.read'],
      { tenantId: null, isSystem: false },
    );
    const { user } = await createMember(
      publication.id as string,
      unflagged.id as string,
      'unflagged@example.com',
    );

    const resolver = await PermissionResolver.create(options, {
      ancestorReadPolicy: NETWORK_POLICY,
    });
    expect(
      (
        await resolver.resolvePermissions(
          user.id as string,
          network.id as string,
        )
      ).permissions.size,
    ).toBe(0);
  });

  it('is never lateral: a publication member gains nothing on a SIBLING publication', async () => {
    const { publication, sibling } = await createNetwork();
    const memberRole = await createPublicationMemberRole();
    const { user } = await createMember(
      publication.id as string,
      memberRole.id as string,
      'pub-member@example.com',
    );

    const resolver = await PermissionResolver.create(options, {
      // Deliberately generous: every collection, every reachable depth.
      ancestorReadPolicy: {
        roles: ['member'],
        collections: ['*'],
        maxDepth: 10,
      },
    });
    const result = await resolver.resolvePermissions(
      user.id as string,
      sibling.id as string,
    );

    expect(result.permissions.size).toBe(0);
    expect(result.ancestorReadFromTenantIds).toEqual([]);
  });

  it('never grants downward either: the policy is upward-only', async () => {
    const { publication, desk } = await createNetwork();
    const memberRole = await createPublicationMemberRole();
    // Membership on the PARENT publication; resolve at the child desk.
    const { user } = await createMember(
      publication.id as string,
      memberRole.id as string,
      'pub-member@example.com',
    );

    const resolver = await PermissionResolver.create(options, {
      ancestorReadPolicy: {
        roles: ['member'],
        collections: ['*'],
        maxDepth: 10,
      },
    });
    const result = await resolver.resolvePermissions(
      user.id as string,
      desk.id as string,
    );

    // Downward travel still requires `inheritsToDescendants` on the role.
    expect(result.permissions.size).toBe(0);
  });

  it('honours maxDepth', async () => {
    const { network, desk } = await createNetwork();
    const memberRole = await createPublicationMemberRole();
    const { user } = await createMember(
      desk.id as string,
      memberRole.id as string,
      'desk-member@example.com',
    );

    // desk -> publication -> network is two hops.
    const shallow = await PermissionResolver.create(options, {
      ancestorReadPolicy: { ...NETWORK_POLICY, maxDepth: 1 },
    });
    expect(
      (
        await shallow.resolvePermissions(
          user.id as string,
          network.id as string,
        )
      ).permissions.size,
    ).toBe(0);

    const deep = await PermissionResolver.create(options, {
      ancestorReadPolicy: { ...NETWORK_POLICY, maxDepth: 2 },
    });
    const deepResult = await deep.resolvePermissions(
      user.id as string,
      network.id as string,
    );
    expect(deepResult.permissions.has('publications.read')).toBe(true);
    expect(deepResult.ancestorReadFromTenantIds).toEqual([desk.id]);
  });

  it('fails closed on an unverifiable hierarchy path', async () => {
    const { network, publication, sibling } = await createNetwork();
    const memberRole = await createPublicationMemberRole();
    const { user } = await createMember(
      publication.id as string,
      memberRole.id as string,
      'pub-member@example.com',
    );

    // Corrupt the materialized path so it claims an ancestor the real
    // parentTenantId chain does not support.
    // Written directly: `Tenant.save()` derives the path (smrt#3036), so
    // corruption can only come from outside the framework.
    await tenants.db.query(
      'UPDATE tenants SET hierarchy_path = ? WHERE id = ?',
      `${network.id}/${sibling.id}`,
      publication.id,
    );

    const resolver = await PermissionResolver.create(options, {
      ancestorReadPolicy: { ...NETWORK_POLICY, maxDepth: 5 },
    });
    const result = await resolver.resolvePermissions(
      user.id as string,
      network.id as string,
    );
    expect(result.permissions.size).toBe(0);
  });

  it('a direct membership at the ancestor still pins resolution', async () => {
    const { network, publication } = await createNetwork();
    const memberRole = await createPublicationMemberRole();
    const { user } = await createMember(
      publication.id as string,
      memberRole.id as string,
      'pub-member@example.com',
    );
    // An inactive direct membership at the root is an explicit attenuation.
    const attenuated = await memberships.create({
      userId: user.id,
      tenantId: network.id,
      roleId: memberRole.id,
      status: MembershipStatus.INACTIVE,
    });
    await attenuated.save();

    const resolver = await PermissionResolver.create(options, {
      ancestorReadPolicy: NETWORK_POLICY,
    });
    const result = await resolver.resolvePermissions(
      user.id as string,
      network.id as string,
    );

    expect(result.permissions.size).toBe(0);
    expect(result.ancestorReadFromTenantIds).toEqual([]);
  });

  it('an ancestor tenant-level DENY still subtracts', async () => {
    const { network, publication } = await createNetwork();
    const memberRole = await createPublicationMemberRole();
    const { user } = await createMember(
      publication.id as string,
      memberRole.id as string,
      'pub-member@example.com',
    );

    const denied = (
      await permissions.list({ where: { slug: 'publications.read' }, limit: 1 })
    )[0];
    await tenantOverrides.denyPermission(
      network.id as string,
      denied.id as string,
    );

    const resolver = await PermissionResolver.create(options, {
      ancestorReadPolicy: NETWORK_POLICY,
    });
    const result = await resolver.resolvePermissions(
      user.id as string,
      network.id as string,
    );

    expect(result.permissions.has('publications.read')).toBe(false);
    expect(result.permissions.has('tenants.read')).toBe(true);
  });

  it('a membership DENY in the descendant tenant removes the ancestor grant', async () => {
    const { network, publication } = await createNetwork();
    const memberRole = await createPublicationMemberRole();
    const { user, membership } = await createMember(
      publication.id as string,
      memberRole.id as string,
      'denied@example.com',
    );

    const denied = (
      await permissions.list({ where: { slug: 'publications.read' }, limit: 1 })
    )[0];
    await membershipOverrides.denyPermission(
      membership.id as string,
      denied.id as string,
    );

    const resolver = await PermissionResolver.create(options, {
      ancestorReadPolicy: NETWORK_POLICY,
    });

    // The DENY is effective at home...
    const own = await resolver.resolvePermissions(
      user.id as string,
      publication.id as string,
    );
    expect(own.permissions.has('publications.read')).toBe(false);

    // ...so it cannot come back at the ancestor.
    const result = await resolver.resolvePermissions(
      user.id as string,
      network.id as string,
    );
    expect(result.permissions.has('publications.read')).toBe(false);
    expect(result.permissions.has('tenants.read')).toBe(true);
  });

  it("a DENY on the descendant's own tenant removes the ancestor grant", async () => {
    const { network, publication } = await createNetwork();
    const memberRole = await createPublicationMemberRole();
    const { user } = await createMember(
      publication.id as string,
      memberRole.id as string,
      'tenant-denied@example.com',
    );

    const denied = (
      await permissions.list({ where: { slug: 'publications.read' }, limit: 1 })
    )[0];
    await tenantOverrides.denyPermission(
      publication.id as string,
      denied.id as string,
    );

    const resolver = await PermissionResolver.create(options, {
      ancestorReadPolicy: NETWORK_POLICY,
    });
    const result = await resolver.resolvePermissions(
      user.id as string,
      network.id as string,
    );
    expect(result.permissions.has('publications.read')).toBe(false);
    expect(result.permissions.has('tenants.read')).toBe(true);
  });

  it('reports only descendants that actually contributed', async () => {
    const { network, publication, desk } = await createNetwork();
    const memberRole = await createPublicationMemberRole();
    // Two memberships for one user: the publication contributes, the desk's
    // permissions are entirely denied at its tenant.
    const { user } = await createMember(
      publication.id as string,
      memberRole.id as string,
      'multi@example.com',
    );
    const deskMembership = await memberships.create({
      userId: user.id,
      tenantId: desk.id,
      roleId: memberRole.id,
      status: MembershipStatus.ACTIVE,
    });
    await deskMembership.save();
    for (const slug of ['publications.read', 'tenants.read']) {
      const permission = (
        await permissions.list({ where: { slug }, limit: 1 })
      )[0];
      await tenantOverrides.denyPermission(
        desk.id as string,
        permission.id as string,
      );
    }

    const resolver = await PermissionResolver.create(options, {
      ancestorReadPolicy: { ...NETWORK_POLICY, maxDepth: 2 },
    });
    const result = await resolver.resolvePermissions(
      user.id as string,
      network.id as string,
    );
    expect(result.permissions.has('publications.read')).toBe(true);
    expect(result.ancestorReadFromTenantIds).toEqual([publication.id]);
  });

  it('an inactive descendant membership contributes nothing', async () => {
    const { network, publication } = await createNetwork();
    const memberRole = await createPublicationMemberRole();
    const { user } = await createMember(
      publication.id as string,
      memberRole.id as string,
      'pending@example.com',
      MembershipStatus.PENDING,
    );

    const resolver = await PermissionResolver.create(options, {
      ancestorReadPolicy: NETWORK_POLICY,
    });
    const result = await resolver.resolvePermissions(
      user.id as string,
      network.id as string,
    );
    expect(result.permissions.size).toBe(0);
  });

  it('reads the policy from the users package config', async () => {
    const { network, publication } = await createNetwork();
    const memberRole = await createPublicationMemberRole();
    const { user } = await createMember(
      publication.id as string,
      memberRole.id as string,
      'pub-member@example.com',
    );

    const resolver = await PermissionResolver.create(options);
    expect(
      (
        await resolver.resolvePermissions(
          user.id as string,
          network.id as string,
        )
      ).permissions.size,
    ).toBe(0);

    setConfig({
      packages: {
        users: {
          permissions: { ancestorRead: NETWORK_POLICY },
        },
      },
    });

    // The SAME long-lived resolver picks the policy up: resolution is uncached.
    const result = await resolver.resolvePermissions(
      user.id as string,
      network.id as string,
    );
    expect(result.permissions.has('publications.read')).toBe(true);

    // An explicit `null` override forces the policy off regardless of config.
    const forcedOff = await PermissionResolver.create(options, {
      ancestorReadPolicy: null,
    });
    expect(
      (
        await forcedOff.resolvePermissions(
          user.id as string,
          network.id as string,
        )
      ).permissions.size,
    ).toBe(0);
  });

  it('hasPermission resolves through the same single point', async () => {
    const { network, publication } = await createNetwork();
    const memberRole = await createPublicationMemberRole();
    const { user } = await createMember(
      publication.id as string,
      memberRole.id as string,
      'pub-member@example.com',
    );

    const resolver = await PermissionResolver.create(options, {
      ancestorReadPolicy: NETWORK_POLICY,
    });
    expect(
      await resolver.hasPermission(
        user.id as string,
        network.id as string,
        'publications.read',
      ),
    ).toBe(true);
    expect(
      await resolver.hasPermission(
        user.id as string,
        network.id as string,
        'publications.create',
      ),
    ).toBe(false);
  });
});
describe('ancestor read authorizes the operation, never a sibling tenant rows', () => {
  let db: Awaited<ReturnType<typeof getTestDatabase>>;

  beforeEach(async () => {
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: [
        'TenantIntegration',
        'User',
        'Tenant',
        'Role',
        'Permission',
        'Membership',
        'RolePermission',
        'MembershipOverride',
        'TenantPermissionOverride',
        'GroupMember',
        'GroupRole',
      ],
    });
    enableTenancy();
  });

  afterEach(async () => {
    disableTenancy();
    if (typeof db.close === 'function') {
      await db.close();
    }
  });

  it('grants the read operation at the network root while rows stay tenant-scoped', async () => {
    const options = { db };
    const users = await UserCollection.create(options);
    const tenants = await TenantCollection.create(options);
    const roles = await RoleCollection.create(options);
    const permissions = await PermissionCollection.create(options);
    const memberships = await MembershipCollection.create(options);
    const rolePermissions = await RolePermissionCollection.create(options);
    const integrations = await TenantIntegrationCollection.create(options);

    const network = await tenants.create({ name: 'Network Root' });
    await network.save();
    const publication = await tenants.createChild(network.id as string, {
      name: 'Eckville Echo',
    });
    const sibling = await tenants.createChild(network.id as string, {
      name: 'Bentley Bulletin',
    });

    const memberRole = await roles.create({
      name: 'Member',
      slug: 'member',
      tenantId: null,
      isSystem: true,
    });
    await memberRole.save();
    for (const slug of ['tenant_integrations.read', 'publications.read']) {
      const permission = await permissions.create({ slug, name: slug });
      await permission.save();
      await rolePermissions.addPermission(
        memberRole.id as string,
        permission.id as string,
      );
    }

    const user = await users.create({ email: 'pub-member@example.com' });
    await user.save();
    const membership = await memberships.create({
      userId: user.id,
      tenantId: publication.id,
      roleId: memberRole.id,
      status: MembershipStatus.ACTIVE,
    });
    await membership.save();

    // Rows belonging to each publication.
    await withTenant({ tenantId: publication.id as string }, async () => {
      const row = await integrations.create({
        tenantId: publication.id as string,
        provider: 'aws',
        status: 'active',
      });
      await row.save();
    });
    await withTenant({ tenantId: sibling.id as string }, async () => {
      const row = await integrations.create({
        tenantId: sibling.id as string,
        provider: 'gcp',
        status: 'active',
      });
      await row.save();
    });

    const resolver = await PermissionResolver.create(options, {
      ancestorReadPolicy: {
        roles: ['member'],
        collections: ['tenant_integrations', 'publications'],
      },
    });

    // The OPERATION is authorized at the network root...
    const atRoot = await resolver.resolvePermissions(
      user.id as string,
      network.id as string,
    );
    expect(atRoot.permissions.has('tenant_integrations.read')).toBe(true);
    expect(atRoot.ancestorReadFromTenantIds).toEqual([publication.id]);

    // ...but the ROWS are not. Reading under the network-root tenant context
    // (which is what that authorization binds to) returns the root's own rows
    // -- none -- and never the children's.
    const atRootRows = await withTenant(
      { tenantId: network.id as string },
      () => integrations.list({}),
    );
    expect(atRootRows).toHaveLength(0);

    // The principal's own tenant still returns only its own row.
    const ownRows = await withTenant(
      { tenantId: publication.id as string },
      () => integrations.list({}),
    );
    expect(ownRows).toHaveLength(1);
    expect(ownRows[0].provider).toBe('aws');

    // And asking for the sibling's rows from either context is an isolation
    // error, not a filtered result.
    await expect(
      withTenant({ tenantId: publication.id as string }, () =>
        integrations.list({ where: { tenantId: sibling.id as string } }),
      ),
    ).rejects.toThrow();
    await expect(
      withTenant({ tenantId: network.id as string }, () =>
        integrations.list({ where: { tenantId: sibling.id as string } }),
      ),
    ).rejects.toThrow();
  });
});
