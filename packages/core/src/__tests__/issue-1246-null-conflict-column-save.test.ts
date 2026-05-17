/**
 * Issue #1246: re-saving an instance whose conflictColumns include a NULL
 * value must not violate the primary-key UNIQUE constraint on `id`.
 *
 * Background
 * ----------
 * Models like {@link InventoryLocation} declare
 * `conflictColumns: ['code', 'tenant_id']`. When tenancy is disabled (or the
 * row is global), `tenant_id` is `NULL`. SQLite — and PostgreSQL with default
 * settings — treat `NULL` as distinct from every other value in an
 * `ON CONFLICT` clause, so a subsequent UPSERT of the same instance can't
 * match the existing row by its (code, NULL) tuple. The DB then tries to
 * INSERT a second row with the same `id`, which collides on the primary
 * key:
 *
 *     SQLITE_CONSTRAINT: UNIQUE constraint failed: inventory_locations.id
 *
 * This is *not* a singleton / cross-test state leak: every `save()` of a
 * persisted row whose conflict columns contain a NULL value will fail on
 * its own.
 *
 * The fix probes by `id` when any conflict column is NULL and routes to
 * an UPDATE-by-id instead of the upsert. See `planPersistenceWrite()` in
 * `packages/core/src/object.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { field } from '../decorators';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { getTestDatabase } from '../testing/database';

@smrt({
  tableName: 'issue_1246_locations',
  conflictColumns: ['code', 'tenant_id'],
})
class Issue1246Location extends SmrtObject {
  @field()
  code: string = '';

  @field()
  name: string = '';

  // Nullable tenantId — the field that breaks ON CONFLICT semantics when null
  @field({ required: false })
  tenantId: string | null = null;

  constructor(options: Record<string, any> = {}) {
    super(options as any);
    if (options.code !== undefined) this.code = options.code;
    if (options.name !== undefined) this.name = options.name;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
  }
}

describe('Issue #1246: save() with NULL conflict column values', () => {
  let db: Awaited<ReturnType<typeof getTestDatabase>>;

  beforeEach(async () => {
    db = await getTestDatabase({
      classes: ['Issue1246Location'],
    });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  it('re-saves the same instance without colliding on the id PK', async () => {
    const loc = new Issue1246Location({
      db,
      code: 'DC-1',
      name: 'Main warehouse',
    });
    await loc.initialize();
    await loc.save();

    expect(loc.id).toBeDefined();
    expect(loc.tenantId).toBeNull();

    // Mutate and re-save — the bug manifests here without the fix.
    loc.name = 'Main warehouse (renamed)';
    await loc.save();

    const row = await db.get('issue_1246_locations', { id: loc.id! });
    expect(row).toBeTruthy();
    expect((row as Record<string, unknown>).name).toBe(
      'Main warehouse (renamed)',
    );

    // Still exactly one row — the second save must not have inserted a dup.
    const all = await db.list('issue_1246_locations', {});
    expect(all).toHaveLength(1);
  });

  it('allows saving multiple distinct instances with NULL tenant_id', async () => {
    const dc = new Issue1246Location({ db, code: 'DC-1', name: 'DC' });
    await dc.initialize();
    await dc.save();

    const store = new Issue1246Location({ db, code: 'STORE-1', name: 'Store' });
    await store.initialize();
    await store.save();

    const all = await db.list('issue_1246_locations', {});
    expect(all).toHaveLength(2);
    expect(new Set(all.map((r: any) => r.code))).toEqual(
      new Set(['DC-1', 'STORE-1']),
    );
  });

  it('re-saves an instance with non-null tenant_id (regression guard)', async () => {
    // The non-null tenant case must keep working unchanged.
    const loc = new Issue1246Location({
      db,
      code: 'DC-1',
      name: 'Warehouse A',
      tenantId: 'tenant-a',
    });
    await loc.initialize();
    await loc.save();

    loc.name = 'Warehouse A (v2)';
    await loc.save();

    const all = await db.list('issue_1246_locations', {});
    expect(all).toHaveLength(1);
    expect((all[0] as Record<string, unknown>).name).toBe('Warehouse A (v2)');
    expect((all[0] as Record<string, unknown>).tenant_id).toBe('tenant-a');
  });

  it('keeps two NULL-tenant rows with the same code as separate rows', async () => {
    // SQLite (and PG default) say NULL != NULL, so two rows with the same
    // code but both NULL tenant_id are both valid. The fix must preserve
    // that semantic — we must NOT collapse them.
    const a = new Issue1246Location({ db, code: 'DC-1', name: 'Warehouse A' });
    await a.initialize();
    await a.save();

    const b = new Issue1246Location({ db, code: 'DC-1', name: 'Warehouse B' });
    await b.initialize();
    await b.save();

    expect(a.id).not.toBe(b.id);

    const all = await db.list('issue_1246_locations', {});
    expect(all).toHaveLength(2);
  });

  it('repeats the production failure shape: collection.create then .save()', async () => {
    // The exact pattern from packages/inventory/src/__tests__/stock-service.test.ts:
    // SmrtCollection.create(...) already calls save() internally, and the
    // test code then calls instance.save() again. Both saves should succeed.
    const { SmrtCollection } = await import('../collection');

    class Issue1246LocationCollection extends SmrtCollection<Issue1246Location> {
      static readonly _itemClass = Issue1246Location;
    }
    ObjectRegistry.registerCollection(
      'Issue1246Location',
      Issue1246LocationCollection,
    );

    const locations = await Issue1246LocationCollection.create({ db });
    const loc = (await locations.create({
      code: 'DC-1',
      name: 'Main warehouse',
    })) as Issue1246Location;

    // This second save is where the bug manifested.
    await loc.save();

    const all = await db.list('issue_1246_locations', {});
    expect(all).toHaveLength(1);
  });
});
