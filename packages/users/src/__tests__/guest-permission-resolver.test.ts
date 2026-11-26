import {
  field,
  getTestDatabase,
  ObjectRegistry,
  registerRuntimeModel,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PermissionCollection } from '../collections/PermissionCollection.js';
import { TenantCollection } from '../collections/TenantCollection.js';
import { TenantGuestGrantCollection } from '../collections/TenantGuestGrantCollection.js';
import { TenantPermissionOverrideCollection } from '../collections/TenantPermissionOverrideCollection.js';
import {
  applyGuestCeiling,
  assertGuestRuntimeActive,
  GuestPermissionResolver,
  guestOperationKind,
  isGuestOperationAllowed,
} from '../services/GuestPermissionResolver.js';
import { generatePostgresPermissionSql } from '../services/PostgresPermissionPolicies.js';
import { TenantStatus } from '../types/index.js';

@smrt({
  packageName: '@test/gp5196',
  tenantScoped: true,
  collection: 'gp5196_products',
})
class GpProduct5196 extends SmrtObject {
  @field() title = '';
}

@smrt({
  packageName: '@test/gp5196',
  tenantScoped: true,
  collection: 'gp5196_events',
})
class GpEvent5196 extends SmrtObject {
  @field() title = '';
}

@smrt({
  packageName: '@test/gp5196',
  tenantScoped: true,
  collection: 'gp5196_secrets',
})
class GpSecret5196 extends SmrtObject {
  @field({ sensitive: true }) token = '';
}

@smrt({
  packageName: '@test/gp5196',
  tenantScoped: true,
  collection: 'gp5196_flagged',
  sensitive: true,
})
class GpFlagged5196 extends SmrtObject {
  @field() title = '';
}

@smrt({
  packageName: '@test/gp5196',
  tenantScoped: true,
  collection: 'gp5196_owned',
  principalContext: true,
})
class GpOwned5196 extends SmrtObject {
  @field() title = '';
}

@smrt({
  packageName: '@test/gp5196',
  tenantScoped: { mode: 'optional' },
  collection: 'gp5196_optional',
})
class GpOptional5196 extends SmrtObject {
  @field() title = '';
}

@smrt({
  packageName: '@test/gp5196',
  tenantScoped: true,
  collection: 'gp5196_exports',
  operationPermissions: { exportAll: { action: 'read' } },
})
class GpExport5196 extends SmrtObject {
  @field() title = '';
  async exportAll() {
    return [];
  }
}

@smrt({
  packageName: '@test/gp5196',
  tenantScoped: true,
  collection: 'gp5196_noread',
  api: { include: ['create'] },
})
class GpCreateOnly5196 extends SmrtObject {
  @field() title = '';
}

// No packageName: registers as a smrt-users class.
@smrt({ tenantScoped: true, collection: 'gp5196_inpackage' })
class GpInPackage5196 extends SmrtObject {
  @field() title = '';
}

const COLLECTIONS = [
  'gp5196_inpackage',
  'gp5196_products',
  'gp5196_events',
  'gp5196_secrets',
  'gp5196_flagged',
  'gp5196_owned',
  'gp5196_optional',
  'gp5196_exports',
  'gp5196_noread',
  'rt5196_things',
  'memberships',
  'tenants',
];

describe('GuestPermissionResolver (#5196)', () => {
  let db: DatabaseInterface;
  let grants: TenantGuestGrantCollection;
  let tenants: TenantCollection;
  let permissions: PermissionCollection;
  let overrides: TenantPermissionOverrideCollection;
  let resolver: GuestPermissionResolver;

  async function setup(classes: string[]) {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:', classes });
    grants = await TenantGuestGrantCollection.create({ db });
    tenants = await TenantCollection.create({ db });
    permissions = await PermissionCollection.create({ db });
    overrides = await TenantPermissionOverrideCollection.create({ db });
    resolver = await GuestPermissionResolver.create(
      { db },
      {
        collections: COLLECTIONS,
        createCollections: ['gp5196_products', 'gp5196_noread'],
      },
    );
  }

  beforeEach(async () => {
    await setup([
      'Tenant',
      'TenantGuestGrant',
      'Permission',
      'TenantPermissionOverride',
    ]);
  });

  afterEach(async () => {
    if (typeof db.close === 'function') await db.close();
  });

  async function tenant(slug: string, parentTenantId?: string) {
    const row = await tenants.create({ name: slug, slug, parentTenantId });
    await row.save();
    return row;
  }

  const grant = (tenantId: string, permissionSlug: string) =>
    grants.create({ tenantId, permissionSlug });

  it('no grants resolves to nothing', async () => {
    const t = await tenant('gp-empty');
    expect((await resolver.resolveGuestPermissions(t.id!)).size).toBe(0);
  });

  it('an unknown tenant resolves to nothing', async () => {
    expect((await resolver.resolveGuestPermissions('nope')).size).toBe(0);
  });

  it('products.read yields only that slug', async () => {
    const t = await tenant('gp-read');
    await grant(t.id!, 'gp5196_products.read');
    expect([...(await resolver.resolveGuestPermissions(t.id!))]).toEqual([
      'gp5196_products.read',
    ]);
  });

  it('keeps grants per tenant', async () => {
    const a = await tenant('gp-a');
    const b = await tenant('gp-b');
    await grant(a.id!, 'gp5196_products.read');
    await grant(b.id!, 'gp5196_events.read');
    expect([...(await resolver.resolveGuestPermissions(a.id!))]).toEqual([
      'gp5196_products.read',
    ]);
    expect([...(await resolver.resolveGuestPermissions(b.id!))]).toEqual([
      'gp5196_events.read',
    ]);
  });

  it('structural, destructive, admin and aliased-method slugs have no effect', async () => {
    const t = await tenant('gp-bad');
    for (const slug of [
      'gp5196_products.update',
      'gp5196_products.delete',
      'gp5196_products.admin',
      'gp5196_products.exportAll',
      'gp5196_products.*',
      '*',
      'gp5196_products',
      'tenants.read',
      'users.manage',
      'gp5196_products.read.extra',
    ]) {
      await grant(t.id!, slug);
    }
    expect((await resolver.resolveGuestPermissions(t.id!)).size).toBe(0);
  });

  it('create needs the createCollections opt-in', async () => {
    const t = await tenant('gp-create');
    await grant(t.id!, 'gp5196_products.create');
    await grant(t.id!, 'gp5196_events.create');
    expect([...(await resolver.resolveGuestPermissions(t.id!))]).toEqual([
      'gp5196_products.create',
    ]);
  });

  it('a collection the app does not list never survives', async () => {
    const limited = await GuestPermissionResolver.create(
      { db },
      { collections: ['gp5196_events'] },
    );
    const t = await tenant('gp-unlisted');
    await grant(t.id!, 'gp5196_products.read');
    await grant(t.id!, 'gp5196_events.read');
    expect([...(await limited.resolveGuestPermissions(t.id!))]).toEqual([
      'gp5196_events.read',
    ]);
  });

  it('a DENY on the tenant removes the slug', async () => {
    const t = await tenant('gp-deny');
    const perm = await permissions.create({
      slug: 'gp5196_products.read',
      name: 'Read',
    });
    await perm.save();
    await grant(t.id!, 'gp5196_products.read');
    await grant(t.id!, 'gp5196_events.read');
    await overrides.denyPermission(t.id!, perm.id!);
    expect([...(await resolver.resolveGuestPermissions(t.id!))]).toEqual([
      'gp5196_events.read',
    ]);
  });

  it('a DENY on an ancestor removes the slug from a descendant', async () => {
    const parent = await tenant('gp-parent');
    const child = await tenant('gp-child', parent.id!);
    const perm = await permissions.create({
      slug: 'gp5196_products.read',
      name: 'Read',
    });
    await perm.save();
    await grant(child.id!, 'gp5196_products.read');
    await overrides.denyPermission(parent.id!, perm.id!);
    expect((await resolver.resolveGuestPermissions(child.id!)).size).toBe(0);
  });

  it('an inactive tenant resolves to nothing', async () => {
    const t = await tenant('gp-inactive');
    await grant(t.id!, 'gp5196_products.read');
    t.status = TenantStatus.SUSPENDED;
    await t.save();
    expect((await resolver.resolveGuestPermissions(t.id!)).size).toBe(0);
  });

  it('an inactive ancestor resolves to nothing', async () => {
    const parent = await tenant('gp-anc');
    const child = await tenant('gp-desc', parent.id!);
    await grant(child.id!, 'gp5196_products.read');
    expect((await resolver.resolveGuestPermissions(child.id!)).size).toBe(1);
    parent.status = TenantStatus.SUSPENDED;
    await parent.save();
    expect((await resolver.resolveGuestPermissions(child.id!)).size).toBe(0);
  });

  it('a missing ancestor resolves to nothing', async () => {
    const parent = await tenant('gp-gone-parent');
    const child = await tenant('gp-orphan', parent.id!);
    await grant(child.id!, 'gp5196_products.read');
    await db.query('PRAGMA foreign_keys = OFF');
    await db.query('DELETE FROM tenants WHERE id = ?', [parent.id]);
    expect((await resolver.resolveGuestPermissions(child.id!)).size).toBe(0);
  });

  it('is uncached: a revoked grant takes effect at once', async () => {
    const t = await tenant('gp-live');
    const row = await grant(t.id!, 'gp5196_products.read');
    expect((await resolver.resolveGuestPermissions(t.id!)).size).toBe(1);
    await db.query('DELETE FROM tenant_guest_grants WHERE id = ?', [row.id]);
    expect((await resolver.resolveGuestPermissions(t.id!)).size).toBe(0);
  });

  it('excludes sensitive, owner-scoped, optional-mode and unexposed collections', async () => {
    const t = await tenant('gp-excluded');
    for (const c of [
      'gp5196_secrets',
      'gp5196_flagged',
      'gp5196_owned',
      'gp5196_optional',
    ]) {
      await grant(t.id!, `${c}.read`);
    }
    await grant(t.id!, 'gp5196_noread.read');
    expect((await resolver.resolveGuestPermissions(t.id!)).size).toBe(0);
    // The create-only collection still admits create.
    await grant(t.id!, 'gp5196_noread.create');
    expect([...(await resolver.resolveGuestPermissions(t.id!))]).toEqual([
      'gp5196_noread.create',
    ]);
  });

  it('excludes tables owned by the smrt-users package', async () => {
    const t = await tenant('gp-inpkg');
    await grant(t.id!, 'gp5196_inpackage.read');
    await grant(t.id!, 'tenantintegrations.read');
    expect((await resolver.resolveGuestPermissions(t.id!)).size).toBe(0);
    expect(GpInPackage5196).toBeDefined();
  });

  it('malformed guest config means no guest collections', async () => {
    const t = await tenant('gp-badcfg');
    await grant(t.id!, 'gp5196_products.read');
    for (const collections of ['gp5196_products', undefined, null, 5]) {
      const r = await GuestPermissionResolver.create({ db }, {
        collections,
      } as never);
      expect((await r.resolveGuestPermissions(t.id!)).size).toBe(0);
    }
  });

  it('excludes run-time models', async () => {
    registerRuntimeModel({
      name: 'Rt5196Thing',
      packageName: '@test/gp5196',
      collection: undefined,
      tenantScoped: true,
      fields: { title: { type: 'text' } },
    } as never);
    const targets = generatePostgresPermissionSql({ db }).targets;
    const target = targets.find((x) => x.className === 'Rt5196Thing');
    expect(target).toBeDefined();
    const slug = `${target!.collection}.read`;
    expect(
      applyGuestCeiling([slug], { collections: [target!.collection!] }, targets)
        .size,
    ).toBe(0);
    // The same model would pass without the marker.
    const registered = ObjectRegistry.getClass(target!.qualifiedName!)!;
    delete registered.runtimeModel;
    expect(
      applyGuestCeiling([slug], { collections: [target!.collection!] }, targets)
        .size,
    ).toBe(1);
    registered.runtimeModel = true;
  });

  it('a read grant resolves, but never authorizes an aliased method', async () => {
    const t = await tenant('gp-alias');
    await grant(t.id!, 'gp5196_exports.read');
    const held = await resolver.resolveGuestPermissions(t.id!);
    expect([...held]).toEqual(['gp5196_exports.read']);
    expect(
      isGuestOperationAllowed(held, 'GpExport5196', 'gp5196_exports', 'list'),
    ).toBe(true);
    expect(
      isGuestOperationAllowed(
        held,
        'GpExport5196',
        'gp5196_exports',
        'exportAll',
      ),
    ).toBe(false);
  });

  it('an aliased custom method never maps to a guest kind', () => {
    const q = 'GpExport5196';
    expect(guestOperationKind(q, 'list')).toBe('read');
    expect(guestOperationKind(q, 'get')).toBe('read');
    expect(guestOperationKind(q, 'create')).toBe('create');
    expect(guestOperationKind(q, 'exportAll')).toBeNull();
    expect(guestOperationKind(q, 'update')).toBeNull();
    expect(guestOperationKind(q, 'delete')).toBeNull();
    const held = new Set(['gp5196_exports.read']);
    expect(isGuestOperationAllowed(held, q, 'gp5196_exports', 'list')).toBe(
      true,
    );
    expect(
      isGuestOperationAllowed(held, q, 'gp5196_exports', 'exportAll'),
    ).toBe(false);
  });
});

describe('GuestPermissionResolver with no grants table (#5196)', () => {
  it('resolves to nothing', async () => {
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['Tenant', 'Permission', 'TenantPermissionOverride'],
    });
    const tenants = await TenantCollection.create({ db });
    const t = await tenants.create({ name: 'x', slug: 'gp-notable' });
    await t.save();
    const resolver = await GuestPermissionResolver.create(
      { db },
      { collections: ['gp5196_products'] },
    );
    expect((await resolver.resolveGuestPermissions(t.id!)).size).toBe(0);
    if (typeof db.close === 'function') await db.close();
  });
});

describe('assertGuestRuntimeActive (#5196)', () => {
  const ok = {
    postgresRls: true,
    tenancyEnabled: true,
    rolePosture: { rolsuper: false, rolbypassrls: false },
    ceilingTables: [
      {
        table: 'products',
        rowSecurity: true,
        forceRowSecurity: true,
        policyCount: 2,
      },
    ],
  };

  it('passes when every gate holds', () => {
    expect(assertGuestRuntimeActive(ok)).toEqual({ active: true });
  });

  it.each([
    ['postgresRls false', { ...ok, postgresRls: false }, 'rls-not-active'],
    [
      'postgresRls undefined',
      { ...ok, postgresRls: undefined },
      'rls-not-active',
    ],
    [
      'tenancy not enabled',
      { ...ok, tenancyEnabled: false },
      'tenancy-not-enabled',
    ],
    [
      'unknown role posture',
      { ...ok, rolePosture: undefined },
      'role-posture-unknown',
    ],
    [
      'superuser role',
      { ...ok, rolePosture: { rolsuper: true, rolbypassrls: false } },
      'role-bypasses-rls',
    ],
    [
      'bypassrls role',
      { ...ok, rolePosture: { rolsuper: false, rolbypassrls: true } },
      'role-bypasses-rls',
    ],
    [
      'table without FORCE',
      {
        ...ok,
        ceilingTables: [{ ...ok.ceilingTables[0], forceRowSecurity: false }],
      },
      'ceiling-table-not-forced',
    ],
    [
      'table without policies',
      { ...ok, ceilingTables: [{ ...ok.ceilingTables[0], policyCount: 0 }] },
      'ceiling-table-not-forced',
    ],
  ])('refuses %s without throwing', (_name, state, reason) => {
    const result = assertGuestRuntimeActive(state);
    expect(result.active).toBe(false);
    if (!result.active) {
      expect(result.reason).toBe(reason);
      expect(result.detail.length).toBeGreaterThan(0);
    }
  });

  it.each([
    ['empty posture', {}],
    ['missing rolsuper', { rolbypassrls: false }],
    ['missing rolbypassrls', { rolsuper: false }],
    ['non-boolean attributes', { rolsuper: 'f', rolbypassrls: 0 }],
  ])('refuses %s as unverified', (_n, rolePosture) => {
    const result = assertGuestRuntimeActive({
      ...ok,
      rolePosture: rolePosture as never,
    });
    expect(result).toMatchObject({
      active: false,
      reason: 'role-posture-unknown',
    });
  });

  it('refuses truthy-but-not-true flags and loose table posture', () => {
    expect(
      assertGuestRuntimeActive({ ...ok, postgresRls: 'yes' as never }),
    ).toMatchObject({ active: false, reason: 'rls-not-active' });
    expect(
      assertGuestRuntimeActive({ ...ok, tenancyEnabled: 1 as never }),
    ).toMatchObject({ active: false, reason: 'tenancy-not-enabled' });
    for (const bad of [
      { rowSecurity: undefined },
      { forceRowSecurity: undefined },
      { policyCount: undefined },
      { policyCount: '2' },
    ]) {
      expect(
        assertGuestRuntimeActive({
          ...ok,
          ceilingTables: [{ ...ok.ceilingTables[0], ...bad } as never],
        }),
      ).toMatchObject({ active: false, reason: 'ceiling-table-not-forced' });
    }
  });

  it('refuses when the ceiling posture was never read', () => {
    const { ceilingTables: _c, ...rest } = ok;
    const result = assertGuestRuntimeActive(rest);
    expect(result).toMatchObject({
      active: false,
      reason: 'ceiling-posture-unknown',
    });
  });

  it('refuses an expected ceiling table with no posture row', () => {
    const result = assertGuestRuntimeActive({
      ...ok,
      expectedCeilingTables: ['products', 'events'],
    });
    expect(result).toMatchObject({
      active: false,
      reason: 'ceiling-posture-unknown',
    });
  });

  it('reads tenancy state itself when not supplied', () => {
    const { tenancyEnabled: _t, ...rest } = ok;
    // Tenancy is not enabled in this process, so the gate refuses.
    const result = assertGuestRuntimeActive(rest);
    expect(result.active).toBe(false);
  });
});
