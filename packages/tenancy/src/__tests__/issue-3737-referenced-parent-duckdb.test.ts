/**
 * #3737 with the real tenancy stack: toggling a tenant-owned parent that a
 * child row references, on native DuckDB.
 *
 * DuckDB rewrites a row whose indexed column is assigned, even to its current
 * value, and refuses that for a referenced parent. `slug`, `context`,
 * `tenant_id` and `created_at` are all indexed on a tenant-scoped table, so a
 * toggle of a plain field used to fail. The write must now leave the unchanged
 * indexed columns out while the tenant interceptor still guards the save: a
 * cross-tenant write, or a tenant change, is refused before anything is written.
 */

import {
  field,
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../context.js';
import { TenantScoped, tenantId } from '../decorators.js';
import { disableTenancy, enableTenancy } from '../interceptor.js';

const TENANT_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

@smrt({ tableName: 'issue_3737_subscriptions' })
@TenantScoped({ mode: 'required' })
class Issue3737Subscription extends SmrtObject {
  @tenantId()
  tenantId = '';

  @field({ type: 'text' })
  url = '';

  @field({ type: 'boolean', default: true })
  enabled = true;
}

class Issue3737Subscriptions extends SmrtCollection<Issue3737Subscription> {
  static readonly _itemClass = Issue3737Subscription;
}

describe('tenant-owned referenced parent on DuckDB (#3737)', () => {
  let db: Awaited<ReturnType<typeof getTestDatabase>>;
  let subscriptions: Issue3737Subscriptions;
  let id: string;

  beforeAll(async () => {
    ObjectRegistry.registerCollection(
      'Issue3737Subscription',
      Issue3737Subscriptions,
    );
    db = await getTestDatabase({
      type: 'duckdb',
      url: ':memory:',
      classes: ['Issue3737Subscription'],
    });
    await db.query(
      'CREATE TABLE issue_3737_deliveries (id UUID PRIMARY KEY, subscription_id UUID REFERENCES issue_3737_subscriptions(id))',
    );
    subscriptions = await Issue3737Subscriptions.create({ db });
    enableTenancy();
    const created = await withTenant({ tenantId: TENANT_A }, () =>
      subscriptions.create({ url: 'https://partner.example/hook' }),
    );
    id = created.id as string;
    await db.insert('issue_3737_deliveries', {
      id: crypto.randomUUID(),
      subscription_id: id,
    });
  });

  afterAll(async () => {
    disableTenancy();
    await db?.close?.();
  });

  const inTenantA = <T>(work: () => Promise<T>) =>
    withTenant({ tenantId: TENANT_A }, work);

  it('toggles the subscription of its own tenant', async () => {
    await inTenantA(async () => {
      const loaded = await subscriptions.get(id);
      expect(loaded?.enabled).toBe(true);
      if (!loaded) throw new Error('expected the subscription');
      loaded.enabled = false;
      await loaded.save();
    });

    const after = await inTenantA(() => subscriptions.get(id));
    expect(after?.enabled).toBe(false);
    expect(after?.tenantId).toBe(TENANT_A);
    expect(after?.slug).toBeTruthy();
    const deliveries = await db.query(
      'SELECT COUNT(*) AS n FROM issue_3737_deliveries',
    );
    expect(Number(deliveries.rows[0].n)).toBe(1);
  });

  it('hides the row from another tenant', async () => {
    const seen = await withTenant({ tenantId: TENANT_B }, () =>
      subscriptions.get(id),
    );
    expect(seen).toBeNull();
  });

  it('refuses a write made under another tenant, leaving the row untouched', async () => {
    const loaded = await inTenantA(() => subscriptions.get(id));
    if (!loaded) throw new Error('expected the subscription');
    loaded.enabled = true;

    await expect(
      withTenant({ tenantId: TENANT_B }, () => loaded.save()),
    ).rejects.toMatchObject({ code: 'TENANT_ISOLATION_VIOLATION' });

    expect((await inTenantA(() => subscriptions.get(id)))?.enabled).toBe(false);
  });

  it('refuses a tenant change, leaving the row untouched', async () => {
    const loaded = await inTenantA(() => subscriptions.get(id));
    if (!loaded) throw new Error('expected the subscription');
    loaded.tenantId = TENANT_B;

    await expect(inTenantA(() => loaded.save())).rejects.toMatchObject({
      code: 'TENANT_ISOLATION_VIOLATION',
    });

    const after = await inTenantA(() => subscriptions.get(id));
    expect(after?.tenantId).toBe(TENANT_A);
    expect(after?.enabled).toBe(false);
  });
});
