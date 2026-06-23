/**
 * Regression tests for the tenant-global query helpers (#1600) in
 * smrt-properties.
 *
 * Property / Zone are both `@TenantScoped({ mode: 'optional' })`. Their
 * collections used to expose:
 *   findGlobal()          → list({ where: { tenantId: null } })
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
import { PropertyCollection } from '../collections/Properties';
import { ZoneCollection } from '../collections/Zones';

const sorted = (rows: Array<Record<string, any>>, field: string): string[] =>
  rows.map((r) => String(r[field] ?? '')).sort();

describe('properties tenant isolation (#1600)', () => {
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

  it('PropertyCollection.findGlobal/findWithGlobals do not throw and stay tenant-scoped', async () => {
    const properties = await PropertyCollection.create({ db });
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      await (
        await properties.create({ name: 't1-prop', domain: 't1.example.com' })
      ).save();
    });
    await withTenant({ tenantId: 'tenant-2' }, async () => {
      await (
        await properties.create({ name: 't2-prop', domain: 't2.example.com' })
      ).save();
    });
    await withSystemContext(async () => {
      await (
        await properties.create({ name: 'g-prop', domain: 'g.example.com' })
      ).save();
    });

    // findGlobal under an active tenant returns ONLY globals (no throw).
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          properties.findGlobal(),
        ),
        'name',
      ),
    ).toEqual(['g-prop']);

    // findWithGlobals returns the tenant's rows plus globals — never tenant-2's.
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          properties.findWithGlobals('tenant-1'),
        ),
        'name',
      ),
    ).toEqual(['g-prop', 't1-prop']);

    // Fails closed for a tenant other than the active context.
    await expect(
      withTenant({ tenantId: 'tenant-1' }, () =>
        properties.findWithGlobals('tenant-2'),
      ),
    ).rejects.toThrow(/isolation/i);

    // System context keeps the deliberate cross-tenant admin capability.
    expect(
      sorted(
        await withSystemContext(() => properties.findWithGlobals('tenant-2')),
        'name',
      ),
    ).toEqual(['g-prop', 't2-prop']);
  });

  it('ZoneCollection.findGlobal/findWithGlobals do not throw and stay tenant-scoped', async () => {
    const zones = await ZoneCollection.create({ db });
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      await (await zones.create({ propertyId: 'p1', name: 't1-zone' })).save();
    });
    await withTenant({ tenantId: 'tenant-2' }, async () => {
      await (await zones.create({ propertyId: 'p2', name: 't2-zone' })).save();
    });
    await withSystemContext(async () => {
      await (await zones.create({ propertyId: 'pg', name: 'g-zone' })).save();
    });

    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () => zones.findGlobal()),
        'name',
      ),
    ).toEqual(['g-zone']);
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          zones.findWithGlobals('tenant-1'),
        ),
        'name',
      ),
    ).toEqual(['g-zone', 't1-zone']);
    await expect(
      withTenant({ tenantId: 'tenant-1' }, () =>
        zones.findWithGlobals('tenant-2'),
      ),
    ).rejects.toThrow(/isolation/i);
    expect(
      sorted(
        await withSystemContext(() => zones.findWithGlobals('tenant-2')),
        'name',
      ),
    ).toEqual(['g-zone', 't2-zone']);
  });
});
