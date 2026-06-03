/**
 * Issue #1321 (R8): tenant-isolation guard on loadRelated / loadRelatedMany.
 *
 * `loadRelated()` fetches a relationship target by id with NO tenant filtering,
 * which silently leaks another tenant's data across a foreign key. This guard
 * throws a `TenantIsolationError` ONLY in the genuine-leak case — when the
 * owning object and the loaded target both carry a non-null `tenantId` that
 * differ — so global/null-tenant models and same-tenant loads are unaffected.
 * Callers can opt out of deliberate cross-tenant flows with
 * `{ allowCrossTenant: true }`.
 *
 * @see https://github.com/happyvertical/smrt/issues/1321
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TenantIsolationError } from '../errors';
import {
  field,
  foreignKey,
  manyToMany,
  oneToMany,
  SmrtObject,
  smrt,
} from '../index.js';
import { ObjectRegistry } from '../registry';
import { getTestDatabase } from '../testing/database';

// Owning side — a tenant-scoped "Customer" with many orders.
// `tenantId` needs an explicit type because the framework cannot infer a
// column type from a `null` initializer.
@smrt()
class IsoCustomer extends SmrtObject {
  @field({ type: 'text', nullable: true })
  tenantId: string | null = null;
  name: string = '';

  @oneToMany('IsoOrder')
  orders: IsoOrder[] = [];

  constructor(options: any = {}) {
    super(options);
    if (options.name) this.name = options.name;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
  }
}

// Related side — a tenant-scoped "Order" with a foreignKey back to Customer.
@smrt()
class IsoOrder extends SmrtObject {
  @field({ type: 'text', nullable: true })
  tenantId: string | null = null;

  @foreignKey('IsoCustomer')
  customerId: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.customerId) this.customerId = options.customerId;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
  }
}

// manyToMany fixtures — a tenant-scoped "Product" linked to "Tag"s through a
// plain junction table (consumer-owned, no SmrtObject backing).
@smrt()
class IsoTag extends SmrtObject {
  @field({ type: 'text', nullable: true })
  tenantId: string | null = null;
  label: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.label) this.label = options.label;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
  }
}

@smrt()
class IsoProduct extends SmrtObject {
  @field({ type: 'text', nullable: true })
  tenantId: string | null = null;

  @manyToMany(IsoTag, { through: 'iso_product_tags' })
  tags: IsoTag[] = [];

  constructor(options: any = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
  }
}

describe('Issue #1321: tenant isolation on relationship loading', () => {
  let db: DatabaseInterface;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `test-tenant-iso-${randomUUID().slice(0, 8)}.db`);
    db = await getTestDatabase({ type: 'sqlite', url: dbPath });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  async function makeCustomer(tenantId: string | null): Promise<IsoCustomer> {
    const customer = new IsoCustomer({ name: 'Acme', tenantId, db });
    await customer.initialize();
    await customer.save();
    return customer;
  }

  async function makeOrder(
    tenantId: string | null,
    customerId: string,
  ): Promise<IsoOrder> {
    const order = new IsoOrder({ tenantId, customerId, db });
    await order.initialize();
    await order.save();
    return order;
  }

  async function ensureJunctionTable(): Promise<void> {
    await db.query(
      `CREATE TABLE IF NOT EXISTS iso_product_tags (
        iso_product_id TEXT NOT NULL,
        iso_tag_id TEXT NOT NULL,
        PRIMARY KEY (iso_product_id, iso_tag_id)
      )`,
    );
  }

  async function makeProduct(tenantId: string | null): Promise<IsoProduct> {
    const product = new IsoProduct({ tenantId, db });
    await product.initialize();
    await product.save();
    return product;
  }

  async function makeTag(
    tenantId: string | null,
    label: string,
  ): Promise<IsoTag> {
    const tag = new IsoTag({ tenantId, label, db });
    await tag.initialize();
    await tag.save();
    return tag;
  }

  async function linkProductTag(
    product: IsoProduct,
    tag: IsoTag,
  ): Promise<void> {
    await db.query(
      'INSERT INTO iso_product_tags (iso_product_id, iso_tag_id) VALUES (?, ?)',
      [product.id, tag.id],
    );
  }

  describe('loadRelated (foreignKey)', () => {
    it('resolves a same-tenant relationship without throwing', async () => {
      const customer = await makeCustomer('tenant-a');
      const order = await makeOrder('tenant-a', customer.id);

      const loaded = await order.loadRelated('customerId');

      expect(loaded).not.toBeNull();
      expect(loaded.id).toBe(customer.id);
    });

    it('is a no-op when the target has a null tenant (global model)', async () => {
      const customer = await makeCustomer(null);
      const order = await makeOrder('tenant-a', customer.id);

      const loaded = await order.loadRelated('customerId');

      expect(loaded.id).toBe(customer.id);
    });

    it('is a no-op when the owning object has a null tenant', async () => {
      const customer = await makeCustomer('tenant-b');
      const order = await makeOrder(null, customer.id);

      const loaded = await order.loadRelated('customerId');

      expect(loaded.id).toBe(customer.id);
    });

    it('throws TenantIsolationError on a genuine cross-tenant load', async () => {
      const customer = await makeCustomer('tenant-b');
      const order = await makeOrder('tenant-a', customer.id);

      await expect(order.loadRelated('customerId')).rejects.toThrow(
        TenantIsolationError,
      );
    });

    it('surfaces the owning and attempted tenants on the error', async () => {
      const customer = await makeCustomer('tenant-b');
      const order = await makeOrder('tenant-a', customer.id);

      await expect(order.loadRelated('customerId')).rejects.toMatchObject({
        code: 'TENANT_ISOLATION_VIOLATION',
        tenantId: 'tenant-a',
        attemptedTenantId: 'tenant-b',
      });
    });

    it('bypasses the guard with { allowCrossTenant: true }', async () => {
      const customer = await makeCustomer('tenant-b');
      const order = await makeOrder('tenant-a', customer.id);

      const loaded = await order.loadRelated('customerId', {
        allowCrossTenant: true,
      });

      expect(loaded.id).toBe(customer.id);
    });

    it('does not cache a blocked cross-tenant target (re-throws on retry)', async () => {
      const customer = await makeCustomer('tenant-b');
      const order = await makeOrder('tenant-a', customer.id);

      await expect(order.loadRelated('customerId')).rejects.toThrow(
        TenantIsolationError,
      );
      // A second attempt must still throw — the leak was never cached.
      await expect(order.loadRelated('customerId')).rejects.toThrow(
        TenantIsolationError,
      );
    });

    it('re-validates a prior allowCrossTenant load on a later guarded call', async () => {
      const customer = await makeCustomer('tenant-b');
      const order = await makeOrder('tenant-a', customer.id);

      // First load opts into the cross-tenant target (and caches it)...
      const allowed = await order.loadRelated('customerId', {
        allowCrossTenant: true,
      });
      expect(allowed.id).toBe(customer.id);

      // ...but a later call WITHOUT the opt-in must still be blocked.
      await expect(order.loadRelated('customerId')).rejects.toThrow(
        TenantIsolationError,
      );
    });

    it('blocks a cross-tenant target cached by an eager include load', async () => {
      const customer = await makeCustomer('tenant-b');
      await makeOrder('tenant-a', customer.id);

      // Eager `include` populates _loadedRelationships directly, bypassing the
      // lazy loader. A later guarded read must NOT leak that cross-tenant target.
      const orders = await ObjectRegistry.getCollection<IsoOrder>('IsoOrder', {
        db,
      });
      const [loadedOrder] = (await orders.list({
        include: ['customerId'],
      })) as IsoOrder[];

      await expect(loadedOrder.loadRelated('customerId')).rejects.toThrow(
        TenantIsolationError,
      );
      await expect(loadedOrder.getRelated('customerId')).rejects.toThrow(
        TenantIsolationError,
      );
      // The deliberate opt-in still works against the eager-populated cache.
      const allowed = await loadedOrder.loadRelated('customerId', {
        allowCrossTenant: true,
      });
      expect(allowed.id).toBe(customer.id);
    });
  });

  describe('loadRelatedMany (manyToMany)', () => {
    beforeEach(async () => {
      await ensureJunctionTable();
    });

    it('returns same-tenant linked targets without throwing', async () => {
      const product = await makeProduct('tenant-a');
      const tag = await makeTag('tenant-a', 'Featured');
      await linkProductTag(product, tag);

      const tags = (await product.loadRelatedMany('tags')) as IsoTag[];

      expect(tags).toHaveLength(1);
      expect(tags[0].id).toBe(tag.id);
    });

    it('is a no-op when a linked target has a null tenant (global)', async () => {
      const product = await makeProduct('tenant-a');
      const tag = await makeTag(null, 'Global');
      await linkProductTag(product, tag);

      const tags = (await product.loadRelatedMany('tags')) as IsoTag[];

      expect(tags).toHaveLength(1);
    });

    it('throws TenantIsolationError on a cross-tenant linked target', async () => {
      const product = await makeProduct('tenant-a');
      const tag = await makeTag('tenant-b', 'Leaked');
      await linkProductTag(product, tag);

      await expect(product.loadRelatedMany('tags')).rejects.toThrow(
        TenantIsolationError,
      );
    });

    it('bypasses the per-item guard with { allowCrossTenant: true }', async () => {
      const product = await makeProduct('tenant-a');
      const tag = await makeTag('tenant-b', 'Leaked');
      await linkProductTag(product, tag);

      const tags = (await product.loadRelatedMany('tags', {
        allowCrossTenant: true,
      })) as IsoTag[];

      expect(tags).toHaveLength(1);
    });
  });

  describe('loadRelatedMany (oneToMany)', () => {
    it('returns same-tenant children without throwing', async () => {
      const customer = await makeCustomer('tenant-a');
      await makeOrder('tenant-a', customer.id);
      await makeOrder('tenant-a', customer.id);

      const orders = (await customer.loadRelatedMany('orders')) as IsoOrder[];

      expect(orders).toHaveLength(2);
    });

    it('throws TenantIsolationError when any child is cross-tenant', async () => {
      const customer = await makeCustomer('tenant-a');
      await makeOrder('tenant-a', customer.id);
      await makeOrder('tenant-b', customer.id); // leaked child

      await expect(customer.loadRelatedMany('orders')).rejects.toThrow(
        TenantIsolationError,
      );
    });

    it('bypasses per-item guard with { allowCrossTenant: true }', async () => {
      const customer = await makeCustomer('tenant-a');
      await makeOrder('tenant-a', customer.id);
      await makeOrder('tenant-b', customer.id);

      const orders = (await customer.loadRelatedMany('orders', {
        allowCrossTenant: true,
      })) as IsoOrder[];

      expect(orders).toHaveLength(2);
    });
  });
});
