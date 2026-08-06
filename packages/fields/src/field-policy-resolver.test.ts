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
  isMissingUsersDependency,
  resolveFieldPolicy,
  resolveFieldPolicyExplained,
} from './field-policy-resolver.js';
import type {
  ExplainedObjectFieldPolicy,
  FieldPolicyTenantHierarchyLoader,
  FieldPolicyVisibility,
} from './types.js';

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

/**
 * Seed tenant/user-scope rows under a super-admin bypass context (the
 * context-absent fail-closed rule rejects them without any ambient identity).
 */
function seedPolicies<T>(fn: () => Promise<T>): Promise<T> {
  return withTenant(
    {
      tenantId: randomUUID(),
      permissions: new Set<string>(),
      superAdminBypass: true,
    },
    fn,
  );
}

/**
 * Sequentially replay the explained layer deltas (plus the required-field
 * safety net) and assert the result reproduces the merged policy for every
 * field — the contract that lets #2049/#2050 UIs trust the layer lists.
 */
function expectLayersToReproduceMerged(
  explained: ExplainedObjectFieldPolicy,
): void {
  for (const [fieldName, merged] of Object.entries(explained.fields)) {
    const contributions = explained.layers[fieldName] ?? [];
    let defaultBox: { value: unknown } | undefined;
    let visibility: FieldPolicyVisibility = 'basic';
    let help: string | undefined;
    let label: string | undefined;
    let order: number | undefined;
    let locked: boolean | undefined;

    for (const { delta } of contributions) {
      defaultBox = delta.default ?? defaultBox;
      visibility = delta.visibility ?? visibility;
      help = delta.help ?? help;
      label = delta.label ?? label;
      order = delta.order ?? order;
      locked = delta.locked ?? locked;
    }

    const usableDefault =
      defaultBox !== undefined &&
      defaultBox.value !== null &&
      defaultBox.value !== '';
    if (merged.required && !usableDefault && visibility !== 'basic') {
      visibility = 'basic';
    }

    expect({
      fieldName,
      hasDefault: defaultBox !== undefined,
      defaultValue: defaultBox?.value,
      visibility,
      help: help ?? null,
      label: label ?? null,
      order: order ?? null,
      locked: locked === true,
    }).toEqual({
      fieldName,
      hasDefault: merged.hasDefault,
      defaultValue: merged.defaultValue,
      visibility: merged.visibility,
      help: merged.help,
      label: merged.label,
      order: merged.order,
      locked: merged.locked,
    });
  }
}

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
    await seedPolicies(async () => {
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
    const tenantRow = await seedPolicies(() =>
      policies.create({
        objectRef,
        fieldName: 'summary',
        scopeType: 'tenant',
        tenantId,
        defaultValue: JSON.stringify('tenant default'),
      }),
    );

    const before = await resolveFieldPolicy(objectRef, {
      db,
      tenantId,
      tenantHierarchyLoader: flatLoader,
    });
    expect(before.fields.summary.defaultValue).toBe('tenant default');

    // Reset = row delete (inside the row's own tenant context; the
    // context-absent rule rejects bare tenant-row deletes). The delete also
    // invalidates the cache.
    await withTenant({ tenantId, permissions: new Set<string>() }, async () => {
      await tenantRow.delete();
    });

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

    await seedPolicies(() =>
      policies.create({
        objectRef,
        fieldName: 'summary',
        scopeType: 'tenant',
        tenantId: tenantA,
        defaultValue: JSON.stringify('tenant A'),
      }),
    );

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

  it('denies user-targeted resolution from a context carrying no user id', async () => {
    // Read-side mirror of the write-side rule (#2047): a MISSING identity
    // component denies, it never skips. Tenancy adapters populate
    // `permissions` while leaving `userId` undefined whenever no
    // `resolveUserId` hook is configured (API-key auth, service principals,
    // background jobs) — such a context must not be able to read ANY user's
    // resolved policy through the public `resolveFieldPolicy` export.
    const contextTenant = randomUUID();
    const foreignUser = randomUUID();

    await withTenant(
      { tenantId: contextTenant, permissions: new Set<string>() },
      async () => {
        await expect(
          resolveFieldPolicy(objectRef, {
            db,
            tenantId: contextTenant,
            userId: foreignUser,
            tenantHierarchyLoader: flatLoader,
          }),
        ).rejects.toThrow(TenantIsolationError);

        // App/tenant-only resolution is unaffected — no user is targeted.
        const orgOnly = await resolveFieldPolicy(objectRef, {
          db,
          tenantId: contextTenant,
          tenantHierarchyLoader: flatLoader,
        });
        expect(orgOnly.objectRef).toBe(objectRef);
      },
    );

    // Context-LESS server-side callers stay allowed: `resolveFieldPolicy` is
    // a trusted server API and the public batch route never lets a request
    // body select a user.
    const serverSide = await resolveFieldPolicy(objectRef, {
      db,
      tenantId: contextTenant,
      userId: foreignUser,
      tenantHierarchyLoader: flatLoader,
    });
    expect(serverSide.objectRef).toBe(objectRef);

    // Super-admin bypass keeps its deliberate cross-user capability.
    await withTenant(
      {
        tenantId: contextTenant,
        permissions: new Set<string>(),
        superAdminBypass: true,
      },
      async () => {
        const bypassed = await resolveFieldPolicy(objectRef, {
          db,
          tenantId: contextTenant,
          userId: foreignUser,
          tenantHierarchyLoader: flatLoader,
        });
        expect(bypassed.objectRef).toBe(objectRef);
      },
    );
  });

  it('keys the cache by tenant-hierarchy loader identity', async () => {
    // An injected loader produces a different ancestor chain — and therefore
    // different resolved defaults/locks — for the same
    // (db, objectRef, tenantId, userId). Without the loader in the cache key
    // it would be served the DEFAULT loader's result (or poison it).
    const rootTenant = randomUUID();
    const leafTenant = randomUUID();

    await withTenant(
      {
        tenantId: rootTenant,
        permissions: new Set<string>(),
        superAdminBypass: true,
      },
      () =>
        policies.create({
          objectRef,
          fieldName: 'summary',
          scopeType: 'tenant',
          tenantId: rootTenant,
          help: 'from the root tenant',
        }),
    );

    // Flat loader: the leaf tenant has no ancestors, so the root row misses.
    const flat = await resolveFieldPolicy(objectRef, {
      db,
      tenantId: leafTenant,
      tenantHierarchyLoader: flatLoader,
    });
    expect(flat.fields.summary.help).toBeNull();

    // Hierarchy loader: the same (db, objectRef, tenant) now inherits it.
    const hierarchyLoader: FieldPolicyTenantHierarchyLoader = async () => ({
      async getChain() {
        return [
          {
            id: rootTenant,
            inheritPermissions: true,
            cascadePermissions: true,
          },
          {
            id: leafTenant,
            inheritPermissions: true,
            cascadePermissions: true,
          },
        ];
      },
    });
    const nested = await resolveFieldPolicy(objectRef, {
      db,
      tenantId: leafTenant,
      tenantHierarchyLoader: hierarchyLoader,
    });
    expect(nested.fields.summary.help).toBe('from the root tenant');

    // Each loader keeps its own entry rather than overwriting the other's.
    const flatAgain = await resolveFieldPolicy(objectRef, {
      db,
      tenantId: leafTenant,
      tenantHierarchyLoader: flatLoader,
    });
    expect(flatAgain.fields.summary.help).toBeNull();
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

    await seedPolicies(() =>
      policies.create({
        objectRef,
        fieldName: 'summary',
        scopeType: 'tenant',
        tenantId: rootTenant,
        defaultValue: JSON.stringify('root default'),
        help: 'root help',
      }),
    );

    // The ancestor's policy cascades to the child.
    const inherited = await resolveFieldPolicy(objectRef, {
      db,
      tenantId: childTenant,
      tenantHierarchyLoader: loader,
    });
    expect(inherited.fields.summary.defaultValue).toBe('root default');

    // A child row overrides the ancestor sparsely.
    await seedPolicies(() =>
      policies.create({
        objectRef,
        fieldName: 'summary',
        scopeType: 'tenant',
        tenantId: childTenant,
        defaultValue: JSON.stringify('child default'),
      }),
    );
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
    await seedPolicies(async () => {
      await policies.create({
        objectRef,
        fieldName: 'summary',
        scopeType: 'tenant',
        tenantId: rootTenant,
        defaultValue: JSON.stringify('root default'),
        help: 'root help',
      });
      // The child's own sparse row survives the break and applies over the
      // app layer (NOT over the discarded root layer).
      await policies.create({
        objectRef,
        fieldName: 'summary',
        scopeType: 'tenant',
        tenantId: detachedChild,
        help: 'child help',
      });
    });

    const explained = await resolveFieldPolicyExplained(objectRef, {
      db,
      tenantId: detachedChild,
      tenantHierarchyLoader: loader,
    });
    expect(explained.fields.summary.defaultValue).toBe('app default');
    expect(explained.fields.summary.help).toBe('child help');

    // The discarded ancestor never appears in the explained layers, so the
    // listed contributions reproduce the merged result on replay.
    const summaryLayers = explained.layers.summary;
    expect(
      summaryLayers.some(
        (layer) => layer.layer === 'tenant' && layer.tenantId === rootTenant,
      ),
    ).toBe(false);
    expect(
      summaryLayers.some(
        (layer) => layer.layer === 'tenant' && layer.tenantId === detachedChild,
      ),
    ).toBe(true);
    expectLayersToReproduceMerged(explained);
  });

  it('uses the smrt-users tenant hierarchy via the default loader', async () => {
    const tenants = await TenantCollection.create({ db });
    const root = await tenants.create({ name: 'Root Tenant' });
    await root.save();
    const child = await tenants.createChild(root.id, {
      name: 'Child Tenant',
      inheritPermissions: true,
    });

    await seedPolicies(() =>
      policies.create({
        objectRef,
        fieldName: 'summary',
        scopeType: 'tenant',
        tenantId: String(root.id),
        defaultValue: JSON.stringify('root via users'),
      }),
    );

    const resolved = await resolveFieldPolicy(objectRef, {
      db,
      tenantId: String(child.id),
    });
    expect(resolved.fields.summary.defaultValue).toBe('root via users');
  });

  it('falls back to a flat tenant chain without a hierarchy provider', async () => {
    const tenantId = randomUUID();
    await seedPolicies(() =>
      policies.create({
        objectRef,
        fieldName: 'summary',
        scopeType: 'tenant',
        tenantId,
        defaultValue: JSON.stringify('flat default'),
      }),
    );

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
    await seedPolicies(() =>
      policies.create({
        objectRef,
        fieldName: 'summary',
        scopeType: 'user',
        userId,
        defaultValue: JSON.stringify('user default'),
      }),
    );
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
    await seedPolicies(() =>
      policies.create({
        objectRef,
        fieldName: 'title',
        scopeType: 'tenant',
        tenantId,
        visibility: 'hidden',
      }),
    );

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
    await seedPolicies(() =>
      policies.create({
        objectRef,
        fieldName: 'summary',
        scopeType: 'tenant',
        tenantId,
        defaultValue: JSON.stringify('cached value'),
      }),
    );

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
    await seedPolicies(() =>
      policies.create({
        objectRef,
        fieldName: 'summary',
        scopeType: 'tenant',
        tenantId,
        defaultValue: JSON.stringify('written value'),
      }),
    );
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
    await seedPolicies(async () => {
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

    // The merged view reproduces the layered application — for summary and
    // for every other field's listed contributions.
    expect(explained.fields.summary.defaultValue).toBe('tenant default');
    expect(explained.fields.summary.visibility).toBe('advanced');
    expect(explained.fields.summary.help).toBe('app help');
    expectLayersToReproduceMerged(explained);
  });

  it('resolves the code seed alone when no database is supplied', async () => {
    const resolved = await resolveFieldPolicy(objectRef, {});
    expect(resolved.fields.summary.visibility).toBe('basic');
    expect(resolved.fields.priority.defaultValue).toBe(3);
  });
});

describe('isMissingUsersDependency', () => {
  it("treats Node's ERR_MODULE_NOT_FOUND missing-package shape as absent", () => {
    // The exact shape Node raises for a missing bare specifier.
    const direct = new Error(
      "Cannot find package '@happyvertical/smrt-users' imported from " +
        '/app/node_modules/@happyvertical/smrt-fields/dist/index.js',
    );
    (direct as { code?: string }).code = 'ERR_MODULE_NOT_FOUND';
    expect(isMissingUsersDependency(direct)).toBe(true);

    // The same failure surfaced through a wrapper's cause chain.
    const wrapped = new Error(
      'Failed to load @happyvertical/smrt-users for tenant-aware field ' +
        'policy resolution',
      { cause: direct },
    );
    expect(isMissingUsersDependency(wrapped)).toBe(true);

    // A missing users SUBPATH specifier counts as missing users too.
    expect(
      isMissingUsersDependency(
        new Error(
          "Cannot find module '@happyvertical/smrt-users/collections' " +
            'imported from /app/server.js',
        ),
      ),
    ).toBe(true);

    // importWorkspaceModule's own source-fallback message.
    expect(
      isMissingUsersDependency(
        new Error(
          'Failed to load @happyvertical/smrt-users for tenant-aware field ' +
            'policy resolution: could not find /workspace/packages/users/src',
        ),
      ),
    ).toBe(true);
  });

  it('rethrows installed-but-broken failures instead of falling back', () => {
    // A transitive missing dependency INSIDE an installed smrt-users names
    // the OTHER package as the target — the users path appears only as the
    // importer. That is a broken install and must surface, not silently
    // degrade to the flat-tenant fallback.
    const transitive = new Error(
      "Cannot find package 'left-pad' imported from " +
        '/app/node_modules/@happyvertical/smrt-users/dist/index.js',
    );
    (transitive as { code?: string }).code = 'ERR_MODULE_NOT_FOUND';
    expect(isMissingUsersDependency(transitive)).toBe(false);

    // Same shape arriving through a wrapper's cause chain.
    expect(
      isMissingUsersDependency(
        new Error('import failed', { cause: transitive }),
      ),
    ).toBe(false);

    // A users install whose dist is missing resolves to a FILE PATH target,
    // not the bare specifier — broken install, rethrow.
    const brokenDist = new Error(
      'Cannot find module ' +
        "'/app/node_modules/@happyvertical/smrt-users/dist/index.js'",
    );
    (brokenDist as { code?: string }).code = 'ERR_MODULE_NOT_FOUND';
    expect(isMissingUsersDependency(brokenDist)).toBe(false);

    // ERR_MODULE_NOT_FOUND without a parseable quoted target is ambiguous —
    // fail toward surfacing the error.
    const unparseable = new Error(
      'some loader failure for @happyvertical/smrt-users',
    );
    (unparseable as { code?: string }).code = 'ERR_MODULE_NOT_FOUND';
    expect(isMissingUsersDependency(unparseable)).toBe(false);

    // An unrelated runtime error mentioning the package is not a missing
    // module either.
    expect(
      isMissingUsersDependency(
        new Error('@happyvertical/smrt-users threw during initialization'),
      ),
    ).toBe(false);

    expect(isMissingUsersDependency('not an error')).toBe(false);
  });
});
