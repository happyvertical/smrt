/**
 * Regression tests for the tenant-global query helper (#1600) in smrt-video.
 *
 * Character is `@TenantScoped({ mode: 'optional' })`. Its collection only
 * exposes `findGlobal()` (there is no `findWithGlobals`). That method used to
 * call:
 *   findGlobal() → list({ where: { tenantId: null } })
 * Under an ACTIVE tenant context with tenancy enabled (default `'throw'`
 * policy) this throws: the explicit `tenant_id IS NULL` filter is flagged as an
 * isolation violation.
 *
 * It now routes through the shared `@happyvertical/smrt-tenancy` `queryGlobal`
 * helper, which runs raw with `{ allowRawOnTenantScoped: true }` so it returns
 * ONLY the global (tenant-less) rows without throwing under an active tenant.
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
import { CharacterCollection } from '../characters.js';

const sorted = (rows: Array<Record<string, any>>, field: string): string[] =>
  rows.map((r) => String(r[field] ?? '')).sort();

describe('video tenant isolation (#1600)', () => {
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

  it('CharacterCollection.findGlobal does not throw and returns only globals', async () => {
    const characters = await CharacterCollection.create({ db });
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      await (await characters.create({ name: 't1-char' })).save();
    });
    await withTenant({ tenantId: 'tenant-2' }, async () => {
      await (await characters.create({ name: 't2-char' })).save();
    });
    await withSystemContext(async () => {
      await (await characters.create({ name: 'g-char' })).save();
    });

    // findGlobal under an active tenant returns ONLY globals (no throw).
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          characters.findGlobal(),
        ),
        'name',
      ),
    ).toEqual(['g-char']);
  });
});
