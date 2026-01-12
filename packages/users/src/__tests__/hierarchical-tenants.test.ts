/**
 * Hierarchical Tenants Tests
 *
 * Tests for multi-level tenant hierarchies with cascade-controlled permissions:
 * 1. Tenant hierarchy creation and management
 * 2. Tree traversal (ancestors, descendants, siblings)
 * 3. Permission inheritance with cascade control
 * 4. Tenant permission overrides (grant/deny/inherit)
 * 5. Breaking inheritance chains
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PermissionCollection } from '../collections/PermissionCollection.js';
import {
  TenantCollection,
  TenantHierarchyError,
} from '../collections/TenantCollection.js';
import { TenantPermissionOverrideCollection } from '../collections/TenantPermissionOverrideCollection.js';
import { MAX_TENANT_HIERARCHY_DEPTH } from '../models/Tenant.js';
import { PermissionResolver } from '../services/PermissionResolver.js';
import { TenantPermissionEffect } from '../types/index.js';

describe('Tenant Hierarchy', () => {
  let dbPath: string;
  let tenants: TenantCollection;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-hierarchy-test-${Date.now()}.db`);
    tenants = await TenantCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
  });

  afterEach(() => {
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch (err) {
        console.warn(`Test cleanup warning: failed to remove ${dbPath}:`, err);
      }
    }
  });

  describe('Root Tenant Creation', () => {
    it('should create a root tenant with default hierarchy values', async () => {
      const root = await tenants.create({ name: 'Root Corp' });
      await root.save();

      expect(root.parentTenantId).toBeUndefined();
      expect(root.hierarchyLevel).toBe(0);
      expect(root.hierarchyPath).toBe('');
      expect(root.cascadePermissions).toBe(true);
      expect(root.inheritPermissions).toBe(true);
      expect(root.isRoot()).toBe(true);
    });

    it('should find all root tenants', async () => {
      const root1 = await tenants.create({ name: 'Root 1' });
      await root1.save();

      const root2 = await tenants.create({ name: 'Root 2' });
      await root2.save();

      const roots = await tenants.findRoots();
      expect(roots.length).toBe(2);
      expect(roots.map((r) => r.name).sort()).toEqual(['Root 1', 'Root 2']);
    });
  });

  describe('Child Tenant Creation', () => {
    it('should create a child tenant with correct hierarchy values', async () => {
      const root = await tenants.create({ name: 'Parent Corp' });
      await root.save();

      const child = await tenants.createChild(root.id!, {
        name: 'Child Division',
      });

      expect(child.parentTenantId).toBe(root.id);
      expect(child.hierarchyLevel).toBe(1);
      expect(child.hierarchyPath).toBe(root.id);
      expect(child.isRoot()).toBe(false);
    });

    it('should create grandchild tenant with correct hierarchy path', async () => {
      const root = await tenants.create({ name: 'Root' });
      await root.save();

      const child = await tenants.createChild(root.id!, { name: 'Child' });
      const grandchild = await tenants.createChild(child.id!, {
        name: 'Grandchild',
      });

      expect(grandchild.parentTenantId).toBe(child.id);
      expect(grandchild.hierarchyLevel).toBe(2);
      expect(grandchild.hierarchyPath).toBe(`${root.id}/${child.id}`);
    });

    it('should respect cascade permission settings on child creation', async () => {
      const root = await tenants.create({ name: 'Root' });
      await root.save();

      const child = await tenants.createChild(root.id!, {
        name: 'Independent Child',
        inheritPermissions: false,
        cascadePermissions: false,
      });

      expect(child.inheritPermissions).toBe(false);
      expect(child.cascadePermissions).toBe(false);
    });

    it('should throw error for non-existent parent', async () => {
      await expect(
        tenants.createChild('non-existent-id', { name: 'Orphan' }),
      ).rejects.toThrow(TenantHierarchyError);
    });

    it('should enforce maximum hierarchy depth', async () => {
      // Create a chain up to max depth
      let current = await tenants.create({ name: 'Level 0' });
      await current.save();

      for (let i = 1; i < MAX_TENANT_HIERARCHY_DEPTH; i++) {
        current = await tenants.createChild(current.id!, { name: `Level ${i}` });
      }

      // Trying to create one more should fail
      await expect(
        tenants.createChild(current.id!, { name: 'Too Deep' }),
      ).rejects.toThrow(TenantHierarchyError);
    });
  });

  describe('Tree Traversal', () => {
    let root: Awaited<ReturnType<typeof tenants.create>>;
    let child1: Awaited<ReturnType<typeof tenants.create>>;
    let child2: Awaited<ReturnType<typeof tenants.create>>;
    let grandchild1: Awaited<ReturnType<typeof tenants.create>>;
    let grandchild2: Awaited<ReturnType<typeof tenants.create>>;

    beforeEach(async () => {
      // Create hierarchy:
      // root
      // ├── child1
      // │   ├── grandchild1
      // │   └── grandchild2
      // └── child2
      root = await tenants.create({ name: 'Root' });
      await root.save();

      child1 = await tenants.createChild(root.id!, { name: 'Child 1' });
      child2 = await tenants.createChild(root.id!, { name: 'Child 2' });

      grandchild1 = await tenants.createChild(child1.id!, {
        name: 'Grandchild 1',
      });
      grandchild2 = await tenants.createChild(child1.id!, {
        name: 'Grandchild 2',
      });
    });

    it('should find direct children', async () => {
      const rootChildren = await tenants.findChildren(root.id!);
      expect(rootChildren.length).toBe(2);
      expect(rootChildren.map((c) => c.name).sort()).toEqual([
        'Child 1',
        'Child 2',
      ]);

      const child1Children = await tenants.findChildren(child1.id!);
      expect(child1Children.length).toBe(2);
      expect(child1Children.map((c) => c.name).sort()).toEqual([
        'Grandchild 1',
        'Grandchild 2',
      ]);

      const child2Children = await tenants.findChildren(child2.id!);
      expect(child2Children.length).toBe(0);
    });

    it('should find parent tenant', async () => {
      const parent = await tenants.findParent(grandchild1.id!);
      expect(parent?.id).toBe(child1.id);

      const rootParent = await tenants.findParent(root.id!);
      expect(rootParent).toBeNull();
    });

    it('should get ancestors from immediate parent to root', async () => {
      const ancestors = await tenants.getAncestors(grandchild1.id!);
      expect(ancestors.length).toBe(2);
      expect(ancestors[0].id).toBe(child1.id); // Immediate parent first
      expect(ancestors[1].id).toBe(root.id); // Root last
    });

    it('should get ancestors from root to immediate parent', async () => {
      const ancestors = await tenants.getAncestorsFromRoot(grandchild1.id!);
      expect(ancestors.length).toBe(2);
      expect(ancestors[0].id).toBe(root.id); // Root first
      expect(ancestors[1].id).toBe(child1.id); // Immediate parent last
    });

    it('should get all descendants', async () => {
      const descendants = await tenants.getDescendants(root.id!);
      expect(descendants.length).toBe(4); // child1, child2, grandchild1, grandchild2

      const child1Descendants = await tenants.getDescendants(child1.id!);
      expect(child1Descendants.length).toBe(2); // grandchild1, grandchild2
    });

    it('should get siblings', async () => {
      const siblings = await tenants.getSiblings(child1.id!);
      expect(siblings.length).toBe(1);
      expect(siblings[0].id).toBe(child2.id);

      const grandchildSiblings = await tenants.getSiblings(grandchild1.id!);
      expect(grandchildSiblings.length).toBe(1);
      expect(grandchildSiblings[0].id).toBe(grandchild2.id);
    });

    it('should check ancestor relationship', async () => {
      expect(await tenants.isAncestorOf(root.id!, grandchild1.id!)).toBe(true);
      expect(await tenants.isAncestorOf(child1.id!, grandchild1.id!)).toBe(
        true,
      );
      expect(await tenants.isAncestorOf(child2.id!, grandchild1.id!)).toBe(
        false,
      );
      expect(await tenants.isAncestorOf(grandchild1.id!, root.id!)).toBe(false);
    });

    it('should check descendant relationship', async () => {
      expect(await tenants.isDescendantOf(grandchild1.id!, root.id!)).toBe(
        true,
      );
      expect(await tenants.isDescendantOf(grandchild1.id!, child1.id!)).toBe(
        true,
      );
      expect(await tenants.isDescendantOf(grandchild1.id!, child2.id!)).toBe(
        false,
      );
    });
  });

  describe('Moving Tenants', () => {
    it('should move tenant to new parent', async () => {
      const root = await tenants.create({ name: 'Root' });
      await root.save();

      const child1 = await tenants.createChild(root.id!, { name: 'Child 1' });
      const child2 = await tenants.createChild(root.id!, { name: 'Child 2' });

      // Move child2 under child1
      await tenants.moveToParent(child2.id!, child1.id!);

      const updated = await tenants.get({ id: child2.id });
      expect(updated?.parentTenantId).toBe(child1.id);
      expect(updated?.hierarchyLevel).toBe(2);
      expect(updated?.hierarchyPath).toBe(`${root.id}/${child1.id}`);
    });

    it('should update descendants when moving parent', async () => {
      const root1 = await tenants.create({ name: 'Root 1' });
      await root1.save();

      const root2 = await tenants.create({ name: 'Root 2' });
      await root2.save();

      const child = await tenants.createChild(root1.id!, { name: 'Child' });
      const grandchild = await tenants.createChild(child.id!, {
        name: 'Grandchild',
      });

      // Move child (and its descendants) under root2
      await tenants.moveToParent(child.id!, root2.id!);

      const updatedGrandchild = await tenants.get({ id: grandchild.id });
      expect(updatedGrandchild?.hierarchyPath).toBe(`${root2.id}/${child.id}`);
      expect(updatedGrandchild?.hierarchyLevel).toBe(2);
    });

    it('should make tenant a root', async () => {
      const root = await tenants.create({ name: 'Root' });
      await root.save();

      const child = await tenants.createChild(root.id!, { name: 'Child' });

      await tenants.makeRoot(child.id!);

      const updated = await tenants.get({ id: child.id });
      expect(updated?.parentTenantId).toBeNull();
      expect(updated?.hierarchyLevel).toBe(0);
      expect(updated?.hierarchyPath).toBe('');
    });

    it('should prevent circular reference - moving to self', async () => {
      const root = await tenants.create({ name: 'Root' });
      await root.save();

      await expect(tenants.moveToParent(root.id!, root.id!)).rejects.toThrow(
        TenantHierarchyError,
      );
    });

    it('should prevent circular reference - moving to descendant', async () => {
      const root = await tenants.create({ name: 'Root' });
      await root.save();

      const child = await tenants.createChild(root.id!, { name: 'Child' });
      const grandchild = await tenants.createChild(child.id!, {
        name: 'Grandchild',
      });

      await expect(
        tenants.moveToParent(root.id!, grandchild.id!),
      ).rejects.toThrow(TenantHierarchyError);
    });
  });

  describe('Hierarchy Validation', () => {
    it('should validate correct hierarchy', async () => {
      const root = await tenants.create({ name: 'Root' });
      await root.save();

      const child = await tenants.createChild(root.id!, { name: 'Child' });

      const rootErrors = await tenants.validateHierarchy(root.id!);
      expect(rootErrors).toEqual([]);

      const childErrors = await tenants.validateHierarchy(child.id!);
      expect(childErrors).toEqual([]);
    });

    it('should detect hierarchy level mismatch', async () => {
      const root = await tenants.create({ name: 'Root' });
      await root.save();

      const child = await tenants.createChild(root.id!, { name: 'Child' });

      // Manually corrupt the hierarchy level
      child.hierarchyLevel = 5;
      await child.save();

      const errors = await tenants.validateHierarchy(child.id!);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain('level mismatch');
    });
  });

  describe('Get Tree Structure', () => {
    it('should return nested tree structure', async () => {
      const root = await tenants.create({ name: 'Root' });
      await root.save();

      const child1 = await tenants.createChild(root.id!, { name: 'Child 1' });
      const child2 = await tenants.createChild(root.id!, { name: 'Child 2' });
      await tenants.createChild(child1.id!, { name: 'Grandchild' });

      const tree = await tenants.getTree();
      expect(tree.length).toBe(1); // One root

      const rootNode = tree[0];
      expect(rootNode.name).toBe('Root');
      expect(rootNode.children.length).toBe(2);

      const child1Node = rootNode.children.find((c) => c.name === 'Child 1');
      expect(child1Node?.children.length).toBe(1);
      expect(child1Node?.children[0].name).toBe('Grandchild');
    });
  });
});

describe('Tenant Permission Overrides', () => {
  let dbPath: string;
  let tenants: TenantCollection;
  let permissions: PermissionCollection;
  let tenantOverrides: TenantPermissionOverrideCollection;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-override-test-${Date.now()}.db`);
    const options = { db: { type: 'sqlite' as const, url: dbPath } };

    tenants = await TenantCollection.create(options);
    permissions = await PermissionCollection.create(options);
    tenantOverrides = await TenantPermissionOverrideCollection.create(options);
  });

  afterEach(() => {
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch (err) {
        console.warn(`Test cleanup warning: failed to remove ${dbPath}:`, err);
      }
    }
  });

  it('should grant permission at tenant level', async () => {
    const tenant = await tenants.create({ name: 'Test Tenant' });
    await tenant.save();

    const perm = await permissions.create({
      slug: 'articles.create',
      name: 'Create Articles',
    });
    await perm.save();

    await tenantOverrides.grantPermission(tenant.id!, perm.id!);

    const grantedIds = await tenantOverrides.getGrantedPermissionIds(
      tenant.id!,
    );
    expect(grantedIds).toContain(perm.id);
  });

  it('should deny permission at tenant level', async () => {
    const tenant = await tenants.create({ name: 'Test Tenant' });
    await tenant.save();

    const perm = await permissions.create({
      slug: 'articles.delete',
      name: 'Delete Articles',
    });
    await perm.save();

    await tenantOverrides.denyPermission(tenant.id!, perm.id!);

    const deniedIds = await tenantOverrides.getDeniedPermissionIds(tenant.id!);
    expect(deniedIds).toContain(perm.id);
  });

  it('should get overrides organized by effect', async () => {
    const tenant = await tenants.create({ name: 'Test Tenant' });
    await tenant.save();

    const grantPerm = await permissions.create({
      slug: 'perm.grant',
      name: 'Grant',
    });
    await grantPerm.save();

    const denyPerm = await permissions.create({
      slug: 'perm.deny',
      name: 'Deny',
    });
    await denyPerm.save();

    const inheritPerm = await permissions.create({
      slug: 'perm.inherit',
      name: 'Inherit',
    });
    await inheritPerm.save();

    await tenantOverrides.grantPermission(tenant.id!, grantPerm.id!);
    await tenantOverrides.denyPermission(tenant.id!, denyPerm.id!);
    await tenantOverrides.inheritPermission(tenant.id!, inheritPerm.id!);

    const result = await tenantOverrides.getOverridesByEffect(tenant.id!);

    expect(result.grantedPermissionIds).toContain(grantPerm.id);
    expect(result.deniedPermissionIds).toContain(denyPerm.id);
    expect(result.inheritedPermissionIds).toContain(inheritPerm.id);
  });

  it('should update existing override', async () => {
    const tenant = await tenants.create({ name: 'Test Tenant' });
    await tenant.save();

    const perm = await permissions.create({
      slug: 'articles.update',
      name: 'Update',
    });
    await perm.save();

    // First grant
    await tenantOverrides.grantPermission(tenant.id!, perm.id!);
    let result = await tenantOverrides.getOverridesByEffect(tenant.id!);
    expect(result.grantedPermissionIds).toContain(perm.id);

    // Then deny (should update, not create new)
    await tenantOverrides.denyPermission(tenant.id!, perm.id!);
    result = await tenantOverrides.getOverridesByEffect(tenant.id!);
    expect(result.deniedPermissionIds).toContain(perm.id);
    expect(result.grantedPermissionIds).not.toContain(perm.id);
  });

  it('should remove override', async () => {
    const tenant = await tenants.create({ name: 'Test Tenant' });
    await tenant.save();

    const perm = await permissions.create({
      slug: 'articles.view',
      name: 'View',
    });
    await perm.save();

    await tenantOverrides.grantPermission(tenant.id!, perm.id!);
    expect(
      await tenantOverrides.getGrantedPermissionIds(tenant.id!),
    ).toContain(perm.id);

    const removed = await tenantOverrides.removeOverride(tenant.id!, perm.id!);
    expect(removed).toBe(true);

    expect(
      await tenantOverrides.getGrantedPermissionIds(tenant.id!),
    ).not.toContain(perm.id);
  });

  it('should copy overrides between tenants', async () => {
    const tenant1 = await tenants.create({ name: 'Source' });
    await tenant1.save();

    const tenant2 = await tenants.create({ name: 'Target' });
    await tenant2.save();

    const perm1 = await permissions.create({ slug: 'perm.1', name: 'Perm 1' });
    await perm1.save();

    const perm2 = await permissions.create({ slug: 'perm.2', name: 'Perm 2' });
    await perm2.save();

    await tenantOverrides.grantPermission(tenant1.id!, perm1.id!);
    await tenantOverrides.denyPermission(tenant1.id!, perm2.id!);

    await tenantOverrides.copyOverrides(tenant1.id!, tenant2.id!);

    const result = await tenantOverrides.getOverridesByEffect(tenant2.id!);
    expect(result.grantedPermissionIds).toContain(perm1.id);
    expect(result.deniedPermissionIds).toContain(perm2.id);
  });
});

describe('Permission Inheritance with Cascade Control', () => {
  let dbPath: string;
  let tenants: TenantCollection;
  let permissions: PermissionCollection;
  let tenantOverrides: TenantPermissionOverrideCollection;
  let resolver: PermissionResolver;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-cascade-test-${Date.now()}.db`);
    const options = { db: { type: 'sqlite' as const, url: dbPath } };

    tenants = await TenantCollection.create(options);
    permissions = await PermissionCollection.create(options);
    tenantOverrides = await TenantPermissionOverrideCollection.create(options);
    resolver = await PermissionResolver.create(options);
  });

  afterEach(() => {
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch (err) {
        console.warn(`Test cleanup warning: failed to remove ${dbPath}:`, err);
      }
    }
  });

  it('should inherit permissions from parent tenant', async () => {
    // Create hierarchy: parent -> child
    const parent = await tenants.create({
      name: 'Parent',
      cascadePermissions: true,
    });
    await parent.save();

    const child = await tenants.createChild(parent.id!, {
      name: 'Child',
      inheritPermissions: true,
    });

    // Grant permission at parent level
    const perm = await permissions.create({
      slug: 'reports.view',
      name: 'View Reports',
    });
    await perm.save();

    await tenantOverrides.grantPermission(parent.id!, perm.id!);

    // Resolve child's permissions
    const result = await resolver.resolveTenantPermissions(child.id!);

    expect(result.permissions.has('reports.view')).toBe(true);
    expect(result.inheritanceActive).toBe(true);
    expect(result.contributingTenantIds).toContain(child.id);
  });

  it('should NOT inherit when child sets inheritPermissions: false', async () => {
    const parent = await tenants.create({
      name: 'Parent',
      cascadePermissions: true,
    });
    await parent.save();

    const child = await tenants.createChild(parent.id!, {
      name: 'Independent Child',
      inheritPermissions: false, // Block inheritance
    });

    const perm = await permissions.create({
      slug: 'admin.access',
      name: 'Admin Access',
    });
    await perm.save();

    await tenantOverrides.grantPermission(parent.id!, perm.id!);

    const result = await resolver.resolveTenantPermissions(child.id!);

    expect(result.permissions.has('admin.access')).toBe(false);
    expect(result.inheritanceActive).toBe(false);
  });

  it('should NOT cascade when parent sets cascadePermissions: false', async () => {
    const parent = await tenants.create({
      name: 'Non-cascading Parent',
      cascadePermissions: false, // Don't cascade
    });
    await parent.save();

    const child = await tenants.createChild(parent.id!, {
      name: 'Child',
      inheritPermissions: true,
    });

    const perm = await permissions.create({
      slug: 'special.access',
      name: 'Special Access',
    });
    await perm.save();

    await tenantOverrides.grantPermission(parent.id!, perm.id!);

    const result = await resolver.resolveTenantPermissions(child.id!);

    expect(result.permissions.has('special.access')).toBe(false);
  });

  it('should allow child to override inherited permission with DENY', async () => {
    const parent = await tenants.create({
      name: 'Parent',
      cascadePermissions: true,
    });
    await parent.save();

    const child = await tenants.createChild(parent.id!, {
      name: 'Child',
      inheritPermissions: true,
    });

    const perm = await permissions.create({
      slug: 'dangerous.action',
      name: 'Dangerous Action',
    });
    await perm.save();

    // Parent grants the permission
    await tenantOverrides.grantPermission(parent.id!, perm.id!);

    // Child explicitly denies it
    await tenantOverrides.denyPermission(child.id!, perm.id!);

    const result = await resolver.resolveTenantPermissions(child.id!);

    expect(result.permissions.has('dangerous.action')).toBe(false);
  });

  it('should allow child to GRANT permission not in parent', async () => {
    const parent = await tenants.create({
      name: 'Parent',
      cascadePermissions: true,
    });
    await parent.save();

    const child = await tenants.createChild(parent.id!, {
      name: 'Child',
      inheritPermissions: true,
    });

    const perm = await permissions.create({
      slug: 'child.only',
      name: 'Child Only Permission',
    });
    await perm.save();

    // Only child grants this permission
    await tenantOverrides.grantPermission(child.id!, perm.id!);

    const parentResult = await resolver.resolveTenantPermissions(parent.id!);
    const childResult = await resolver.resolveTenantPermissions(child.id!);

    expect(parentResult.permissions.has('child.only')).toBe(false);
    expect(childResult.permissions.has('child.only')).toBe(true);
  });

  it('should cascade through multiple levels', async () => {
    // Create 3-level hierarchy
    const root = await tenants.create({
      name: 'Root',
      cascadePermissions: true,
    });
    await root.save();

    const middle = await tenants.createChild(root.id!, {
      name: 'Middle',
      inheritPermissions: true,
      cascadePermissions: true,
    });

    const leaf = await tenants.createChild(middle.id!, {
      name: 'Leaf',
      inheritPermissions: true,
    });

    const perm = await permissions.create({
      slug: 'global.policy',
      name: 'Global Policy',
    });
    await perm.save();

    await tenantOverrides.grantPermission(root.id!, perm.id!);

    const leafResult = await resolver.resolveTenantPermissions(leaf.id!);

    expect(leafResult.permissions.has('global.policy')).toBe(true);
    expect(leafResult.inheritanceActive).toBe(true);
  });

  it('should break cascade chain in the middle', async () => {
    const root = await tenants.create({
      name: 'Root',
      cascadePermissions: true,
    });
    await root.save();

    // Middle breaks the chain
    const middle = await tenants.createChild(root.id!, {
      name: 'Middle (breaks chain)',
      inheritPermissions: false, // Breaks inheritance
      cascadePermissions: true, // But would cascade its own
    });

    const leaf = await tenants.createChild(middle.id!, {
      name: 'Leaf',
      inheritPermissions: true,
    });

    const perm = await permissions.create({
      slug: 'root.policy',
      name: 'Root Policy',
    });
    await perm.save();

    await tenantOverrides.grantPermission(root.id!, perm.id!);

    const leafResult = await resolver.resolveTenantPermissions(leaf.id!);

    // Leaf should NOT have root's permission because middle broke the chain
    expect(leafResult.permissions.has('root.policy')).toBe(false);
  });

  it('should get inheritance chain for debugging', async () => {
    const root = await tenants.create({
      name: 'Root',
      cascadePermissions: true,
    });
    await root.save();

    const child = await tenants.createChild(root.id!, {
      name: 'Child',
      inheritPermissions: true,
      cascadePermissions: false,
    });

    const grandchild = await tenants.createChild(child.id!, {
      name: 'Grandchild',
      inheritPermissions: true,
    });

    const chain = await resolver.getTenantInheritanceChain(grandchild.id!);

    expect(chain.length).toBe(3);
    expect(chain[0].tenant.name).toBe('Root');
    expect(chain[0].cascades).toBe(true); // Root cascades to child

    expect(chain[1].tenant.name).toBe('Child');
    expect(chain[1].inherits).toBe(false); // Child doesn't show as inheriting in chain view
    expect(chain[1].cascades).toBe(false); // Child doesn't cascade to grandchild

    expect(chain[2].tenant.name).toBe('Grandchild');
    expect(chain[2].inherits).toBe(true); // Grandchild inherits (but won't get much due to child)
  });
});
