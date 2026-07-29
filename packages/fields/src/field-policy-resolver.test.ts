import { randomUUID } from 'node:crypto';
import {
  field,
  getTestDatabase,
  ObjectRegistry,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import {
  resetTenancy,
  setupTestTenancy,
  TenantIsolationError,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TenantCollection } from '../../users/src/index.js';
import { clearFieldPolicyCache } from './cache.js';
import { FieldPolicyCollection } from './collections/FieldPolicyCollection.js';
import {
  resolveFieldPolicy,
  resolveFieldPolicyExplained,
} from './field-policy-resolver.js';
import type { FieldPolicyTenantHierarchyLoader } from './types.js';

@smrt({
  packageName: '@test/smrt-fields-resolver',
  visibility: 'internal',
  api: false,
  cli: false,
  mcp: false,
})
class PolicyResolverDoc extends SmrtObject {
  @field({ required: true, description: 'Title help' })
  title: string = '';

  @field({ ui: { basic: true, group: 'main', order: 2 } })
  summary: string = '';

  // The scanner only carries an initializer default into the manifest when
  // the decorator omits `type` (annotation inference) — with an explicit
  // `type`, declare `default` explicitly.
  @field({ type: 'integer', default: 3, ui: { order: 5 } })
  priority: number = 3;

  @field({ nullable: true })
  subtitle: string | null = null;

  @field({ ui: { locked: true } })
  theme: string = 'default';

  @field({ sensitive: true })
  secret: string = '';
}

function fixtureRef(): string {
  const registered = ObjectRegistry.getClassByConstructor(PolicyResolverDoc);
  if (!registered?.qualifiedName) {
    throw new Error(
      'PolicyResolverDoc is not registered with a qualified name',
    );
  }
  return registered.qualifiedName;
}

const flatLoader: FieldPolicyTenantHierarchyLoader = async () => null;

describe('resolveFieldPolicy', () => {
  let db: DatabaseInterface;
  let policies: FieldPolicyCollection;
  let objectRef: string;

  beforeEach(async () => {
    setupTestTenancy();
    clearFieldPolicyCache();
    db = await getTestDatabase({ classes: ['FieldPolicy', 'Tenant'] });
    policies = await FieldPolicyCollection.create({ db });
    objectRef = fixtureRef();
  });

  afterEach(async () => {
    clearFieldPolicyCache();
    resetTenancy();
    if (typeof (db as { close?: () => Promise<void> }).close === 'function') {
      await (db as unknown as { close: () => Promise<void> }).close();
    }
  });

  it('rejects unknown objectRefs', async () => {
    await expect(
      resolveFieldPolicy('@test/nowhere:Nope', { db }),
    ).rejects.toThrow(/Unknown field policy objectRef/);
  });

  it('seeds resolution from the manifest (defaults, ui hints, cold-start rule)', async () => {
    const resolved = await resolveFieldPolicy(objectRef, { db });

    // summary carries the only ui.basic marker, so unmarked fields land in
    // the advanced tier.
    expect(resolved.fields.summary.visibility).toBe('basic');
    expect(resolved.fields.summary.group).toBe('main');
    expect(resolved.fields.summary.order).toBe(2);
    expect(resolved.fields.priority.visibility).toBe('advanced');
    expect(resolved.fields.priority.hasDefault).toBe(true);
    expect(resolved.fields.priority.defaultValue).toBe(3);
    expect(resolved.fields.priority.order).toBe(5);

    // Required field with no usable default is forced visible (safety net):
    // its code default '' does not count as usable.
    expect(resolved.fields.title.visibility).toBe('basic');
    expect(resolved.fields.title.visibilityForced).toBe(true);
    expect(resolved.fields.title.required).toBe(true);
    expect(resolved.fields.title.help).toBe('Title help');

    // Code-seeded lock resolves through.
    expect(resolved.fields.theme.locked).toBe(true);
    expect(resolved.fields.theme.hasDefault).toBe(true);
    expect(resolved.fields.theme.defaultValue).toBe('default');

    // The server-side resolver still covers sensitive fields (the batch
    // action strips them for the wire) and never framework system fields.
    expect(resolved.fields.secret).toBeDefined();
    expect(resolved.fields.id).toBeUndefined();
    expect(resolved.fields.slug).toBeUndefined();
    expect(resolved.fields.context).toBeUndefined();
  });

  it('resolves defaults and visibility through app, tenant, and user tiers', async () => {
    const tenantId = randomUUID();
    const userId = randomUUID();

    await policies.create({
      objectRef,
      fieldName: 'summary',
      scopeType: 'app',
      defaultValue: JSON.stringify('app default'),
      help: 'app help',
    });
    await policies.create({
      objectRef,
      fieldName: 'summary',
      scopeType: 'tenant',
      tenantId,
      defaultValue: JSON.stringify('tenant default'),
    });
    await policies.create({
      objectRef,
      fieldName: 'summary',
      scopeType: 'user',
      userId,
      defaultValue: JSON.stringify('user default'),
      visibility: 'hidden',
    });

    const appOnly = await resolveFieldPolicy(objectRef, { db });
    expect(appOnly.fields.summary.defaultValue).toBe('app default');
    expect(appOnly.fields.summary.visibility).toBe('basic');

    const tenantTier = await resolveFieldPolicy(objectRef, {
      db,
      tenantId,
      tenantHierarchyLoader: flatLoader,
    });
    expect(tenantTier.fields.summary.defaultValue).toBe('tenant default');
    // Sparse inheritance: the tenant row set only the default, so help still
    // comes from the app row.
    expect(tenantTier.fields.summary.help).toBe('app help');

    const userTier = await resolveFieldPolicy(objectRef, {
      db,
      tenantId,
      userId,
      tenantHierarchyLoader: flatLoader,
    });
    expect(userTier.fields.summary.defaultValue).toBe('user default');
    expect(userTier.fields.summary.visibility).toBe('hidden');
    expect(userTier.fields.summary.help).toBe('app help');

    // The user tier applies without a tenant too (user rows are keyed by
    // user alone).
    const userNoTenant = await resolveFieldPolicy(objectRef, { db, userId });
    expect(userNoTenant.fields.summary.defaultValue).toBe('user default');
  });

  it('flows lower layers through again when an override row is deleted', async () => {
    const tenantId = randomUUID();

    await policies.create({
      objectRef,
      fieldName: 'summary',
      scopeType: 'app',
      defaultValue: JSON.stringify('app default'),
    });
    const tenantRow = await policies.create({
      objectRef,
      fieldName: 'summary',
      scopeType: 'tenant',
      tenantId,
      defaultValue: JSON.stringify('tenant default'),
    });

    const before = await resolveFieldPolicy(objectRef, {
      db,
      tenantId,
      tenantHierarchyLoader: flatLoader,
    });
    expect(before.fields.summary.defaultValue).toBe('tenant default');

    // Reset = row delete; the delete also invalidates the cache.
    await tenantRow.delete();

    const after = await resolveFieldPolicy(objectRef, {
      db,
      tenantId,
      tenantHierarchyLoader: flatLoader,
    });
    expect(after.fields.summary.defaultValue).toBe('app default');
  });

  it('isolates tenants: another tenant sees neither rows nor cache entries', async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();

    await policies.create({
      objectRef,
      fieldName: 'summary',
      scopeType: 'tenant',
      tenantId: tenantA,
      defaultValue: JSON.stringify('tenant A'),
    });

    const forA = await resolveFieldPolicy(objectRef, {
      db,
      tenantId: tenantA,
      tenantHierarchyLoader: flatLoader,
    });
    const forB = await resolveFieldPolicy(objectRef, {
      db,
      tenantId: tenantB,
      tenantHierarchyLoader: flatLoader,
    });

    expect(forA.fields.summary.defaultValue).toBe('tenant A');
    // Tenant B inherits only the code seed (summary's initializer '').
    expect(forB.fields.summary.defaultValue).toBe('');
  });

  it('fails closed when resolving across an active tenant or user context', async () => {
    const contextTenant = randomUUID();
    const otherTenant = randomUUID();
    const contextUser = randomUUID();
    const otherUser = randomUUID();

    await withTenant(
      {
        tenantId: contextTenant,
        userId: contextUser,
        permissions: new Set<string>(),
      },
      async () => {
        await expect(
          resolveFieldPolicy(objectRef, {
            db,
            tenantId: otherTenant,
            tenantHierarchyLoader: flatLoader,
          }),
        ).rejects.toThrow(TenantIsolationError);

        await expect(
          resolveFieldPolicy(objectRef, {
            db,
            tenantId: contextTenant,
            userId: otherUser,
            tenantHierarchyLoader: flatLoader,
          }),
        ).rejects.toThrow(TenantIsolationError);

        // Own identities resolve fine inside the context.
        const own = await resolveFieldPolicy(objectRef, {
          db,
          tenantId: contextTenant,
          userId: contextUser,
          tenantHierarchyLoader: flatLoader,
        });
        expect(own.objectRef).toBe(objectRef);
      },
    );
  });

  it('walks an injected tenant hierarchy root → leaf', async () => {
    const rootTenant = randomUUID();
    const childTenant = randomUUID();
    const loader: FieldPolicyTenantHierarchyLoader = async () => ({
      async getChain(tenantId: string) {
        if (tenantId !== childTenant) {
          return [];
        }
        return [
          {
            id: rootTenant,
            inheritPermissions: true,
            cascadePermissions: true,
          },
          {
            id: childTenant,
            inheritPermissions: true,
            cascadePermissions: true,
          },
        ];
      },
    });

    await policies.create({
      objectRef,
      fieldName: 'summary',
      scopeType: 'tenant',
      tenantId: rootTenant,
      defaultValue: JSON.stringify('root default'),
      help: 'root help',
    });

    // The ancestor's policy cascades to the child.
    const inherited = await resolveFieldPolicy(objectRef, {
      db,
      tenantId: childTenant,
      tenantHierarchyLoader: loader,
    });
    expect(inherited.fields.summary.defaultValue).toBe('root default');

    // A child row overrides the ancestor sparsely.
    await policies.create({
      objectRef,
      fieldName: 'summary',
      scopeType: 'tenant',
      tenantId: childTenant,
      defaultValue: JSON.stringify('child default'),
    });
    clearFieldPolicyCache();
    const overridden = await resolveFieldPolicy(objectRef, {
      db,
      tenantId: childTenant,
      tenantHierarchyLoader: loader,
    });
    expect(overridden.fields.summary.defaultValue).toBe('child default');
    expect(overridden.fields.summary.help).toBe('root help');
  });

  it('resets the baseline when a chain node breaks permission inheritance', async () => {
    const rootTenant = randomUUID();
    const detachedChild = randomUUID();
    const loader: FieldPolicyTenantHierarchyLoader = async () => ({
      async getChain() {
        return [
          {
            id: rootTenant,
            inheritPermissions: true,
            // Root does not cascade → the child's baseline resets to the
            // app-layer state.
            cascadePermissions: false,
          },
          {
            id: detachedChild,
            inheritPermissions: true,
            cascadePermissions: true,
          },
        ];
      },
    });

    await policies.create({
      objectRef,
      fieldName: 'summary',
      scopeType: 'app',
      defaultValue: JSON.stringify('app default'),
    });
    await policies.create({
      objectRef,
      fieldName: 'summary',
      scopeType: 'tenant',
      tenantId: rootTenant,
      defaultValue: JSON.stringify('root default'),
    });

    const resolved = await resolveFieldPolicy(objectRef, {
      db,
      tenantId: detachedChild,
      tenantHierarchyLoader: loader,
    });
    expect(resolved.fields.summary.defaultValue).toBe('app default');
  });

  it('uses the smrt-users tenant hierarchy via the default loader', async () => {
    const tenants = await TenantCollection.create({ db });
    const root = await tenants.create({ name: 'Root Tenant' });
    await root.save();
    const child = await tenants.createChild(root.id, {
      name: 'Child Tenant',
      inheritPermissions: true,
    });

    await policies.create({
      objectRef,
      fieldName: 'summary',
      scopeType: 'tenant',
      tenantId: String(root.id),
      defaultValue: JSON.stringify('root via users'),
    });

    const resolved = await resolveFieldPolicy(objectRef, {
      db,
      tenantId: String(child.id),
    });
    expect(resolved.fields.summary.defaultValue).toBe('root via users');
  });

  it('falls back to a flat tenant chain without a hierarchy provider', async () => {
    const tenantId = randomUUID();
    await policies.create({
      objectRef,
      fieldName: 'summary',
      scopeType: 'tenant',
      tenantId,
      defaultValue: JSON.stringify('flat default'),
    });

    const resolved = await resolveFieldPolicy(objectRef, {
      db,
      tenantId,
      tenantHierarchyLoader: flatLoader,
    });
    expect(resolved.fields.summary.defaultValue).toBe('flat default');
  });

  it('skips the user layer while the org tiers resolve locked', async () => {
    const userId = randomUUID();

    // User personalizes summary while it is unlocked.
    await policies.create({
      objectRef,
      fieldName: 'summary',
      scopeType: 'user',
      userId,
      defaultValue: JSON.stringify('user default'),
    });
    const beforeLock = await resolveFieldPolicy(objectRef, { db, userId });
    expect(beforeLock.fields.summary.defaultValue).toBe('user default');

    // The org later locks the field: the stale user row stops applying.
    await policies.create({
      objectRef,
      fieldName: 'summary',
      scopeType: 'app',
      defaultValue: JSON.stringify('org default'),
      locked: true,
    });
    const afterLock = await resolveFieldPolicy(objectRef, { db, userId });
    expect(afterLock.fields.summary.defaultValue).toBe('org default');
    expect(afterLock.fields.summary.locked).toBe(true);

    const explained = await resolveFieldPolicyExplained(objectRef, {
      db,
      userId,
    });
    expect(
      explained.layers.summary.some((layer) => layer.layer === 'user'),
    ).toBe(false);
  });

  it('forces required fields visible after a two-row deletion sequence', async () => {
    const tenantId = randomUUID();

    // The org seeds a usable default, then a tenant demotion relies on it.
    const appDefault = await policies.create({
      objectRef,
      fieldName: 'title',
      scopeType: 'app',
      defaultValue: JSON.stringify('Seeded title'),
    });
    await policies.create({
      objectRef,
      fieldName: 'title',
      scopeType: 'tenant',
      tenantId,
      visibility: 'hidden',
    });

    const withDefault = await resolveFieldPolicy(objectRef, {
      db,
      tenantId,
      tenantHierarchyLoader: flatLoader,
    });
    expect(withDefault.fields.title.visibility).toBe('hidden');
    expect(withDefault.fields.title.visibilityForced).toBeUndefined();

    // Deleting the DEFAULT row (not the demotion row) would strand a hidden
    // required field — the resolver safety net forces it visible.
    await appDefault.delete();

    const afterDeletion = await resolveFieldPolicy(objectRef, {
      db,
      tenantId,
      tenantHierarchyLoader: flatLoader,
    });
    expect(afterDeletion.fields.title.visibility).toBe('basic');
    expect(afterDeletion.fields.title.visibilityForced).toBe(true);
  });

  it('caches per (db, objectRef, tenant, user) and invalidates on save/delete', async () => {
    const tenantId = randomUUID();
    await policies.create({
      objectRef,
      fieldName: 'summary',
      scopeType: 'tenant',
      tenantId,
      defaultValue: JSON.stringify('cached value'),
    });

    const first = await resolveFieldPolicy(objectRef, {
      db,
      tenantId,
      tenantHierarchyLoader: flatLoader,
    });
    expect(first.fields.summary.defaultValue).toBe('cached value');

    // A raw UPDATE bypasses save() so no invalidation fires: the resolver
    // must keep serving the cached value.
    await db.query(
      `UPDATE _smrt_field_policies SET default_value = ? WHERE object_ref = ?`,
      [JSON.stringify('stale value'), objectRef],
    );
    const cached = await resolveFieldPolicy(objectRef, {
      db,
      tenantId,
      tenantHierarchyLoader: flatLoader,
    });
    expect(cached.fields.summary.defaultValue).toBe('cached value');

    clearFieldPolicyCache();
    const fresh = await resolveFieldPolicy(objectRef, {
      db,
      tenantId,
      tenantHierarchyLoader: flatLoader,
    });
    expect(fresh.fields.summary.defaultValue).toBe('stale value');

    // Model-layer writes invalidate: an upsert through the collection is
    // visible immediately.
    await policies.create({
      objectRef,
      fieldName: 'summary',
      scopeType: 'tenant',
      tenantId,
      defaultValue: JSON.stringify('written value'),
    });
    const afterWrite = await resolveFieldPolicy(objectRef, {
      db,
      tenantId,
      tenantHierarchyLoader: flatLoader,
    });
    expect(afterWrite.fields.summary.defaultValue).toBe('written value');
  });

  it('explains per-layer contributions alongside the merged result', async () => {
    const tenantId = randomUUID();
    const userId = randomUUID();

    await policies.create({
      objectRef,
      fieldName: 'summary',
      scopeType: 'app',
      defaultValue: JSON.stringify('app default'),
      help: 'app help',
    });
    await policies.create({
      objectRef,
      fieldName: 'summary',
      scopeType: 'tenant',
      tenantId,
      defaultValue: JSON.stringify('tenant default'),
    });
    await policies.create({
      objectRef,
      fieldName: 'summary',
      scopeType: 'user',
      userId,
      visibility: 'advanced',
    });

    const explained = await resolveFieldPolicyExplained(objectRef, {
      db,
      tenantId,
      userId,
      tenantHierarchyLoader: flatLoader,
    });

    const layers = explained.layers.summary;
    expect(layers.map((layer) => layer.layer)).toEqual([
      'code',
      'app',
      'tenant',
      'user',
    ]);
    expect(layers[0].delta.visibility).toBe('basic');
    expect(layers[1].delta.default).toEqual({ value: 'app default' });
    expect(layers[1].delta.help).toBe('app help');
    expect(layers[2].tenantId).toBe(tenantId);
    expect(layers[2].delta.default).toEqual({ value: 'tenant default' });
    expect(layers[3].userId).toBe(userId);
    expect(layers[3].delta.visibility).toBe('advanced');

    // The merged view reproduces the layered application.
    expect(explained.fields.summary.defaultValue).toBe('tenant default');
    expect(explained.fields.summary.visibility).toBe('advanced');
    expect(explained.fields.summary.help).toBe('app help');
  });

  it('resolves the code seed alone when no database is supplied', async () => {
    const resolved = await resolveFieldPolicy(objectRef, {});
    expect(resolved.fields.summary.visibility).toBe('basic');
    expect(resolved.fields.priority.defaultValue).toBe(3);
  });
});
