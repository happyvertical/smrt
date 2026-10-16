import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObjectRegistry, smrt } from '@happyvertical/smrt-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContractCollection } from '../collections/ContractCollection.js';
import { CustomerCollection } from '../collections/CustomerCollection.js';
import { PurchaseContractCollection } from '../collections/PurchaseContractCollection.js';
import { SalesContractCollection } from '../collections/SalesContractCollection.js';
import { VendorCollection } from '../collections/VendorCollection.js';
import { preflightCommercePartyLinks } from '../migrations/partyLinks.js';
import {
  Cart,
  Contract,
  Estimate,
  Order,
  ProductionOrder,
  PurchaseOrder,
  SupplierQuote,
} from '../models/Contract.js';
import { Fulfillment } from '../models/Fulfillment.js';
import { Invoice } from '../models/Invoice.js';
import { Payment } from '../models/Payment.js';

async function save<T extends Contract>(object: T): Promise<T> {
  await object.initialize();
  return object.save();
}

@smrt()
class SpecialOrder extends Order {}

@smrt()
class SpecialPurchaseOrder extends PurchaseOrder {}

describe('Contract party branches', () => {
  let dbUrl: string;
  let contracts: ContractCollection;

  it('emits only applicable party edges and leaf required rules', () => {
    const manifest = JSON.parse(
      readFileSync(join(process.cwd(), '.smrt/manifest.json'), 'utf8'),
    );
    const model = (name: string) =>
      manifest.objects[`@happyvertical/smrt-commerce:${name}`];
    expect(model('Contract').fields.customerId).toBeUndefined();
    expect(model('Contract').fields.vendorId).toBeUndefined();
    for (const name of [
      'Estimate',
      'Order',
      'WholesaleOrder',
      'Cart',
      'Lease',
      'Agreement',
      'LicenseSale',
    ]) {
      expect(model(name).fields.customerId?.type).toBe('foreignKey');
      expect(model(name).fields.vendorId).toBeUndefined();
      expect(model(name).fields.customerId.required).toBe(
        !['Cart', 'LicenseSale'].includes(name),
      );
    }
    for (const name of ['SupplierQuote', 'PurchaseOrder', 'ProductionOrder']) {
      expect(model(name).fields.vendorId?.type).toBe('foreignKey');
      expect(model(name).fields.customerId).toBeUndefined();
      expect(model(name).fields.vendorId.required).toBe(
        name !== 'ProductionOrder',
      );
    }
    for (const name of ['Invoice', 'Payment', 'Fulfillment']) {
      expect(model(name).fields.contractId.related).toBe('SalesContract');
      expect(model(name).fields.contractId._meta.validateSubtype).toBe(true);
    }
    expect(model('ContractLineItem').fields.contractId.related).toBe(
      'Contract',
    );
  });

  beforeEach(async () => {
    dbUrl = join(tmpdir(), `smrt-party-links-${randomUUID()}.db`);
    contracts = await ContractCollection.create({
      db: { type: 'sqlite', url: dbUrl },
    });
    const customers = await CustomerCollection.create({ db: contracts.db });
    const vendors = await VendorCollection.create({ db: contracts.db });
    await customers.create({ id: 'customer-a', name: 'Customer A' });
    await vendors.create({ id: 'vendor-a', name: 'Vendor A' });
  });

  afterEach(async () => {
    await contracts?.db?.close?.();
    for (const file of [
      dbUrl,
      `${dbUrl}-wal`,
      `${dbUrl}-shm`,
      `${dbUrl}-journal`,
    ]) {
      rmSync(file, { force: true });
    }
  });

  it('isolates sales and purchase reads, including deprecated wrappers', async () => {
    const order = await save(
      new Order({
        db: contracts.db,
        customerId: 'customer-a',
      }),
    );
    const purchase = await save(
      new PurchaseOrder({
        db: contracts.db,
        vendorId: 'vendor-a',
      }),
    );
    const sales = await SalesContractCollection.create({ db: contracts.db });
    const purchases = await PurchaseContractCollection.create({
      db: contracts.db,
    });
    expect(
      (await sales.findByCustomer('customer-a')).map((row) => row.id),
    ).toEqual([order.id]);
    expect(
      (await purchases.findByVendor('vendor-a')).map((row) => row.id),
    ).toEqual([purchase.id]);
    expect(
      (await contracts.findByCustomer('customer-a')).map((row) => row.id),
    ).toEqual([order.id]);
    expect(
      (await contracts.findByVendor('vendor-a')).map((row) => row.id),
    ).toEqual([purchase.id]);
    expect(await sales.get({ id: purchase.id })).toBeNull();
    expect(await purchases.get({ id: order.id })).toBeNull();
  });

  it('reports legacy unqualified discriminators that branch reads cannot find', async () => {
    const order = await save(
      new Order({ db: contracts.db, customerId: 'customer-a' }),
    );
    const purchase = await save(
      new PurchaseOrder({ db: contracts.db, vendorId: 'vendor-a' }),
    );
    await contracts.db.query(
      "UPDATE contracts SET _meta_type = 'Order' WHERE id = ?",
      order.id,
    );
    await contracts.db.query(
      "UPDATE contracts SET _meta_type = 'PurchaseOrder' WHERE id = ?",
      purchase.id,
    );
    const sales = await SalesContractCollection.create({ db: contracts.db });
    const purchases = await PurchaseContractCollection.create({
      db: contracts.db,
    });
    expect(await sales.get({ id: order.id })).toBeNull();
    expect(await purchases.get({ id: purchase.id })).toBeNull();
    const report = await preflightCommercePartyLinks(contracts.db);
    expect(report.unqualifiedDiscriminatorRows.map((row) => row.id)).toEqual(
      expect.arrayContaining([order.id, purchase.id]),
    );
  });

  it('accepts registered custom descendants in linked document preflight', async () => {
    const order = await save(
      new Order({ db: contracts.db, customerId: 'customer-a' }),
    );
    const purchase = await save(
      new PurchaseOrder({ db: contracts.db, vendorId: 'vendor-a' }),
    );
    const invoice = new Invoice({
      db: contracts.db,
      customerId: 'customer-a',
      contractId: order.id,
      invoiceNumber: 'INV-CUSTOM-BRANCH',
    });
    await invoice.initialize();
    await invoice.save();
    await contracts.db.query(
      'CREATE TABLE expenses (id TEXT PRIMARY KEY, tenant_id TEXT, commitment_id TEXT)',
    );
    await contracts.db.query(
      'INSERT INTO expenses (id, commitment_id) VALUES (?, ?)',
      'expense-custom-branch',
      purchase.id,
    );
    const salesType =
      ObjectRegistry.getClassByConstructor(SpecialOrder)?.qualifiedName;
    const purchaseType =
      ObjectRegistry.getClassByConstructor(SpecialPurchaseOrder)?.qualifiedName;
    expect(salesType).toBeTruthy();
    expect(purchaseType).toBeTruthy();
    await contracts.db.query(
      'UPDATE contracts SET _meta_type = ? WHERE id = ?',
      salesType,
      order.id,
    );
    await contracts.db.query(
      'UPDATE contracts SET _meta_type = ? WHERE id = ?',
      purchaseType,
      purchase.id,
    );
    const report = await preflightCommercePartyLinks(contracts.db);
    expect(report.invalidSalesReferences).toEqual([]);
    expect(report.invalidPurchaseReferences).toEqual([]);
  });

  it('requires parties only on the specified leaves', async () => {
    await expect(save(new Order({ db: contracts.db }))).rejects.toThrow();
    await expect(save(new Estimate({ db: contracts.db }))).rejects.toThrow();
    await expect(
      save(new PurchaseOrder({ db: contracts.db })),
    ).rejects.toThrow();
    await expect(
      save(new SupplierQuote({ db: contracts.db })),
    ).rejects.toThrow();
    await expect(save(new Cart({ db: contracts.db }))).resolves.toBeDefined();
    await expect(
      save(new ProductionOrder({ db: contracts.db })),
    ).resolves.toBeDefined();
    const sales = await SalesContractCollection.create({ db: contracts.db });
    await expect(sales.create({})).rejects.toThrow('abstract model');
  });

  it('rejects purchase contracts in sales document references', async () => {
    const purchase = await save(
      new PurchaseOrder({ db: contracts.db, vendorId: 'vendor-a' }),
    );
    if (!purchase.id) throw new Error('expected saved purchase order ID');
    for (const document of [
      new Invoice({
        db: contracts.db,
        customerId: 'customer-a',
        contractId: purchase.id,
        invoiceNumber: 'INV-WRONG-BRANCH',
      }),
      new Payment({ db: contracts.db, contractId: purchase.id }),
      new Fulfillment({ db: contracts.db, contractId: purchase.id }),
    ]) {
      await document.initialize();
      await expect(document.save()).rejects.toMatchObject({
        code: 'VALIDATION_STI_REFERENCE_TYPE',
      });
    }
  });

  it('reports party contamination and discriminator drift without changing rows', async () => {
    const order = await save(
      new Order({
        db: contracts.db,
        customerId: 'customer-a',
      }),
    );
    const purchase = await save(
      new PurchaseOrder({
        db: contracts.db,
        vendorId: 'vendor-a',
      }),
    );
    const estimate = await save(
      new Estimate({
        db: contracts.db,
        customerId: 'customer-a',
      }),
    );
    const base = await save(new Contract({ db: contracts.db }));
    const cart = await save(new Cart({ db: contracts.db }));
    const production = await save(new ProductionOrder({ db: contracts.db }));
    await contracts.db.query(
      'UPDATE contracts SET vendor_id = ? WHERE id = ?',
      'vendor-a',
      order.id,
    );
    await contracts.db.query(
      'UPDATE contracts SET customer_id = ? WHERE id = ?',
      'customer-a',
      purchase.id,
    );
    await contracts.db.query(
      "UPDATE contracts SET customer_id = NULL, contract_type = 'order' WHERE id = ?",
      estimate.id,
    );
    await contracts.db.query(
      "UPDATE contracts SET customer_id = NULL, contract_type = 'cart' WHERE id = ?",
      order.id,
    );
    await contracts.db.query(
      "UPDATE contracts SET contract_type = 'order' WHERE id = ?",
      cart.id,
    );
    await contracts.db.query(
      "UPDATE contracts SET vendor_id = NULL, contract_type = 'production_order' WHERE id = ?",
      purchase.id,
    );
    await contracts.db.query(
      "UPDATE contracts SET contract_type = 'purchase_order' WHERE id = ?",
      production.id,
    );
    const before = await contracts.db.query(
      'SELECT COUNT(*) AS n FROM contracts',
    );
    const report = await preflightCommercePartyLinks(contracts.db);
    const after = await contracts.db.query(
      'SELECT COUNT(*) AS n FROM contracts',
    );
    expect(report.salesRowsWithVendor.map((row) => row.id)).toContain(order.id);
    expect(report.purchaseRowsWithCustomer.map((row) => row.id)).toContain(
      purchase.id,
    );
    expect(report.missingRequiredCustomer.map((row) => row.id)).toContain(
      estimate.id,
    );
    expect(report.missingRequiredCustomer.map((row) => row.id)).toContain(
      order.id,
    );
    expect(report.missingRequiredCustomer.map((row) => row.id)).not.toContain(
      cart.id,
    );
    expect(report.missingRequiredVendor.map((row) => row.id)).toContain(
      purchase.id,
    );
    expect(report.missingRequiredVendor.map((row) => row.id)).not.toContain(
      production.id,
    );
    expect(report.baseTypedRows.map((row) => row.id)).toContain(base.id);
    expect(
      report.discriminatorMismatches.some((row) =>
        row._meta_type?.endsWith(':Estimate'),
      ),
    ).toBe(true);
    expect(after.rows).toEqual(before.rows);
  });

  it('reports existing documents linked to base or wrong-branch contracts', async () => {
    const order = await save(
      new Order({ db: contracts.db, customerId: 'customer-a' }),
    );
    const purchase = await save(
      new PurchaseOrder({ db: contracts.db, vendorId: 'vendor-a' }),
    );
    const base = await save(new Contract({ db: contracts.db }));
    const invoice = new Invoice({
      db: contracts.db,
      customerId: 'customer-a',
      contractId: order.id,
      invoiceNumber: 'INV-PREFLIGHT',
    });
    const payment = new Payment({ db: contracts.db, contractId: order.id });
    const fulfillment = new Fulfillment({
      db: contracts.db,
      contractId: order.id,
    });
    for (const document of [invoice, payment, fulfillment]) {
      await document.initialize();
      await document.save();
    }
    await contracts.db.query(
      'CREATE TABLE expenses (id TEXT PRIMARY KEY, tenant_id TEXT, commitment_id TEXT)',
    );
    await contracts.db.query(
      'CREATE TABLE ad_groups (id TEXT PRIMARY KEY, tenant_id TEXT, contract_id TEXT)',
    );
    await contracts.db.query(
      'UPDATE invoices SET contract_id = ? WHERE id = ?',
      base.id,
      invoice.id,
    );
    await contracts.db.query(
      'UPDATE payments SET contract_id = ? WHERE id = ?',
      purchase.id,
      payment.id,
    );
    await contracts.db.query(
      'UPDATE fulfillments SET contract_id = ? WHERE id = ?',
      base.id,
      fulfillment.id,
    );
    await contracts.db.query(
      'INSERT INTO expenses (id, commitment_id) VALUES (?, ?), (?, ?)',
      'expense-sales',
      order.id,
      'expense-valid',
      purchase.id,
    );
    await contracts.db.query(
      'INSERT INTO ad_groups (id, contract_id) VALUES (?, ?)',
      'ad-purchase',
      purchase.id,
    );
    const report = await preflightCommercePartyLinks(contracts.db);
    expect(report.invalidSalesReferences.map((row) => row.source_id)).toEqual(
      expect.arrayContaining([
        invoice.id,
        payment.id,
        fulfillment.id,
        'ad-purchase',
      ]),
    );
    expect(report.invalidSalesReferences).toHaveLength(4);
    expect(
      report.invalidPurchaseReferences.map((row) => row.source_id),
    ).toEqual(['expense-sales']);
  });

  it('reports tenant-owned documents linked to global or other-tenant contracts', async () => {
    const globalOrder = await save(
      new Order({ db: contracts.db, customerId: 'customer-a' }),
    );
    const otherOrder = await save(
      new Order({ db: contracts.db, customerId: 'customer-a' }),
    );
    const invoice = new Invoice({
      db: contracts.db,
      customerId: 'customer-a',
      contractId: globalOrder.id,
      invoiceNumber: 'INV-TENANT-PREFLIGHT',
    });
    const payment = new Payment({
      db: contracts.db,
      contractId: otherOrder.id,
    });
    for (const document of [invoice, payment]) {
      await document.initialize();
      await document.save();
    }
    await contracts.db.query(
      "UPDATE invoices SET tenant_id = 'tenant-a' WHERE id = ?",
      invoice.id,
    );
    await contracts.db.query(
      "UPDATE payments SET tenant_id = 'tenant-a' WHERE id = ?",
      payment.id,
    );
    await contracts.db.query(
      "UPDATE contracts SET tenant_id = 'tenant-b' WHERE id = ?",
      otherOrder.id,
    );
    const report = await preflightCommercePartyLinks(contracts.db);
    expect(report.invalidSalesReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_id: invoice.id,
          source_tenant_id: 'tenant-a',
          contract_tenant_id: null,
        }),
        expect.objectContaining({
          source_id: payment.id,
          source_tenant_id: 'tenant-a',
          contract_tenant_id: 'tenant-b',
        }),
      ]),
    );
  });
});
