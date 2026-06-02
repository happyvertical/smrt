/**
 * Tests for the new Contract STI subtypes (WholesaleOrder, ProductionOrder,
 * Cart) and the Contract.channelId + Customer.customerType additions.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContractCollection } from '../collections/ContractCollection.js';
import { CustomerCollection } from '../collections/CustomerCollection.js';
import {
  Cart,
  Contract,
  ProductionOrder,
  WholesaleOrder,
} from '../models/Contract.js';
import { ContractType, CustomerType } from '../types/index.js';

describe('Contract STI extensions', () => {
  let dbPath: string;
  let contracts: ContractCollection;
  let customers: CustomerCollection;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-contract-extensions-${Date.now()}.db`);
    contracts = await ContractCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    customers = await CustomerCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
  });

  afterEach(() => {
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  describe('STI discriminator', () => {
    it.each([
      [
        WholesaleOrder,
        '@happyvertical/smrt-commerce:WholesaleOrder',
        ContractType.WHOLESALE_ORDER,
      ],
      [
        ProductionOrder,
        '@happyvertical/smrt-commerce:ProductionOrder',
        ContractType.PRODUCTION_ORDER,
      ],
      [Cart, '@happyvertical/smrt-commerce:Cart', ContractType.CART],
    ])('stamps %s with the right _meta_type and contractType', async (cls, expectedType, typeValue) => {
      const instance = new (cls as any)({});
      await instance.initialize();
      expect(instance.toJSON()._meta_type).toBe(expectedType);
      expect(instance.contractType).toBe(typeValue);
    });

    it.each([
      ['WholesaleOrder'],
      ['ProductionOrder'],
      ['Cart'],
    ])('resolves Contract as STI base for %s', (name) => {
      // R5-canon: getSTIBase returns qualified names.
      expect(ObjectRegistry.getSTIBase(name)).toBe(
        '@happyvertical/smrt-commerce:Contract',
      );
    });
  });

  describe('Persistence and findByType', () => {
    it('persists and retrieves a WholesaleOrder via findByType', async () => {
      const customer = await customers.create({
        profileId: 'wholesale-buyer',
        customerType: CustomerType.WHOLESALE,
        paymentTerms: 'Net 30',
      });
      await customer.save();

      const order = new WholesaleOrder({
        customerId: customer.id!,
        totalAmount: 5000,
        currency: 'USD',
        channelId: 'wholesale-b2b',
        db: { type: 'sqlite', url: dbPath },
      });
      await order.initialize();
      await order.save();

      const wholesale = await contracts.findByType(
        ContractType.WHOLESALE_ORDER,
      );
      expect(wholesale).toHaveLength(1);
      expect(wholesale[0]).toBeInstanceOf(WholesaleOrder);
      expect(wholesale[0].channelId).toBe('wholesale-b2b');
    });

    it('persists a ProductionOrder and round-trips channelId', async () => {
      const po = new ProductionOrder({
        vendorId: 'factory-1',
        totalAmount: 12000,
        channelId: 'production',
        reference: 'PO-CUT-2026-001',
        db: { type: 'sqlite', url: dbPath },
      });
      await po.initialize();
      await po.save();

      const loaded = await contracts.get({ id: po.id! });
      expect(loaded).toBeInstanceOf(ProductionOrder);
      expect(loaded?.channelId).toBe('production');
      expect(loaded?.reference).toBe('PO-CUT-2026-001');
    });

    it('persists ProductionOrder.productId and bomId so manufacturing can resolve them', async () => {
      // Regression for the round-12 finding: ProductionService.consumeMaterials
      // reads `productId` and `bomId` from a loaded ProductionOrder. Both
      // fields are declared as `Meta<string>` on the subtype so they ride
      // the shared `_meta_data` JSON column on the Contract STI table.
      // Without these fields, a reloaded production order would arrive at
      // the manufacturing service with no way to resolve which BOM to walk.
      const po = new ProductionOrder({
        vendorId: 'factory-1',
        totalAmount: 5000,
        productId: 'style-ST-1001',
        bomId: 'bom-revision-7',
        db: { type: 'sqlite', url: dbPath },
      });
      await po.initialize();
      await po.save();

      const loaded = (await contracts.get({ id: po.id! })) as ProductionOrder;
      expect(loaded).toBeInstanceOf(ProductionOrder);
      expect(loaded.productId).toBe('style-ST-1001');
      expect(loaded.bomId).toBe('bom-revision-7');
    });

    it('persists a Cart and round-trips it', async () => {
      const cart = new Cart({
        customerId: 'cust-guest-123',
        subtotal: 199.99,
        totalAmount: 199.99,
        channelId: 'dtc-web',
        db: { type: 'sqlite', url: dbPath },
      });
      await cart.initialize();
      await cart.save();

      const carts = await contracts.findByType(ContractType.CART);
      expect(carts).toHaveLength(1);
      expect(carts[0]).toBeInstanceOf(Cart);
      expect(carts[0].channelId).toBe('dtc-web');
    });

    it('keeps STI subtypes isolated when querying by contractType', async () => {
      const wo = new WholesaleOrder({
        customerId: 'c1',
        db: { type: 'sqlite', url: dbPath },
      });
      await wo.initialize();
      await wo.save();

      const po = new ProductionOrder({
        vendorId: 'v1',
        db: { type: 'sqlite', url: dbPath },
      });
      await po.initialize();
      await po.save();

      const cart = new Cart({
        customerId: 'c2',
        db: { type: 'sqlite', url: dbPath },
      });
      await cart.initialize();
      await cart.save();

      expect(
        await contracts.findByType(ContractType.WHOLESALE_ORDER),
      ).toHaveLength(1);
      expect(
        await contracts.findByType(ContractType.PRODUCTION_ORDER),
      ).toHaveLength(1);
      expect(await contracts.findByType(ContractType.CART)).toHaveLength(1);
    });
  });

  describe('STI subtype tenancy', () => {
    it('auto-populates tenantId on every STI subtype save', async () => {
      // Regression for the round-8 finding: @TenantScoped registers per
      // concrete className. Cart / Order / WholesaleOrder /
      // ProductionOrder etc. inheriting from a tenant-scoped Contract
      // were NOT automatically tenant-scoped themselves; the dispatch
      // tenant interceptor missed the lookup and `tenantId` stayed null
      // on save. Repeating the decorator on every subtype fixes it.
      // Import here to keep the top-of-file import surface stable.
      const { enableTenancy, disableTenancy, withTenant } = await import(
        '@happyvertical/smrt-tenancy'
      );
      try {
        enableTenancy();
        const customer = await customers.create({ profileId: 'p-tenancy' });
        await customer.save();

        const captured: Array<{ kind: string; tenantId: string | null }> = [];
        await withTenant({ tenantId: 'tenant-a' }, async () => {
          for (const kind of [
            'WholesaleOrder',
            'ProductionOrder',
            'Cart',
            'Order',
            'Estimate',
          ] as const) {
            const c = await contracts.create({
              _meta_type: `@happyvertical/smrt-commerce:${kind}`,
              customerId: customer.id!,
              totalAmount: 1,
            });
            await c.save();
            captured.push({ kind, tenantId: c.tenantId });
          }
        });
        for (const row of captured) {
          expect(row.tenantId, `tenantId for ${row.kind}`).toBe('tenant-a');
        }
      } finally {
        disableTenancy();
      }
    });
  });

  describe('Contract.channelId', () => {
    it('defaults to empty string for backwards compatibility', async () => {
      const customer = await customers.create({ profileId: 'p1' });
      await customer.save();

      const contract = await contracts.create({
        customerId: customer.id!,
        totalAmount: 100,
      });
      expect(contract.channelId).toBe('');

      await contract.save();
      const loaded = await contracts.get({ id: contract.id! });
      expect(loaded?.channelId).toBe('');
    });

    it('round-trips a non-empty channelId on the base Contract', async () => {
      const customer = await customers.create({ profileId: 'p2' });
      await customer.save();

      const contract = await contracts.create({
        customerId: customer.id!,
        totalAmount: 250,
        channelId: 'pos-store-3',
      });
      await contract.save();
      const loaded = await contracts.get({ id: contract.id! });
      expect(loaded?.channelId).toBe('pos-store-3');
    });
  });
});

describe('Customer.customerType', () => {
  let dbPath: string;
  let customers: CustomerCollection;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-customer-type-${Date.now()}.db`);
    customers = await CustomerCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
  });

  afterEach(() => {
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  it('defaults customerType to DTC for backwards compatibility', async () => {
    const customer = await customers.create({ profileId: 'p1' });
    await customer.save();

    const loaded = await customers.get({ id: customer.id! });
    expect(loaded?.customerType).toBe(CustomerType.DTC);
    expect(loaded?.isWholesale()).toBe(false);
  });

  it('round-trips an explicit WHOLESALE customerType', async () => {
    const customer = await customers.create({
      profileId: 'p2',
      customerType: CustomerType.WHOLESALE,
      paymentTerms: 'Net 30',
    });
    await customer.save();

    const loaded = await customers.get({ id: customer.id! });
    expect(loaded?.customerType).toBe(CustomerType.WHOLESALE);
    expect(loaded?.isWholesale()).toBe(true);
  });

  it('round-trips a RETAIL customerType', async () => {
    const customer = await customers.create({
      profileId: 'p3',
      customerType: CustomerType.RETAIL,
    });
    await customer.save();

    const loaded = await customers.get({ id: customer.id! });
    expect(loaded?.customerType).toBe(CustomerType.RETAIL);
  });
});
