import { randomUUID } from 'node:crypto';
import {
  crossPackageRef,
  field,
  getTestDatabase,
  meta,
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
// Registers smrt-users' classes (Tenant) so getTestDatabase can create the
// tenants table the write-time org checks read through the default hierarchy
// loader.
import { TenantCollection } from '../../users/src/index.js';
import { clearFieldPolicyCache } from './cache.js';
import { FieldPolicyCollection } from './collections/FieldPolicyCollection.js';

@smrt({
  packageName: '@test/smrt-fields-model',
  visibility: 'internal',
  api: false,
  cli: false,
  mcp: false,
})
class PolicyModelDoc extends SmrtObject {
  @field({ required: true, description: 'Document title' })
  title: string = '';

  @field({ ui: { basic: true, group: 'main', order: 1 } })
  summary: string = '';

  @field({ type: 'integer' })
  wordCount: number = 0;

  @field({ type: 'boolean' })
  published: boolean = false;

  @field({ type: 'datetime', nullable: true })
  publishAt: Date | null = null;

  @field({ sensitive: true })
  apiSecret: string = '';

  @field({ readPermission: 'fields.finance.read' })
  budgetCode: string = '';

  @field({ transient: true })
  preview: string = '';

  @field({ ui: { locked: true } })
  lockedByCode: string = '';

  @field({ required: true })
  category: string = 'general';

  @meta()
  legacyNotes: string = '';

  @crossPackageRef('@happyvertical/smrt-users:User')
  reviewerId: string = '';

  @crossPackageRef('@happyvertical/smrt-users:User', { idType: 'text' })
  externalRef: string = '';
}

function fixtureRef(): string {
  const registered = ObjectRegistry.getClassByConstructor(PolicyModelDoc);
  if (!registered?.qualifiedName) {
    throw new Error('PolicyModelDoc is not registered with a qualified name');
  }
  return registered.qualifiedName;
}

/**
 * Seed tenant/user-scope rows the way real ops flows do: under a super-admin
 * bypass context. Without any ambient identity such rows are rejected
 * outright (the context-absent fail-closed rule), so bare-context seeding is
 * reserved for app-scope rows.
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

describe('FieldPolicy write-time validation', () => {
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

  it('rejects unknown objectRef and unqualified names', async () => {
    await expect(
      policies.create({
        objectRef: '@test/nowhere:Nope',
        fieldName: 'title',
        scopeType: 'app',
        help: 'x',
      }),
    ).rejects.toThrow(/Unknown field policy objectRef/);

    await expect(
      policies.create({
        objectRef: 'PolicyModelDoc',
        fieldName: 'title',
        scopeType: 'app',
        help: 'x',
      }),
    ).rejects.toThrow(/qualified class name/);
  });

  it('rejects unknown, system, and framework field names', async () => {
    await expect(
      policies.create({
        objectRef,
        fieldName: 'doesNotExist',
        scopeType: 'app',
        help: 'x',
      }),
    ).rejects.toThrow(/Unknown field "doesNotExist"/);

    await expect(
      policies.create({
        objectRef,
        fieldName: 'slug',
        scopeType: 'app',
        help: 'x',
      }),
    ).rejects.toThrow(/system field/);

    // STI meta storage fields are excluded by the resolver, so accepting a
    // row would persist policy that silently never applies.
    await expect(
      policies.create({
        objectRef,
        fieldName: 'legacyNotes',
        scopeType: 'app',
        help: 'x',
      }),
    ).rejects.toThrow(/STI meta storage/);
  });

  it('rejects invalid scopeType, visibility, and displayOrder values', async () => {
    await expect(
      policies.create({
        objectRef,
        fieldName: 'summary',
        scopeType: 'org' as any,
        help: 'x',
      }),
    ).rejects.toThrow(/scopeType must be one of/);

    await expect(
      policies.create({
        objectRef,
        fieldName: 'summary',
        scopeType: 'app',
        visibility: 'invisible' as any,
      }),
    ).rejects.toThrow(/visibility must be null or one of/);

    await expect(
      policies.create({
        objectRef,
        fieldName: 'summary',
        scopeType: 'app',
        displayOrder: 1.5,
      }),
    ).rejects.toThrow(/displayOrder must be null or an integer/);
  });

  it('enforces scope shape: app/tenant/user each carry exactly their own id', async () => {
    await expect(
      policies.create({
        objectRef,
        fieldName: 'summary',
        scopeType: 'app',
        tenantId: randomUUID(),
        help: 'x',
      }),
    ).rejects.toThrow(/App-scope field policy rows/);

    await expect(
      policies.create({
        objectRef,
        fieldName: 'summary',
        scopeType: 'tenant',
        help: 'x',
      }),
    ).rejects.toThrow(/Tenant-scope field policy rows/);

    await expect(
      policies.create({
        objectRef,
        fieldName: 'summary',
        scopeType: 'tenant',
        tenantId: randomUUID(),
        userId: randomUUID(),
        help: 'x',
      }),
    ).rejects.toThrow(/Tenant-scope field policy rows/);

    await expect(
      policies.create({
        objectRef,
        fieldName: 'summary',
        scopeType: 'user',
        tenantId: randomUUID(),
        userId: randomUUID(),
        help: 'x',
      }),
    ).rejects.toThrow(/User-scope field policy rows/);

    await expect(
      policies.create({
        objectRef,
        fieldName: 'summary',
        scopeType: 'user',
        help: 'x',
      }),
    ).rejects.toThrow(/User-scope field policy rows/);
  });

  it('type-checks defaults against the manifest field type', async () => {
    await expect(
      policies.create({
        objectRef,
        fieldName: 'wordCount',
        scopeType: 'app',
        defaultValue: JSON.stringify('not a number'),
      }),
    ).rejects.toThrow(/must be an integer/);

    await expect(
      policies.create({
        objectRef,
        fieldName: 'wordCount',
        scopeType: 'app',
        defaultValue: JSON.stringify(1.5),
      }),
    ).rejects.toThrow(/must be an integer/);

    await expect(
      policies.create({
        objectRef,
        fieldName: 'published',
        scopeType: 'app',
        defaultValue: JSON.stringify('true'),
      }),
    ).rejects.toThrow(/must be a boolean/);

    await expect(
      policies.create({
        objectRef,
        fieldName: 'summary',
        scopeType: 'app',
        defaultValue: JSON.stringify(42),
      }),
    ).rejects.toThrow(/must be a string/);

    await expect(
      policies.create({
        objectRef,
        fieldName: 'publishAt',
        scopeType: 'app',
        defaultValue: JSON.stringify('not-a-date'),
      }),
    ).rejects.toThrow(/date-parseable/);

    // Matching types persist.
    const ok = await policies.create({
      objectRef,
      fieldName: 'wordCount',
      scopeType: 'app',
      defaultValue: JSON.stringify(250),
    });
    expect(ok.getDefaultValue()).toBe(250);
  });

  it('rejects invalid JSON defaults and null defaults on required fields', async () => {
    await expect(
      policies.create({
        objectRef,
        fieldName: 'summary',
        scopeType: 'app',
        defaultValue: '{not json',
      }),
    ).rejects.toThrow(/not valid JSON/);

    await expect(
      policies.create({
        objectRef,
        fieldName: 'title',
        scopeType: 'app',
        defaultValue: JSON.stringify(null),
      }),
    ).rejects.toThrow(/may not be null/);

    // Null default on an optional field is a legitimate "default to null".
    const ok = await policies.create({
      objectRef,
      fieldName: 'publishAt',
      scopeType: 'app',
      defaultValue: JSON.stringify(null),
    });
    expect(ok.defaultValue).toBe('null');
  });

  it('refuses defaults on transient, sensitive, and read-permission-gated fields', async () => {
    await expect(
      policies.create({
        objectRef,
        fieldName: 'preview',
        scopeType: 'app',
        defaultValue: JSON.stringify('x'),
      }),
    ).rejects.toThrow(/transient field/);

    await expect(
      policies.create({
        objectRef,
        fieldName: 'apiSecret',
        scopeType: 'app',
        defaultValue: JSON.stringify('x'),
      }),
    ).rejects.toThrow(/sensitive field/);

    await expect(
      policies.create({
        objectRef,
        fieldName: 'budgetCode',
        scopeType: 'app',
        defaultValue: JSON.stringify('x'),
      }),
    ).rejects.toThrow(/read-permission-gated field/);

    // Presentation-only policy (no default) is still allowed on gated fields.
    const ok = await policies.create({
      objectRef,
      fieldName: 'apiSecret',
      scopeType: 'app',
      label: 'API secret',
    });
    expect(ok.label).toBe('API secret');
  });

  it('enforces the required-field invariant on visibility demotion', async () => {
    // title is required and its code default ('') is not usable.
    await expect(
      policies.create({
        objectRef,
        fieldName: 'title',
        scopeType: 'app',
        visibility: 'hidden',
      }),
    ).rejects.toThrow(/no resolved default/);

    await expect(
      policies.create({
        objectRef,
        fieldName: 'title',
        scopeType: 'app',
        visibility: 'advanced',
      }),
    ).rejects.toThrow(/no resolved default/);

    // Same row supplies a usable default: allowed.
    const withOwnDefault = await policies.create({
      objectRef,
      fieldName: 'title',
      scopeType: 'app',
      visibility: 'hidden',
      defaultValue: JSON.stringify('Untitled'),
    });
    expect(withOwnDefault.visibility).toBe('hidden');

    // category is required WITH a usable code default: demotion allowed.
    const viaCodeDefault = await policies.create({
      objectRef,
      fieldName: 'category',
      scopeType: 'app',
      visibility: 'advanced',
    });
    expect(viaCodeDefault.visibility).toBe('advanced');

    // A tenant demotion may rely on the app row's stored default.
    const tenantRow = await seedPolicies(() =>
      policies.create({
        objectRef,
        fieldName: 'title',
        scopeType: 'tenant',
        tenantId: randomUUID(),
        visibility: 'hidden',
      }),
    );
    expect(tenantRow.visibility).toBe('hidden');

    // Optional fields demote freely.
    const optional = await policies.create({
      objectRef,
      fieldName: 'summary',
      scopeType: 'app',
      visibility: 'hidden',
    });
    expect(optional.visibility).toBe('hidden');
  });

  it('restricts locked to org rows and enforces the lock against user writes', async () => {
    await seedPolicies(async () => {
      await expect(
        policies.create({
          objectRef,
          fieldName: 'summary',
          scopeType: 'user',
          userId: randomUUID(),
          locked: true,
        }),
      ).rejects.toThrow(/locked may only be set on org rows/);

      // Code-seeded lock (ui.locked) blocks user-scope writes outright.
      await expect(
        policies.create({
          objectRef,
          fieldName: 'lockedByCode',
          scopeType: 'user',
          userId: randomUUID(),
          help: 'mine',
        }),
      ).rejects.toThrow(/locked by org policy/);
    });

    // App-row lock blocks user writes on an otherwise-open field.
    await policies.create({
      objectRef,
      fieldName: 'summary',
      scopeType: 'app',
      locked: true,
    });
    await seedPolicies(async () => {
      await expect(
        policies.create({
          objectRef,
          fieldName: 'summary',
          scopeType: 'user',
          userId: randomUUID(),
          help: 'mine',
        }),
      ).rejects.toThrow(/locked by org policy/);
    });

    // An explicit org unlock on a code-locked field re-opens the user tier.
    await policies.create({
      objectRef,
      fieldName: 'lockedByCode',
      scopeType: 'app',
      locked: false,
    });
    const userRow = await seedPolicies(() =>
      policies.create({
        objectRef,
        fieldName: 'lockedByCode',
        scopeType: 'user',
        userId: randomUUID(),
        help: 'mine',
      }),
    );
    expect(userRow.help).toBe('mine');
  });

  it('upserts on the natural key so one row exists per (object, field, scope)', async () => {
    await policies.create({
      objectRef,
      fieldName: 'summary',
      scopeType: 'app',
      help: 'first',
    });
    await policies.create({
      objectRef,
      fieldName: 'summary',
      scopeType: 'app',
      help: 'second',
    });

    const rows = await policies.list({
      where: { objectRef, fieldName: 'summary', scopeType: 'app' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].help).toBe('second');
    expect(rows[0].scopeKey).toBe('__app__');

    // Distinct scopes coexist for the same field.
    const tenantId = randomUUID();
    await seedPolicies(() =>
      policies.create({
        objectRef,
        fieldName: 'summary',
        scopeType: 'tenant',
        tenantId,
        help: 'tenant help',
      }),
    );
    const allRows = await policies.list({
      where: { objectRef, fieldName: 'summary' },
    });
    expect(allRows).toHaveLength(2);
  });

  it('handles identity changes with delete-then-insert semantics', async () => {
    const row = await policies.create({
      objectRef,
      fieldName: 'summary',
      scopeType: 'app',
      help: 'moving',
    });

    row.fieldName = 'category';
    await row.save();

    const summaryRows = await policies.list({
      where: { objectRef, fieldName: 'summary', scopeType: 'app' },
    });
    const categoryRows = await policies.list({
      where: { objectRef, fieldName: 'category', scopeType: 'app' },
    });
    expect(summaryRows).toHaveLength(0);
    expect(categoryRows).toHaveLength(1);
    expect(categoryRows[0].help).toBe('moving');
  });

  it('fails closed on writes that cross the ambient tenant context', async () => {
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
          policies.create({
            objectRef,
            fieldName: 'summary',
            scopeType: 'tenant',
            tenantId: otherTenant,
            help: 'x',
          }),
        ).rejects.toThrow(TenantIsolationError);

        await expect(
          policies.create({
            objectRef,
            fieldName: 'summary',
            scopeType: 'app',
            help: 'x',
          }),
        ).rejects.toThrow(TenantIsolationError);

        await expect(
          policies.create({
            objectRef,
            fieldName: 'summary',
            scopeType: 'user',
            userId: otherUser,
            help: 'x',
          }),
        ).rejects.toThrow(TenantIsolationError);

        // Own tenant and own user rows are allowed.
        const own = await policies.create({
          objectRef,
          fieldName: 'summary',
          scopeType: 'tenant',
          tenantId: contextTenant,
          help: 'own tenant',
        });
        expect(own.help).toBe('own tenant');

        const ownUser = await policies.create({
          objectRef,
          fieldName: 'summary',
          scopeType: 'user',
          userId: contextUser,
          help: 'own user',
        });
        expect(ownUser.help).toBe('own user');
      },
    );

    // Super-admin bypass keeps deliberate cross-tenant capability.
    await withTenant(
      {
        tenantId: contextTenant,
        permissions: new Set<string>(),
        superAdminBypass: true,
      },
      async () => {
        const crossTenant = await policies.create({
          objectRef,
          fieldName: 'category',
          scopeType: 'tenant',
          tenantId: otherTenant,
          help: 'bypass',
        });
        expect(crossTenant.help).toBe('bypass');
      },
    );
  });

  it('fails closed on deletes of rows the ambient context does not own', async () => {
    const contextTenant = randomUUID();
    const foreignTenant = randomUUID();
    const contextUser = randomUUID();
    const foreignUser = randomUUID();

    // App row seeded bare (allowed without ambient identity); tenant/user
    // rows seeded under bypass like real ops flows.
    const appRow = await policies.create({
      objectRef,
      fieldName: 'summary',
      scopeType: 'app',
      help: 'app row',
    });
    const { foreignTenantRow, foreignUserRow, ownTenantRow } =
      await seedPolicies(async () => ({
        foreignTenantRow: await policies.create({
          objectRef,
          fieldName: 'summary',
          scopeType: 'tenant',
          tenantId: foreignTenant,
          help: 'foreign tenant row',
        }),
        foreignUserRow: await policies.create({
          objectRef,
          fieldName: 'summary',
          scopeType: 'user',
          userId: foreignUser,
          help: 'foreign user row',
        }),
        ownTenantRow: await policies.create({
          objectRef,
          fieldName: 'category',
          scopeType: 'tenant',
          tenantId: contextTenant,
          help: 'own tenant row',
        }),
      }));

    await withTenant(
      {
        tenantId: contextTenant,
        userId: contextUser,
        permissions: new Set<string>(),
      },
      async () => {
        // A caller holding a foreign row id (e.g. via the generated DELETE
        // route) must not remove rows outside its own scope.
        await expect(appRow.delete()).rejects.toThrow(TenantIsolationError);
        await expect(foreignTenantRow.delete()).rejects.toThrow(
          TenantIsolationError,
        );
        await expect(foreignUserRow.delete()).rejects.toThrow(
          TenantIsolationError,
        );

        // Own-tenant rows remain deletable.
        await ownTenantRow.delete();
      },
    );

    const remaining = await policies.list({ where: { objectRef } });
    expect(remaining.map((row) => row.help).sort()).toEqual([
      'app row',
      'foreign tenant row',
      'foreign user row',
    ]);

    // Super-admin bypass keeps deliberate cross-scope deletes.
    await withTenant(
      {
        tenantId: contextTenant,
        permissions: new Set<string>(),
        superAdminBypass: true,
      },
      async () => {
        await foreignTenantRow.delete();
      },
    );
    const afterBypass = await policies.list({ where: { objectRef } });
    expect(afterBypass).toHaveLength(2);
  });

  it('rejects re-scoping a foreign persisted row into the caller scope', async () => {
    const contextTenant = randomUUID();
    const foreignTenant = randomUUID();
    const contextUser = randomUUID();
    const foreignUser = randomUUID();

    const { foreignTenantRow, foreignUserRow } = await seedPolicies(
      async () => ({
        foreignTenantRow: await policies.create({
          objectRef,
          fieldName: 'summary',
          scopeType: 'tenant',
          tenantId: foreignTenant,
          help: 'foreign tenant policy',
        }),
        foreignUserRow: await policies.create({
          objectRef,
          fieldName: 'category',
          scopeType: 'user',
          userId: foreignUser,
          help: 'foreign user policy',
        }),
      }),
    );

    await withTenant(
      {
        tenantId: contextTenant,
        userId: contextUser,
        permissions: new Set<string>(),
      },
      async () => {
        // Authorization runs against the PERSISTED scope, so flipping the
        // ownership columns to the caller's own ids must not be accepted
        // (the identity-change path would otherwise delete the foreign row).
        foreignTenantRow.tenantId = contextTenant;
        await expect(foreignTenantRow.save()).rejects.toThrow(
          TenantIsolationError,
        );

        foreignUserRow.userId = contextUser;
        await expect(foreignUserRow.save()).rejects.toThrow(
          TenantIsolationError,
        );

        // Even without changing scope, mutating a foreign row is rejected.
        const [persistedForeign] = await policies.list({
          where: { objectRef, fieldName: 'summary', scopeType: 'tenant' },
        });
        persistedForeign.help = 'hijacked';
        await expect(persistedForeign.save()).rejects.toThrow(
          TenantIsolationError,
        );
      },
    );

    // The foreign rows survive unchanged under their original scope.
    const rows = await policies.list({ where: { objectRef } });
    expect(rows.map((row) => row.help).sort()).toEqual([
      'foreign tenant policy',
      'foreign user policy',
    ]);
    expect(rows.find((row) => row.scopeType === 'tenant')?.tenantId).toBe(
      foreignTenant,
    );
    expect(rows.find((row) => row.scopeType === 'user')?.userId).toBe(
      foreignUser,
    );
  });

  it('enforces a cascading ancestor-tenant lock against user writes', async () => {
    const tenants = await TenantCollection.create({ db });
    const root = await tenants.create({ name: 'Lock Root' });
    await root.save();
    const child = await tenants.createChild(root.id, {
      name: 'Lock Child',
      inheritPermissions: true,
    });

    // The parent tenant locks the field; no direct child row exists.
    await seedPolicies(() =>
      policies.create({
        objectRef,
        fieldName: 'summary',
        scopeType: 'tenant',
        tenantId: String(root.id),
        locked: true,
      }),
    );

    const userId = randomUUID();
    await withTenant(
      {
        tenantId: String(child.id),
        userId,
        permissions: new Set<string>(),
      },
      async () => {
        await expect(
          policies.create({
            objectRef,
            fieldName: 'summary',
            scopeType: 'user',
            userId,
            help: 'mine',
          }),
        ).rejects.toThrow(/locked by org policy/);
      },
    );
  });

  it('accepts demotions whose only usable default cascades from an ancestor tenant', async () => {
    const tenants = await TenantCollection.create({ db });
    const root = await tenants.create({ name: 'Default Root' });
    await root.save();
    const child = await tenants.createChild(root.id, {
      name: 'Default Child',
      inheritPermissions: true,
    });

    // The only usable default for required `title` lives on the ROOT tenant.
    await seedPolicies(() =>
      policies.create({
        objectRef,
        fieldName: 'title',
        scopeType: 'tenant',
        tenantId: String(root.id),
        defaultValue: JSON.stringify('Root seeded title'),
      }),
    );

    // A child-tenant demotion resolves that ancestor default through the
    // hierarchy walk and is accepted.
    const childDemotion = await withTenant(
      { tenantId: String(child.id), permissions: new Set<string>() },
      () =>
        policies.create({
          objectRef,
          fieldName: 'title',
          scopeType: 'tenant',
          tenantId: String(child.id),
          visibility: 'hidden',
        }),
    );
    expect(childDemotion.visibility).toBe('hidden');

    // A user demotion under the child tenant's context resolves it too.
    const userId = randomUUID();
    await withTenant(
      {
        tenantId: String(child.id),
        userId,
        permissions: new Set<string>(),
      },
      async () => {
        const userDemotion = await policies.create({
          objectRef,
          fieldName: 'title',
          scopeType: 'user',
          userId,
          visibility: 'advanced',
        });
        expect(userDemotion.visibility).toBe('advanced');
      },
    );

    // An unrelated tenant with no ancestor default is still rejected.
    await seedPolicies(async () => {
      await expect(
        policies.create({
          objectRef,
          fieldName: 'title',
          scopeType: 'tenant',
          tenantId: randomUUID(),
          visibility: 'hidden',
        }),
      ).rejects.toThrow(/no resolved default/);
    });
  });

  it('fails closed without any ambient identity: app-scope writes only', async () => {
    // No tenant context is active: tenant- and user-scope rows are
    // unattributable and rejected outright (a runtime API deployment whose
    // middleware never enters the tenancy ALS must not accept them).
    await expect(
      policies.create({
        objectRef,
        fieldName: 'summary',
        scopeType: 'tenant',
        tenantId: randomUUID(),
        help: 'x',
      }),
    ).rejects.toThrow(TenantIsolationError);

    await expect(
      policies.create({
        objectRef,
        fieldName: 'summary',
        scopeType: 'user',
        userId: randomUUID(),
        help: 'x',
      }),
    ).rejects.toThrow(TenantIsolationError);

    // App-scope rows remain the legitimate server-side/ops path.
    const appRow = await policies.create({
      objectRef,
      fieldName: 'summary',
      scopeType: 'app',
      help: 'app ok',
    });
    expect(appRow.help).toBe('app ok');

    // Deletes obey the same rule: a seeded tenant row cannot be deleted
    // without an ambient identity, while app rows can.
    const seededTenantRow = await seedPolicies(() =>
      policies.create({
        objectRef,
        fieldName: 'category',
        scopeType: 'tenant',
        tenantId: randomUUID(),
        help: 'seeded',
      }),
    );
    await expect(seededTenantRow.delete()).rejects.toThrow(
      TenantIsolationError,
    );
    await appRow.delete();
  });

  it('validates reference-field defaults as UUIDs unless the field stores text ids', async () => {
    await expect(
      policies.create({
        objectRef,
        fieldName: 'reviewerId',
        scopeType: 'app',
        defaultValue: JSON.stringify('not-a-uuid'),
      }),
    ).rejects.toThrow(/must be a UUID string/);

    const uuidDefault = randomUUID();
    const uuidRow = await policies.create({
      objectRef,
      fieldName: 'reviewerId',
      scopeType: 'app',
      defaultValue: JSON.stringify(uuidDefault),
    });
    expect(uuidRow.getDefaultValue()).toBe(uuidDefault);

    // idType 'text' references accept arbitrary string ids.
    const textRow = await policies.create({
      objectRef,
      fieldName: 'externalRef',
      scopeType: 'app',
      defaultValue: JSON.stringify('legacy-id-42'),
    });
    expect(textRow.getDefaultValue()).toBe('legacy-id-42');
  });
});
