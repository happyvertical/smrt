/**
 * smrt#3036: `hierarchyPath` / `hierarchyLevel` are maintained by the
 * framework on every Tenant save, not only by `TenantCollection.createChild()`.
 *
 * The consumer shape that motivated this: tenants created first and parented
 * afterwards (or through STI subclasses and plain saves) kept a correct
 * `parentTenantId` but an EMPTY path at level 0 forever, so
 * `inheritsToDescendants` and the declared ancestor-read policy — both of which
 * walk the materialized path — silently did nothing.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getChangesSince, getTableVersion } from '@happyvertical/smrt-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionCollection } from '../collections/PermissionCollection.js';
import {
  TenantCollection,
  TenantHierarchyError,
} from '../collections/TenantCollection.js';
import { TenantPermissionOverrideCollection } from '../collections/TenantPermissionOverrideCollection.js';
import { MAX_TENANT_HIERARCHY_DEPTH, type Tenant } from '../models/Tenant.js';
import { PermissionResolver } from '../services/PermissionResolver.js';
import { TenantPermissionEffect } from '../types/index.js';

describe('Tenant hierarchy is maintained on save', () => {
  let dbPath: string;
  let tenants: TenantCollection;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-tenant-hierarchy-${randomUUID()}.db`);
    tenants = await TenantCollection.create({
      db: { type: 'sqlite' as const, url: dbPath },
    });
  });

  afterEach(() => {
    if (existsSync(dbPath)) rmSync(dbPath, { force: true });
  });

  async function stored(tenant: Tenant | string) {
    const id = typeof tenant === 'string' ? tenant : (tenant.id as string);
    const row = await tenants.get({ id });
    return { path: row?.hierarchyPath, level: row?.hierarchyLevel };
  }

  async function root(name: string) {
    return await tenants.create({ name });
  }

  it('materializes a tenant parented AFTER creation (the consumer shape)', async () => {
    const network = await root('Network');
    const publication = await root('Publication');
    expect(await stored(publication)).toEqual({ path: '', level: 0 });

    publication.parentTenantId = network.id;
    await publication.save();

    expect(await stored(publication)).toEqual({
      path: network.id,
      level: 1,
    });
  });

  it('derives the fields from parentTenantId, ignoring supplied values', async () => {
    const network = await root('Network');
    const child = await tenants.create({
      name: 'Child',
      parentTenantId: network.id,
      hierarchyPath: 'forged-ancestor',
      hierarchyLevel: 7,
    });
    expect(await stored(child)).toEqual({ path: network.id, level: 1 });

    const rootWithPath = await tenants.create({
      name: 'Root',
      hierarchyPath: `${network.id}`,
      hierarchyLevel: 3,
    });
    expect(await stored(rootWithPath)).toEqual({ path: '', level: 0 });
  });

  it('re-materializes every descendant when a tenant is reparented by a plain save', async () => {
    const a = await root('A');
    const b = await root('B');
    const child = await tenants.createChild(a.id as string, { name: 'Child' });
    const grandchild = await tenants.createChild(child.id as string, {
      name: 'Grandchild',
    });
    const greatGrandchild = await tenants.createChild(grandchild.id as string, {
      name: 'Great-grandchild',
    });

    const moving = await tenants.get({ id: child.id as string });
    if (!moving) throw new Error('missing child');
    moving.parentTenantId = b.id;
    await moving.save();

    expect(await stored(child)).toEqual({ path: b.id, level: 1 });
    expect(await stored(grandchild)).toEqual({
      path: `${b.id}/${child.id}`,
      level: 2,
    });
    expect(await stored(greatGrandchild)).toEqual({
      path: `${b.id}/${child.id}/${grandchild.id}`,
      level: 3,
    });
    expect(
      await tenants.validateHierarchy(greatGrandchild.id as string),
    ).toEqual([]);
  });

  it('records rewritten descendants in the change feed', async () => {
    const a = await root('A');
    const b = await root('B');
    const child = await tenants.createChild(a.id as string, { name: 'Child' });
    const grandchild = await tenants.createChild(child.id as string, {
      name: 'Grandchild',
    });
    const since = await getTableVersion(tenants.db, 'tenants');

    await tenants.moveToParent(child.id as string, b.id as string);

    const page = await getChangesSince(tenants.db, {
      since,
      tables: ['tenants'],
    });
    const rowIds = page.changes.map((change) => change.rowId);
    expect(rowIds).toContain(child.id);
    expect(rowIds).toContain(grandchild.id);
  });

  it('re-materializes descendants when a tenant becomes a root', async () => {
    const a = await root('A');
    const child = await tenants.createChild(a.id as string, { name: 'Child' });
    const grandchild = await tenants.createChild(child.id as string, {
      name: 'Grandchild',
    });

    await tenants.makeRoot(child.id as string);

    expect(await stored(child)).toEqual({ path: '', level: 0 });
    expect(await stored(grandchild)).toEqual({ path: child.id, level: 1 });
  });

  it('heals stale descendants even when their paths were never materialized', async () => {
    const a = await root('A');
    const b = await root('B');
    const child = await root('Child');
    const grandchild = await root('Grandchild');
    // Parent links written without any path maintenance, as legacy rows were.
    await tenants.db.query(
      'UPDATE tenants SET parent_tenant_id = ? WHERE id = ?',
      a.id,
      child.id,
    );
    await tenants.db.query(
      'UPDATE tenants SET parent_tenant_id = ? WHERE id = ?',
      child.id,
      grandchild.id,
    );

    await tenants.moveToParent(child.id as string, b.id as string);

    expect(await stored(child)).toEqual({ path: b.id, level: 1 });
    expect(await stored(grandchild)).toEqual({
      path: `${b.id}/${child.id}`,
      level: 2,
    });
  });

  it('refuses a cycle before writing anything', async () => {
    const a = await root('A');
    const child = await tenants.createChild(a.id as string, { name: 'Child' });
    const grandchild = await tenants.createChild(child.id as string, {
      name: 'Grandchild',
    });

    const loop = await tenants.get({ id: a.id as string });
    if (!loop) throw new Error('missing root');
    loop.parentTenantId = grandchild.id;
    const error = await loop.save().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TenantHierarchyError);
    expect((error as TenantHierarchyError).code).toBe('CIRCULAR_REFERENCE');

    const reloaded = await tenants.get({ id: a.id as string });
    expect(reloaded?.parentTenantId ?? null).toBeNull();
    expect(await stored(grandchild)).toEqual({
      path: `${a.id}/${child.id}`,
      level: 2,
    });

    await expect(
      tenants.moveToParent(a.id as string, grandchild.id as string),
    ).rejects.toThrow(TenantHierarchyError);
  });

  it('refuses a missing parent', async () => {
    const orphan = await root('Orphan');
    orphan.parentTenantId = randomUUID();
    const error = await orphan.save().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TenantHierarchyError);
    expect((error as TenantHierarchyError).code).toBe('PARENT_NOT_FOUND');
  });

  it('refuses a reparent that would push a descendant past the depth limit', async () => {
    // A chain whose deepest node sits at the maximum allowed level.
    const chain: Tenant[] = [await root('L0')];
    for (let level = 1; level < MAX_TENANT_HIERARCHY_DEPTH; level++) {
      chain.push(
        await tenants.createChild(chain[level - 1].id as string, {
          name: `L${level}`,
        }),
      );
    }
    await expect(
      tenants.createChild(chain[chain.length - 1].id as string, {
        name: 'too deep',
      }),
    ).rejects.toThrow(TenantHierarchyError);

    // Hanging the chain's root under another tenant would push the leaf over.
    const host = await root('Host');
    const error = await tenants
      .moveToParent(chain[0].id as string, host.id as string)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TenantHierarchyError);
    expect((error as TenantHierarchyError).code).toBe('MAX_DEPTH_EXCEEDED');

    // Nothing moved.
    expect(await stored(chain[0])).toEqual({ path: '', level: 0 });
    expect((await stored(chain[chain.length - 1])).level).toBe(
      MAX_TENANT_HIERARCHY_DEPTH - 1,
    );
  });
});

describe('PermissionResolver chain when an ancestor read returns nothing', () => {
  let dbPath: string;

  afterEach(() => {
    vi.restoreAllMocks();
    if (existsSync(dbPath)) rmSync(dbPath, { force: true });
  });

  it('walks the real chain root-first; display truncates at the nearest readable ancestor; authorization fails closed', async () => {
    dbPath = join(tmpdir(), `smrt-tenant-chain-${randomUUID()}.db`);
    const options = { db: { type: 'sqlite' as const, url: dbPath } };
    const tenants = await TenantCollection.create(options);
    const root = await tenants.create({ name: 'Root' });
    const mid = await tenants.createChild(root.id as string, { name: 'Mid' });
    const leaf = await tenants.createChild(mid.id as string, { name: 'Leaf' });
    // Force the parent-link walk (a never-materialized leaf).
    await tenants.db.query(
      'UPDATE tenants SET hierarchy_path = ?, hierarchy_level = 0 WHERE id = ?',
      '',
      leaf.id,
    );
    const resolver = await PermissionResolver.create(options);

    // With every row readable the walk returns the whole chain ROOT FIRST,
    // and the cascade applies it in that order: the mid-level GRANT is more
    // specific than the root DENY and wins. Both flip if the walk inverts.
    expect(
      (await resolver.getTenantInheritanceChain(leaf.id as string)).map(
        (link) => link.tenant.id,
      ),
    ).toEqual([root.id, mid.id, leaf.id]);
    const permissions = await PermissionCollection.create(options);
    const overrides = await TenantPermissionOverrideCollection.create(options);
    const permission = await permissions.create({
      slug: 'articles.read',
      name: 'articles.read',
    });
    await overrides.create({
      tenantId: root.id,
      permissionId: permission.id,
      effect: TenantPermissionEffect.DENY,
    });
    await overrides.create({
      tenantId: mid.id,
      permissionId: permission.id,
      effect: TenantPermissionEffect.GRANT,
    });
    const cascaded = await resolver.resolveTenantPermissions(leaf.id as string);
    expect([...cascaded.permissions]).toEqual(['articles.read']);
    expect([...cascaded.deniedPermissions]).toEqual([]);

    // A filter that silently hides the root row (as RLS would): no
    // interceptor registration can produce this, so stub the read.
    const realGet = TenantCollection.prototype.get;
    vi.spyOn(TenantCollection.prototype, 'get').mockImplementation(
      async function (this: TenantCollection, filter) {
        const id = (filter as { id?: string }).id;
        if (id === root.id) return null;
        return await realGet.call(this, filter);
      },
    );

    const chain = await resolver.getTenantInheritanceChain(leaf.id as string);
    expect(chain.map((link) => link.tenant.id)).toEqual([mid.id, leaf.id]);

    await expect(
      resolver.resolveTenantPermissions(leaf.id as string),
    ).rejects.toMatchObject({ code: 'PARENT_NOT_FOUND' });
  });
});
