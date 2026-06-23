/**
 * Regression tests for the tenant-global query helpers (#1600) in smrt-ads.
 *
 * AdEvent / AdGroup / AdVariation are all `@TenantScoped({ mode: 'optional' })`
 * (STI, own tables). Their collections used to expose:
 *   findGlobal()         → list({ where: { tenantId: null } })
 *   findWithGlobals(tid)  → raw `WHERE tenant_id = ? OR tenant_id IS NULL`
 * Under an ACTIVE tenant context with tenancy enabled (default `'throw'`
 * policy) BOTH throw: the explicit `tenant_id IS NULL` filter is flagged as an
 * isolation violation, and unflagged raw SQL on a tenant-scoped class is
 * blocked. `findWithGlobals` also trusted its caller-supplied `tenantId`.
 *
 * They now route through the shared `@happyvertical/smrt-tenancy` helpers, which
 * run raw with `{ allowRawOnTenantScoped: true }` and fail closed when an active
 * tenant context requests another tenant's rows (admin/system path keeps the
 * cross-tenant capability). Mirrors
 * `packages/ledgers/src/__tests__/ledgers-tenant-isolation.test.ts`.
 *
 * Real in-memory SQLite, no DB mocking, tenancy enabled under the default
 * `'throw'` policy, per `.claude/rules/testing.md`.
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withSystemContext,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AdEventCollection } from '../collections/AdEventCollection';
import { AdGroupCollection } from '../collections/AdGroupCollection';
import { AdVariationCollection } from '../collections/AdVariationCollection';

const sorted = (rows: Array<Record<string, any>>, field: string): string[] =>
  rows.map((r) => String(r[field] ?? '')).sort();

describe('ads tenant isolation (#1600)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    enableTenancy(); // default rawQueryPolicy: 'throw'
  });

  afterEach(async () => {
    disableTenancy();
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  it('AdEventCollection.findGlobal/findWithGlobals do not throw and stay tenant-scoped', async () => {
    const events = await AdEventCollection.create({ db });
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      await (await events.create({ siteId: 't1-evt' })).save();
    });
    await withTenant({ tenantId: 'tenant-2' }, async () => {
      await (await events.create({ siteId: 't2-evt' })).save();
    });
    await withSystemContext(async () => {
      await (await events.create({ siteId: 'g-evt' })).save();
    });

    // findGlobal under an active tenant returns ONLY globals (no throw).
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () => events.findGlobal()),
        'siteId',
      ),
    ).toEqual(['g-evt']);

    // findWithGlobals returns the tenant's rows plus globals — never tenant-2's.
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          events.findWithGlobals('tenant-1'),
        ),
        'siteId',
      ),
    ).toEqual(['g-evt', 't1-evt']);

    // Fails closed for a tenant other than the active context.
    await expect(
      withTenant({ tenantId: 'tenant-1' }, () =>
        events.findWithGlobals('tenant-2'),
      ),
    ).rejects.toThrow(/isolation/i);

    // System context keeps the deliberate cross-tenant admin capability.
    expect(
      sorted(
        await withSystemContext(() => events.findWithGlobals('tenant-2')),
        'siteId',
      ),
    ).toEqual(['g-evt', 't2-evt']);
  });

  it('AdGroupCollection.findGlobal/findWithGlobals do not throw and stay tenant-scoped', async () => {
    const groups = await AdGroupCollection.create({ db });
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      await (await groups.create({ name: 't1-group' })).save();
    });
    await withTenant({ tenantId: 'tenant-2' }, async () => {
      await (await groups.create({ name: 't2-group' })).save();
    });
    await withSystemContext(async () => {
      await (await groups.create({ name: 'g-group' })).save();
    });

    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () => groups.findGlobal()),
        'name',
      ),
    ).toEqual(['g-group']);
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          groups.findWithGlobals('tenant-1'),
        ),
        'name',
      ),
    ).toEqual(['g-group', 't1-group']);
    await expect(
      withTenant({ tenantId: 'tenant-1' }, () =>
        groups.findWithGlobals('tenant-2'),
      ),
    ).rejects.toThrow(/isolation/i);
    expect(
      sorted(
        await withSystemContext(() => groups.findWithGlobals('tenant-2')),
        'name',
      ),
    ).toEqual(['g-group', 't2-group']);
  });

  it('AdVariationCollection.findGlobal/findWithGlobals do not throw and stay tenant-scoped', async () => {
    const variations = await AdVariationCollection.create({ db });
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      await (await variations.create({ name: 't1-var' })).save();
    });
    await withTenant({ tenantId: 'tenant-2' }, async () => {
      await (await variations.create({ name: 't2-var' })).save();
    });
    await withSystemContext(async () => {
      await (await variations.create({ name: 'g-var' })).save();
    });

    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          variations.findGlobal(),
        ),
        'name',
      ),
    ).toEqual(['g-var']);
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          variations.findWithGlobals('tenant-1'),
        ),
        'name',
      ),
    ).toEqual(['g-var', 't1-var']);
    await expect(
      withTenant({ tenantId: 'tenant-1' }, () =>
        variations.findWithGlobals('tenant-2'),
      ),
    ).rejects.toThrow(/isolation/i);
    expect(
      sorted(
        await withSystemContext(() => variations.findWithGlobals('tenant-2')),
        'name',
      ),
    ).toEqual(['g-var', 't2-var']);
  });
});
