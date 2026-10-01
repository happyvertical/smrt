/**
 * Natural-key ownership on the compatible junction batch path and the strict
 * insert path (follow-up to the Anytown Ludis takeover fix).
 *
 * `tryJunctionBatch` writes new rows with one multi-row
 * `INSERT … ON CONFLICT (…) DO UPDATE SET`, which cannot run `save()`'s
 * per-row natural-key identity guard:
 *
 * - a same-owner collision must not rewrite the existing row's primary key
 *   (the SET list used to include `"id" = excluded.id`);
 * - a conflict target that omits ANY ownership column present in the row —
 *   `tenant_id`, the declared tenant column, or any `@tenantId`-marked field —
 *   must take the per-item path, where a cross-owner collision is refused.
 *
 * `_insertOnly` saves skip the upsert guard, so a NULL-bearing natural key
 * (which a unique index cannot enforce) is checked explicitly.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { field } from '../decorators/index.js';
import { ValidationError } from '../errors.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { getTestDatabase } from '../testing/database.js';

const TENANT_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

/** Tenant-owned, with the owner in the explicit conflict target. */
@smrt({
  tableName: 'nkb_links',
  conflictColumns: ['tenant_id', 'owner_id', 'asset_id'],
})
class NkbLink extends SmrtObject {
  @field({ required: true }) ownerId = '';
  @field({ required: true }) assetId = '';
  @field() sortOrder = 0;
  @field({ sqlType: 'UUID', nullable: true })
  tenantId: string | null = null;
}

/** Tenant-owned, but the explicit conflict target omits the owner. */
@smrt({
  tableName: 'nkb_uncovered_links',
  conflictColumns: ['owner_id', 'asset_id'],
})
class NkbUncoveredLink extends SmrtObject {
  @field({ required: true }) ownerId = '';
  @field({ required: true }) assetId = '';
  @field({ sqlType: 'UUID', nullable: true })
  tenantId: string | null = null;
}

/** Owner held in a non-standard `@tenantId`-marked column (`org_id`). */
@smrt({
  tableName: 'nkb_org_links',
  conflictColumns: ['owner_id', 'asset_id'],
})
class NkbOrgLink extends SmrtObject {
  @field({ required: true }) ownerId = '';
  @field({ required: true }) assetId = '';
  @field({ sqlType: 'UUID', nullable: true })
  orgId: string | null = null;
}

type Row = Record<string, unknown>;

async function link<T extends SmrtObject>(
  Ctor: new (options: never) => T,
  db: unknown,
  values: Record<string, unknown>,
): Promise<T> {
  const item = new Ctor({ db } as never);
  await item.initialize();
  Object.assign(item, values);
  return item;
}

describe('natural-key ownership on the batch and strict-insert paths', () => {
  let db: Awaited<ReturnType<typeof getTestDatabase>>;

  beforeAll(async () => {
    // Mark `orgId` as a tenant field exactly as `@tenantId()` from
    // smrt-tenancy does, without importing that package into core.
    const orgField = ObjectRegistry.getFields('NkbOrgLink').get('orgId');
    if (!orgField) throw new Error('NkbOrgLink.orgId is not registered');
    orgField._meta = {
      ...(orgField._meta ?? {}),
      __tenancy: { isTenantIdField: true, mode: 'optional' },
    };
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['NkbLink', 'NkbUncoveredLink', 'NkbOrgLink'],
    });
  });

  afterAll(async () => {
    await db?.close?.();
  });

  beforeEach(async () => {
    for (const table of ['nkb_links', 'nkb_uncovered_links', 'nkb_org_links']) {
      await db.query(`DELETE FROM ${table}`);
    }
  });

  it('a same-owner batch collision never rewrites the existing primary key', async () => {
    const first = await link(NkbLink, db, {
      ownerId: 'o',
      assetId: 'a',
      tenantId: TENANT_A,
    });
    await first.save();
    const existingId = first.id;

    const dup = await link(NkbLink, db, {
      ownerId: 'o',
      assetId: 'a',
      tenantId: TENANT_A,
      sortOrder: 7,
    });
    const fresh = await link(NkbLink, db, {
      ownerId: 'o',
      assetId: 'b',
      tenantId: TENANT_A,
    });
    const batched = await SmrtObject.tryJunctionBatch([], [dup, fresh]);
    // Existing rows take the per-item path, whose guard adopts their id.
    if (!batched) {
      await dup.save();
      await fresh.save();
    }

    const rows = (await db.list('nkb_links', {})) as Row[];
    expect(rows).toHaveLength(2);
    const row = rows.find((candidate) => candidate.asset_id === 'a');
    expect(row?.id).toBe(existingId);
    expect(dup.id).toBe(existingId);
    expect(Number(row?.sort_order)).toBe(7);
  });

  it('a batch of only new keys still goes through one statement', async () => {
    const items = await Promise.all(
      ['x', 'y', 'z'].map((assetId) =>
        link(NkbLink, db, { ownerId: 'o', assetId, tenantId: TENANT_A }),
      ),
    );
    expect(await SmrtObject.tryJunctionBatch([], items)).toBe(true);
    const rows = (await db.list('nkb_links', {})) as Row[];
    expect(rows.map((row) => row.id).sort()).toEqual(
      items.map((item) => item.id).sort(),
    );
  });

  it('falls back to per-item saves when the conflict target omits tenant_id', async () => {
    const item = await link(NkbUncoveredLink, db, {
      ownerId: 'o',
      assetId: 'a',
      tenantId: TENANT_A,
    });
    expect(await SmrtObject.tryJunctionBatch([], [item])).toBe(false);
    expect(await db.list('nkb_uncovered_links', {})).toEqual([]);
  });

  it('falls back to per-item saves when the conflict target omits any @tenantId-marked column', async () => {
    const item = await link(NkbOrgLink, db, {
      ownerId: 'o',
      assetId: 'a',
      orgId: TENANT_A,
    });
    expect(await SmrtObject.tryJunctionBatch([], [item])).toBe(false);
    expect(await db.list('nkb_org_links', {})).toEqual([]);
  });

  it('a strict insert refuses a NULL-bearing natural key the unique index cannot enforce', async () => {
    const global = await link(NkbLink, db, { ownerId: 'o', assetId: 'g' });
    await global.save();

    const again = await link(NkbLink, db, { ownerId: 'o', assetId: 'g' });
    again.requireInsertOnSave();
    await expect(again.save()).rejects.toBeInstanceOf(ValidationError);

    const rows = (await db.list('nkb_links', {})) as Row[];
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(global.id);
    expect(rows[0].tenant_id).toBeNull();
  });
});
