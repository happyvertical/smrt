/**
 * Regression tests for the tenant-global query helpers (#1600) in smrt-places.
 *
 * Place is `@TenantScoped({ mode: 'optional' })` (STI, nullable tenantId). Its
 * collection used to expose:
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
import { PlaceCollection } from '../collections/PlaceCollection';

const sorted = (rows: Array<Record<string, any>>, field: string): string[] =>
  rows.map((r) => String(r[field] ?? '')).sort();

describe('places tenant isolation (#1600)', () => {
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

  it('PlaceCollection.findGlobal/findWithGlobals do not throw and stay tenant-scoped', async () => {
    const places = await PlaceCollection.create({ db });
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      await (await places.create({ name: 't1-place' })).save();
    });
    await withTenant({ tenantId: 'tenant-2' }, async () => {
      await (await places.create({ name: 't2-place' })).save();
    });
    await withSystemContext(async () => {
      await (await places.create({ name: 'g-place' })).save();
    });

    // findGlobal under an active tenant returns ONLY globals (no throw).
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () => places.findGlobal()),
        'name',
      ),
    ).toEqual(['g-place']);

    // findWithGlobals returns the tenant's rows plus globals — never tenant-2's.
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          places.findWithGlobals('tenant-1'),
        ),
        'name',
      ),
    ).toEqual(['g-place', 't1-place']);

    // Fails closed for a tenant other than the active context.
    await expect(
      withTenant({ tenantId: 'tenant-1' }, () =>
        places.findWithGlobals('tenant-2'),
      ),
    ).rejects.toThrow(/isolation/i);

    // System context keeps the deliberate cross-tenant admin capability.
    expect(
      sorted(
        await withSystemContext(() => places.findWithGlobals('tenant-2')),
        'name',
      ),
    ).toEqual(['g-place', 't2-place']);
  });
});
