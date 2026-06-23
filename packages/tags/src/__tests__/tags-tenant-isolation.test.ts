/**
 * Regression tests for the tenant-global query helpers (#1600) in smrt-tags.
 *
 * Tag / TagAlias are both `@TenantScoped({ mode: 'optional' })` (STI). Their
 * collections used to expose:
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
import { TagAliasCollection } from '../tag-aliases';
import { TagCollection } from '../tags';

const sorted = (rows: Array<Record<string, any>>, field: string): string[] =>
  rows.map((r) => String(r[field] ?? '')).sort();

describe('tags tenant isolation (#1600)', () => {
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

  it('TagCollection.findGlobal/findWithGlobals do not throw and stay tenant-scoped', async () => {
    const tags = await TagCollection.create({ db });
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      await (
        await tags.create({ slug: 't1-tag', name: 't1-tag', context: 'global' })
      ).save();
    });
    await withTenant({ tenantId: 'tenant-2' }, async () => {
      await (
        await tags.create({ slug: 't2-tag', name: 't2-tag', context: 'global' })
      ).save();
    });
    await withSystemContext(async () => {
      await (
        await tags.create({ slug: 'g-tag', name: 'g-tag', context: 'global' })
      ).save();
    });

    // findGlobal under an active tenant returns ONLY globals (no throw).
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () => tags.findGlobal()),
        'name',
      ),
    ).toEqual(['g-tag']);

    // findWithGlobals returns the tenant's rows plus globals — never tenant-2's.
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          tags.findWithGlobals('tenant-1'),
        ),
        'name',
      ),
    ).toEqual(['g-tag', 't1-tag']);

    // Fails closed for a tenant other than the active context.
    await expect(
      withTenant({ tenantId: 'tenant-1' }, () =>
        tags.findWithGlobals('tenant-2'),
      ),
    ).rejects.toThrow(/isolation/i);

    // System context keeps the deliberate cross-tenant admin capability.
    expect(
      sorted(
        await withSystemContext(() => tags.findWithGlobals('tenant-2')),
        'name',
      ),
    ).toEqual(['g-tag', 't2-tag']);
  });

  it('TagAliasCollection.findGlobal/findWithGlobals do not throw and stay tenant-scoped', async () => {
    const aliases = await TagAliasCollection.create({ db });
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      await (
        await aliases.create({ tagSlug: 't1-tag', alias: 't1-alias' })
      ).save();
    });
    await withTenant({ tenantId: 'tenant-2' }, async () => {
      await (
        await aliases.create({ tagSlug: 't2-tag', alias: 't2-alias' })
      ).save();
    });
    await withSystemContext(async () => {
      await (
        await aliases.create({ tagSlug: 'g-tag', alias: 'g-alias' })
      ).save();
    });

    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () => aliases.findGlobal()),
        'alias',
      ),
    ).toEqual(['g-alias']);
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          aliases.findWithGlobals('tenant-1'),
        ),
        'alias',
      ),
    ).toEqual(['g-alias', 't1-alias']);
    await expect(
      withTenant({ tenantId: 'tenant-1' }, () =>
        aliases.findWithGlobals('tenant-2'),
      ),
    ).rejects.toThrow(/isolation/i);
    expect(
      sorted(
        await withSystemContext(() => aliases.findWithGlobals('tenant-2')),
        'alias',
      ),
    ).toEqual(['g-alias', 't2-alias']);
  });
});
