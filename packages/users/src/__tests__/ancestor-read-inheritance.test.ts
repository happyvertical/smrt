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
import { MembershipCollection } from '../collections/MembershipCollection.js';
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
    publication.hierarchyPath = `${network.id}/${sibling.id}`;
    await publication.save();

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
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `smrt-ancestor-rows-${randomUUID()}.db`);
    enableTenancy();
  });

  afterEach(() => {
    disableTenancy();
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch {
        // best effort
      }
    }
  });

  it('a publication member granted read at the network root still cannot read a sibling publication rows', async () => {
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['TenantIntegration'],
    });
    const integrations = await TenantIntegrationCollection.create({ db });

    const publicationTenantId = randomUUID();
    const siblingTenantId = randomUUID();

    await withTenant({ tenantId: publicationTenantId }, async () => {
      const row = await integrations.create({
        tenantId: publicationTenantId,
        provider: 'aws',
        status: 'active',
      });
      await row.save();
    });
    await withTenant({ tenantId: siblingTenantId }, async () => {
      const row = await integrations.create({
        tenantId: siblingTenantId,
        provider: 'gcp',
        status: 'active',
      });
      await row.save();
    });

    // The ancestor-read policy grants the READ OPERATION at the network root.
    // Row scoping is a separate, unaffected layer: reading as the publication
    // returns only the publication's rows, and asking for the sibling's rows
    // from the publication context is an isolation error.
    const own = await withTenant({ tenantId: publicationTenantId }, () =>
      integrations.list({}),
    );
    expect(own).toHaveLength(1);
    expect(own[0].provider).toBe('aws');

    await expect(
      withTenant({ tenantId: publicationTenantId }, () =>
        integrations.list({ where: { tenantId: siblingTenantId } }),
      ),
    ).rejects.toThrow();

    if (typeof db.close === 'function') {
      await db.close();
    }
  });
});
