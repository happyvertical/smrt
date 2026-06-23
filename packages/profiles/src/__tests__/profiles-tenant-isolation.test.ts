/**
 * Regression tests for the tenant-global query helpers (#1600) in smrt-profiles.
 *
 * Profile is `@TenantScoped({ mode: 'optional' })` (STI base, own table). Its
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
import { ProfileCollection } from '../collections/ProfileCollection';
import { ProfileTypeCollection } from '../collections/ProfileTypeCollection';

const sorted = (rows: Array<Record<string, any>>, field: string): string[] =>
  rows.map((r) => String(r[field] ?? '')).sort();

describe('profiles tenant isolation (#1600)', () => {
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

  it('ProfileCollection.findGlobal/findWithGlobals do not throw and stay tenant-scoped', async () => {
    // Profile.typeId is a required FK to ProfileType; seed one global type and
    // reference it from every profile so each `.save()` satisfies validation.
    const types = await ProfileTypeCollection.create({ db });
    const profileType = await withSystemContext(async () => {
      const t = await types.create({ name: 'Person' });
      await t.save();
      return t;
    });
    const typeId = profileType.id as string;

    const profiles = await ProfileCollection.create({ db });
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      await (await profiles.create({ typeId, name: 't1-profile' })).save();
    });
    await withTenant({ tenantId: 'tenant-2' }, async () => {
      await (await profiles.create({ typeId, name: 't2-profile' })).save();
    });
    await withSystemContext(async () => {
      await (await profiles.create({ typeId, name: 'g-profile' })).save();
    });

    // findGlobal under an active tenant returns ONLY globals (no throw).
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () => profiles.findGlobal()),
        'name',
      ),
    ).toEqual(['g-profile']);

    // findWithGlobals returns the tenant's rows plus globals — never tenant-2's.
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          profiles.findWithGlobals('tenant-1'),
        ),
        'name',
      ),
    ).toEqual(['g-profile', 't1-profile']);

    // Fails closed for a tenant other than the active context.
    await expect(
      withTenant({ tenantId: 'tenant-1' }, () =>
        profiles.findWithGlobals('tenant-2'),
      ),
    ).rejects.toThrow(/isolation/i);

    // System context keeps the deliberate cross-tenant admin capability.
    expect(
      sorted(
        await withSystemContext(() => profiles.findWithGlobals('tenant-2')),
        'name',
      ),
    ).toEqual(['g-profile', 't2-profile']);
  });
});
