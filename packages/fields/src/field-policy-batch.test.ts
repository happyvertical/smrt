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
  withSystemContext,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// Registers smrt-users' classes (Tenant/Membership) so
// getTestDatabase can create the tenants table the default hierarchy loader
// reads under an ambient tenant context.
import { MembershipCollection } from '../../users/src/index.js';
import { clearFieldPolicyCache } from './cache.js';
import { FieldPolicyCollection } from './collections/FieldPolicyCollection.js';
import {
  MANAGE_FIELD_POLICY_PERMISSION,
  PERSONALIZE_FIELD_POLICY_PERMISSION,
} from './permissions.js';
import { buildFieldPolicySettingsCatalog } from './settings-catalog.js';

@smrt({
  packageName: '@test/smrt-fields-batch',
  visibility: 'internal',
  api: false,
  cli: false,
  mcp: false,
})
class PolicyBatchDoc extends SmrtObject {
  @field({ required: true })
  docName: string = '';

  @field({ ui: { basic: true } })
  blurb: string = '';

  @field({ sensitive: true })
  secretKey: string = '';

  // readPermission fixture: no production model uses the option yet, so the
  // batch gating contract is pinned here.
  @field({ readPermission: 'fields.batch.read' })
  gatedNotes: string = '';

  @field({ transient: true })
  derived: string = '';
}

function fixtureRef(): string {
  const registered = ObjectRegistry.getClassByConstructor(PolicyBatchDoc);
  if (!registered?.qualifiedName) {
    throw new Error('PolicyBatchDoc is not registered with a qualified name');
  }
  return registered.qualifiedName;
}

describe('FieldPolicyCollection.resolveBatch', () => {
  let db: DatabaseInterface;
  let policies: FieldPolicyCollection;
  let objectRef: string;

  beforeEach(async () => {
    setupTestTenancy();
    clearFieldPolicyCache();
    // 'Tenant' backs the default hierarchy loader (smrt-users is installed
    // in this workspace, so resolveBatch walks the real tenant table).
    db = await getTestDatabase({
      classes: ['FieldPolicy', 'Tenant', 'Membership'],
    });
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

  it('omits sensitive, read-permission-gated, and transient fields for every caller', async () => {
    const result = await policies.resolveBatch({ objectRefs: [objectRef] });

    const fields = result.policies[objectRef].fields;
    expect(fields.docName).toBeDefined();
    expect(fields.blurb).toBeDefined();
    expect(fields.secretKey).toBeUndefined();
    expect(fields.gatedNotes).toBeUndefined();
    expect(fields.derived).toBeUndefined();
  });

  it('validates the objectRefs input and fails on unknown refs', async () => {
    await expect(policies.resolveBatch({})).rejects.toThrow(
      /non-empty "objectRefs"/,
    );
    await expect(policies.resolveBatch({ objectRefs: [] })).rejects.toThrow(
      /non-empty "objectRefs"/,
    );
    await expect(
      policies.resolveBatch({ objectRefs: [42 as any] }),
    ).rejects.toThrow(/non-empty strings/);
    await expect(
      policies.resolveBatch({ objectRefs: ['@test/nowhere:Nope'] }),
    ).rejects.toThrow(/Unknown field policy objectRef/);

    const tooMany = Array.from({ length: 101 }, (_, i) => `@test/x:C${i}`);
    await expect(
      policies.resolveBatch({ objectRefs: tooMany }),
    ).rejects.toThrow(/at most 100 objectRefs/);
  });

  it('deduplicates repeated refs', async () => {
    const result = await policies.resolveBatch({
      objectRefs: [objectRef, objectRef],
    });
    expect(Object.keys(result.policies)).toEqual([objectRef]);
  });

  it('resolves for the ambient tenant context identity (tenant and user tiers)', async () => {
    const tenantId = randomUUID();
    const userId = randomUUID();

    await withSystemContext(() =>
      policies.create({
        objectRef,
        fieldName: 'blurb',
        scopeType: 'app',
        defaultValue: JSON.stringify('app blurb'),
      }),
    );
    await withTenant(
      {
        tenantId,
        userId,
        permissions: new Set([
          MANAGE_FIELD_POLICY_PERMISSION,
          PERSONALIZE_FIELD_POLICY_PERMISSION,
        ]),
      },
      async () => {
        await policies.create({
          objectRef,
          fieldName: 'blurb',
          scopeType: 'tenant',
          tenantId,
          defaultValue: JSON.stringify('tenant blurb'),
        });
        await policies.create({
          objectRef,
          fieldName: 'blurb',
          scopeType: 'user',
          userId,
          defaultValue: JSON.stringify('user blurb'),
        });
      },
    );

    // Outside any context: app tier only.
    const anonymous = await policies.resolveBatch({ objectRefs: [objectRef] });
    expect(anonymous.policies[objectRef].fields.blurb.defaultValue).toBe(
      'app blurb',
    );

    // Inside a session context, tenant + user tiers apply.
    await withTenant(
      {
        tenantId,
        userId,
        permissions: new Set([
          MANAGE_FIELD_POLICY_PERMISSION,
          PERSONALIZE_FIELD_POLICY_PERMISSION,
        ]),
      },
      async () => {
        const scoped = await policies.resolveBatch({
          objectRefs: [objectRef],
        });
        expect(scoped.policies[objectRef].fields.blurb.defaultValue).toBe(
          'user blurb',
        );
      },
    );

    // Tenant-only context: the user tier stays out.
    await withTenant({ tenantId, permissions: new Set<string>() }, async () => {
      const tenantOnly = await policies.resolveBatch({
        objectRefs: [objectRef],
      });
      expect(tenantOnly.policies[objectRef].fields.blurb.defaultValue).toBe(
        'tenant blurb',
      );
    });
  });

  it('ignores identity keys smuggled into the request body', async () => {
    const tenantId = randomUUID();
    await withTenant(
      {
        tenantId,
        userId: randomUUID(),
        permissions: new Set([MANAGE_FIELD_POLICY_PERMISSION]),
      },
      async () => {
        await policies.create({
          objectRef,
          fieldName: 'blurb',
          scopeType: 'tenant',
          tenantId,
          defaultValue: JSON.stringify('tenant blurb'),
        });
      },
    );

    // Without an ambient context, a body-supplied tenantId must not select
    // the tenant tier: only the code seed (blurb's initializer '') resolves.
    const spoofed = await policies.resolveBatch({
      objectRefs: [objectRef],
      tenantId,
      userId: randomUUID(),
    } as any);
    expect(spoofed.policies[objectRef].fields.blurb.defaultValue).toBe('');
  });

  it('returns editor state only for the caller’s allowed policy scopes', async () => {
    const tenantId = randomUUID();
    const userId = randomUUID();

    // Server-owned fixture creation uses the explicit bypass, while every
    // editor call below proves the ordinary permission boundary.
    await withTenant(
      {
        tenantId,
        permissions: new Set<string>(),
        superAdminBypass: true,
      },
      async () => {
        await policies.create({
          objectRef,
          fieldName: 'blurb',
          scopeType: 'app',
          help: 'app help',
        });
        await policies.create({
          objectRef,
          fieldName: 'blurb',
          scopeType: 'tenant',
          tenantId,
          help: 'tenant help',
        });
        await policies.create({
          objectRef,
          fieldName: 'blurb',
          scopeType: 'user',
          userId,
          help: 'my help',
        });
      },
    );

    await withTenant(
      { tenantId, userId, permissions: new Set<string>() },
      async () => {
        await expect(
          policies.getEditorState({ objectRef }),
        ).resolves.toMatchObject({
          code: 'permission_denied',
          ok: false,
          status: 403,
        });
      },
    );

    // API-key/service contexts can carry a permission set but no user
    // identity. They must not receive a useless personal capability/tab.
    await withTenant(
      {
        tenantId,
        permissions: new Set([PERSONALIZE_FIELD_POLICY_PERMISSION]),
      },
      async () => {
        await expect(
          policies.getEditorState({ objectRef }),
        ).resolves.toMatchObject({
          code: 'permission_denied',
          ok: false,
          status: 403,
        });
      },
    );

    // A trusted service actor may still manage org policy without a user id,
    // but it never receives a self-personalization capability.
    await withTenant(
      {
        tenantId,
        permissions: new Set<string>(),
        superAdminBypass: true,
      },
      async () => {
        const state = await policies.getEditorState({ objectRef });
        if (!('capabilities' in state))
          throw new Error('expected editor state');
        expect(state.capabilities).toEqual({
          manage: true,
          personalize: false,
        });
        expect(state.rows.user).toEqual([]);
      },
    );

    await withTenant(
      {
        tenantId,
        userId,
        permissions: new Set([MANAGE_FIELD_POLICY_PERMISSION]),
      },
      async () => {
        const state = await policies.getEditorState({ objectRef });
        if (!('capabilities' in state))
          throw new Error('expected editor state');
        expect(state.capabilities).toEqual({
          manage: true,
          personalize: false,
        });
        expect(state.rows.app).toHaveLength(1);
        expect(state.rows.tenant).toHaveLength(1);
        expect(state.rows.user).toEqual([]);
        expect(state.rows.app[0].id).toBeTruthy();
        expect(state.policy.layers.blurb.map((layer) => layer.layer)).toEqual([
          'app',
          'tenant',
        ]);
      },
    );

    await withTenant(
      {
        tenantId,
        userId,
        permissions: new Set([PERSONALIZE_FIELD_POLICY_PERMISSION]),
      },
      async () => {
        const state = await policies.getEditorState({ objectRef });
        if (!('capabilities' in state))
          throw new Error('expected editor state');
        expect(state.capabilities).toEqual({
          manage: false,
          personalize: true,
        });
        expect(state.rows.app).toEqual([]);
        expect(state.rows.tenant).toEqual([]);
        expect(state.rows.user).toHaveLength(1);
        expect(state.rows.user[0].id).toBeTruthy();
        expect(state.policy.layers.blurb.map((layer) => layer.layer)).toEqual([
          'user',
        ]);
      },
    );

    await withTenant(
      {
        tenantId,
        userId,
        permissions: new Set([
          MANAGE_FIELD_POLICY_PERMISSION,
          PERSONALIZE_FIELD_POLICY_PERMISSION,
        ]),
      },
      async () => {
        const state = await policies.getEditorState({ objectRef });
        if (!('capabilities' in state))
          throw new Error('expected editor state');
        expect(state.rows.app).toHaveLength(1);
        expect(state.rows.tenant).toHaveLength(1);
        expect(state.rows.user).toHaveLength(1);
        expect(state.policy.layers.blurb.map((layer) => layer.layer)).toEqual([
          'app',
          'tenant',
          'user',
        ]);
      },
    );
  });

  it('returns a manage-gated catalog audit with rows, explained layers, and count-only user overrides', async () => {
    const tenantId = randomUUID();
    const managerId = randomUUID();
    const otherUserId = randomUUID();
    const foreignTenantId = randomUUID();
    const foreignUserId = randomUUID();
    const memberships = await MembershipCollection.create({ db });
    await memberships.create({
      userId: otherUserId,
      tenantId,
      roleId: randomUUID(),
    });
    await memberships.create({
      userId: foreignUserId,
      tenantId: foreignTenantId,
      roleId: randomUUID(),
    });
    await withTenant(
      {
        tenantId,
        userId: managerId,
        permissions: new Set<string>(),
        superAdminBypass: true,
      },
      async () => {
        await policies.create({
          objectRef,
          fieldName: 'blurb',
          scopeType: 'app',
          label: 'Application label',
        });
        await policies.create({
          objectRef,
          fieldName: 'blurb',
          scopeType: 'tenant',
          tenantId,
          help: 'Tenant help',
        });
        await policies.create({
          objectRef,
          fieldName: 'blurb',
          scopeType: 'user',
          userId: otherUserId,
          label: 'Private label',
        });
        await policies.create({
          objectRef,
          fieldName: 'blurb',
          scopeType: 'user',
          userId: foreignUserId,
          label: 'Foreign private label',
        });
      },
    );

    await withTenant(
      {
        tenantId,
        userId: managerId,
        permissions: new Set([MANAGE_FIELD_POLICY_PERMISSION]),
      },
      async () => {
        const audit = await policies.policyAudit({ objectRefs: [objectRef] });
        expect(audit.caller.canManageOrg).toBe(true);
        expect(audit.appRows).toMatchObject([
          { objectRef, fieldName: 'blurb', label: 'Application label' },
        ]);
        expect(audit.orgRows).toMatchObject([
          { objectRef, fieldName: 'blurb', help: 'Tenant help' },
        ]);
        expect(audit.userOverrideCounts[objectRef]?.blurb).toBe(1);
        expect(audit.policies[objectRef]?.fields.blurb.help).toBe(
          'Tenant help',
        );
        expect(
          audit.policies[objectRef]?.layers.blurb.map((layer) => layer.layer),
        ).toEqual(['code', 'app', 'tenant']);

        const catalog = await buildFieldPolicySettingsCatalog({
          collection: policies,
          objectRefs: [objectRef],
          customizedOnly: true,
        });
        expect(catalog.page.items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ objectRef, fieldName: 'blurb' }),
          ]),
        );

        const countsOnly = await policies.policyAudit({
          objectRefs: [objectRef],
          countsOnly: true,
        });
        expect(countsOnly.policies).toEqual({});
        expect(countsOnly.appRows).toHaveLength(1);
        expect(countsOnly.orgRows).toHaveLength(1);
        expect(countsOnly.userOverrideCounts[objectRef]?.blurb).toBe(1);
      },
    );

    await withTenant(
      { tenantId, userId: managerId, permissions: new Set<string>() },
      async () => {
        const denied = await policies.policyAudit({ objectRefs: [objectRef] });
        expect(denied).toMatchObject({
          orgRows: [],
          appRows: [],
          driftRows: [],
          policies: {},
          caller: { canManageOrg: false },
        });
      },
    );
  });

  it('returns a non-disclosing usable-lower-default signal for a personalize-only editor', async () => {
    const tenantId = randomUUID();
    const userId = randomUUID();

    await withSystemContext(async () => {
      await policies.create({
        objectRef,
        fieldName: 'docName',
        scopeType: 'app',
        defaultValue: JSON.stringify('organization fallback'),
      });
    });
    await withTenant(
      {
        tenantId,
        userId,
        permissions: new Set([PERSONALIZE_FIELD_POLICY_PERMISSION]),
      },
      async () => {
        await policies.create({
          objectRef,
          fieldName: 'docName',
          scopeType: 'user',
          defaultValue: JSON.stringify('personal default'),
          visibility: 'hidden',
        });

        const state = await policies.getEditorState({ objectRef });
        if (!('capabilities' in state))
          throw new Error('expected editor state');
        expect(state.capabilities).toEqual({
          manage: false,
          personalize: true,
        });
        expect(state.personalLowerDefaultUsable.docName).toBe(true);
        expect(state.rows.app).toEqual([]);
        expect(state.rows.tenant).toEqual([]);
        expect(state.policy.layers.docName.map((layer) => layer.layer)).toEqual(
          ['user'],
        );
        // The effective policy and own row may show the caller's default, but
        // the lower app value never crosses the personalize-only boundary.
        expect(JSON.stringify(state)).not.toContain('organization fallback');

        // The editor signal mirrors, but does not replace, the authoritative
        // model validation: clearing the persisted personal default while
        // retaining hidden is permitted only because the app fallback exists.
        const own = await policies.get({ id: state.rows.user[0]?.id ?? '' });
        if (!own) throw new Error('expected persisted personal policy row');
        own.defaultValue = null;
        own.visibility = 'hidden';
        await expect(own.save()).resolves.toBe(own);
      },
    );
  });
});
