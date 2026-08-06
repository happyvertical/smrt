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
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// Side-effect import: registers smrt-users' classes (Tenant) so
// getTestDatabase can create the tenants table the default hierarchy loader
// reads under an ambient tenant context.
import '../../users/src/index.js';
import { clearFieldPolicyCache } from './cache.js';
import { FieldPolicyCollection } from './collections/FieldPolicyCollection.js';

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

    await policies.create({
      objectRef,
      fieldName: 'blurb',
      scopeType: 'app',
      defaultValue: JSON.stringify('app blurb'),
    });
    await withTenant(
      { tenantId, userId, permissions: new Set<string>() },
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
      { tenantId, userId, permissions: new Set<string>() },
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
    await withTenant({ tenantId, permissions: new Set<string>() }, async () => {
      await policies.create({
        objectRef,
        fieldName: 'blurb',
        scopeType: 'tenant',
        tenantId,
        defaultValue: JSON.stringify('tenant blurb'),
      });
    });

    // Without an ambient context, a body-supplied tenantId must not select
    // the tenant tier: only the code seed (blurb's initializer '') resolves.
    const spoofed = await policies.resolveBatch({
      objectRefs: [objectRef],
      tenantId,
      userId: randomUUID(),
    } as any);
    expect(spoofed.policies[objectRef].fields.blurb.defaultValue).toBe('');
  });
});
