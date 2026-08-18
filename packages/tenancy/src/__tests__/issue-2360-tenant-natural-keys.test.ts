/**
 * Issue #2360 (epic #2382, finding B1): the interceptor-driven probe.
 *
 * `withTenant(A) create({ name: 'Widget' })` followed by
 * `withTenant(B) create({ name: 'Widget' })` used to yield ONE row: the new
 * object's `save()` upserted on `(slug, context)` with no tenant column, so
 * tenant B's insert matched tenant A's row and `DO UPDATE SET` rewrote its
 * `id` and `tenant_id`. Tenant A then saw nothing, and every reference it held
 * to the old id dangled.
 *
 * With #2360 the default conflict target of a tenant-scoped class is
 * `[tenant_id, ...natural key]` on both the schema and the upsert, so the
 * second create is a second row and tenant A keeps its id. Within a tenant the
 * natural key still dedups; global (NULL-tenant) rows dedup among themselves
 * through the SDK's null-aware upsert.
 *
 * Uses the real `@TenantScoped()` decorator, `enableTenancy()` interceptor and
 * `withTenant()` context — the exact stack the assessment probed.
 */

import {
  field,
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { withTenant } from '../context.js';
import { TenantScoped, tenantId } from '../decorators.js';
import { disableTenancy, enableTenancy } from '../interceptor.js';

const TENANT_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

@smrt({ tableName: 'issue_2360_widgets' })
@TenantScoped({ mode: 'optional' })
class Issue2360Widget extends SmrtObject {
  @field({ type: 'text', required: true })
  name = '';

  @tenantId({ nullable: true })
  tenantId: string | null = null;

  constructor(options: any = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
  }
}

class Issue2360WidgetCollection extends SmrtCollection<Issue2360Widget> {
  static readonly _itemClass = Issue2360Widget;
}

@smrt({ tableName: 'issue_2360_things', tableStrategy: 'sti' })
@TenantScoped({ mode: 'optional' })
class Issue2360Thing extends SmrtObject {
  @field({ type: 'text' })
  label = '';

  @tenantId({ nullable: true })
  tenantId: string | null = null;

  constructor(options: any = {}) {
    super(options);
    if (options.label !== undefined) this.label = options.label;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
  }
}

class Issue2360ThingCollection extends SmrtCollection<Issue2360Thing> {
  static readonly _itemClass = Issue2360Thing;
}

@smrt()
class Issue2360Gadget extends Issue2360Thing {
  @field({ type: 'text' })
  power = '';

  constructor(options: any = {}) {
    super(options);
    if (options.power !== undefined) this.power = options.power;
  }
}

class Issue2360GadgetCollection extends SmrtCollection<Issue2360Gadget> {
  static readonly _itemClass = Issue2360Gadget;
}

describe('tenant-aware natural keys with the real interceptor (#2360)', () => {
  let db: Awaited<ReturnType<typeof getTestDatabase>>;
  let widgets: Issue2360WidgetCollection;
  let things: Issue2360ThingCollection;
  let gadgets: Issue2360GadgetCollection;

  beforeAll(async () => {
    ObjectRegistry.registerCollection(
      'Issue2360Widget',
      Issue2360WidgetCollection,
    );
    ObjectRegistry.registerCollection(
      'Issue2360Thing',
      Issue2360ThingCollection,
    );
    ObjectRegistry.registerCollection(
      'Issue2360Gadget',
      Issue2360GadgetCollection,
    );
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['Issue2360Widget', 'Issue2360Thing', 'Issue2360Gadget'],
    });
    widgets = await Issue2360WidgetCollection.create({ db });
    things = await Issue2360ThingCollection.create({ db });
    gadgets = await Issue2360GadgetCollection.create({ db });
    enableTenancy();
  });

  afterAll(async () => {
    disableTenancy();
    await db?.close?.();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM issue_2360_widgets');
    await db.query('DELETE FROM issue_2360_things');
  });

  it('keys the schema and the upsert on (tenant_id, slug, context)', () => {
    expect(ObjectRegistry.getConflictColumns('Issue2360Widget')).toEqual([
      'tenant_id',
      'slug',
      'context',
    ]);
    const conflict = ObjectRegistry.getSchema('Issue2360Widget')?.indexes.find(
      (index) => index.name === 'issue_2360_widgets_slug_context_idx',
    );
    expect(conflict?.unique).toBe(true);
    expect(conflict?.columns).toEqual(['tenant_id', 'slug', 'context']);
  });

  it('B1 probe: tenant B creating "Widget" after tenant A yields a second row and tenant A keeps its id', async () => {
    const a = await withTenant({ tenantId: TENANT_A }, () =>
      widgets.create({ name: 'Widget' }),
    );
    const b = await withTenant({ tenantId: TENANT_B }, () =>
      widgets.create({ name: 'Widget' }),
    );

    expect(a.tenantId).toBe(TENANT_A);
    expect(b.tenantId).toBe(TENANT_B);
    expect(a.slug).toBe('widget');
    expect(b.slug).toBe('widget');
    expect(b.id).not.toBe(a.id);

    const rows = (await db.list('issue_2360_widgets', {})) as Array<
      Record<string, unknown>
    >;
    expect(rows).toHaveLength(2);

    // Tenant A still sees its own row, under its original id.
    const seenByA = await withTenant({ tenantId: TENANT_A }, () =>
      widgets.list({}),
    );
    expect(seenByA.map((row) => row.id)).toEqual([a.id]);
    const seenByB = await withTenant({ tenantId: TENANT_B }, () =>
      widgets.list({}),
    );
    expect(seenByB.map((row) => row.id)).toEqual([b.id]);
  });

  it('within one tenant the natural key still dedups (ingestion-style upsert, #1472)', async () => {
    const first = await withTenant({ tenantId: TENANT_A }, () =>
      widgets.create({ name: 'Widget' }),
    );
    const again = await withTenant({ tenantId: TENANT_A }, () =>
      widgets.create({ name: 'Widget' }),
    );
    expect(again.slug).toBe(first.slug);
    // One row for tenant A: the second create took the UPDATE branch of the
    // upsert (the SDK's `DO UPDATE SET` rewrites every column of the adopted
    // row, `id` included — the pre-existing same-tenant dedup contract).
    const rows = (await db.list('issue_2360_widgets', {})) as Array<
      Record<string, unknown>
    >;
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_id).toBe(TENANT_A);
    expect(rows[0].slug).toBe('widget');
  });

  it('global (NULL-tenant) rows dedup among themselves and never collide with a tenant row', async () => {
    await withTenant({ tenantId: TENANT_A }, () =>
      widgets.create({ name: 'Widget' }),
    );
    const g1 = await widgets.create({ name: 'Widget' });
    const g2 = await widgets.create({ name: 'Widget' });
    expect(g1.tenantId).toBeNull();
    expect(g2.slug).toBe(g1.slug);

    const rows = (await db.list('issue_2360_widgets', {})) as Array<
      Record<string, unknown>
    >;
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.tenant_id == null)).toHaveLength(1);
  });

  it('STI: root and child rows are per tenant on the shared table', async () => {
    const thingA = await withTenant({ tenantId: TENANT_A }, () =>
      things.create({ label: 'Rotor', slug: 'rotor' }),
    );
    const thingB = await withTenant({ tenantId: TENANT_B }, () =>
      things.create({ label: 'Rotor', slug: 'rotor' }),
    );
    const gadgetA = await withTenant({ tenantId: TENANT_A }, () =>
      gadgets.create({ label: 'Rotor', slug: 'rotor', power: 'high' }),
    );
    const gadgetB = await withTenant({ tenantId: TENANT_B }, () =>
      gadgets.create({ label: 'Rotor', slug: 'rotor', power: 'low' }),
    );

    expect(new Set([thingA.id, thingB.id, gadgetA.id, gadgetB.id]).size).toBe(
      4,
    );
    expect(await db.list('issue_2360_things', {})).toHaveLength(4);

    const gadgetsSeenByA = await withTenant({ tenantId: TENANT_A }, () =>
      gadgets.list({}),
    );
    expect(gadgetsSeenByA.map((row) => row.id)).toEqual([gadgetA.id]);
  });
});
