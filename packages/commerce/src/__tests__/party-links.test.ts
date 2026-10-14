import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
} from '../models/Contract.js';
import { Fulfillment } from '../models/Fulfillment.js';
import { Invoice } from '../models/Invoice.js';
import { Payment } from '../models/Payment.js';

async function save<T extends Contract>(object: T): Promise<T> {
  await object.initialize();
  return object.save();
}

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
    for (const name of ['PurchaseOrder', 'ProductionOrder']) {
      expect(model(name).fields.vendorId?.type).toBe('foreignKey');
      expect(model(name).fields.customerId).toBeUndefined();
      expect(model(name).fields.vendorId.required).toBe(
        name === 'PurchaseOrder',
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

  it('requires parties only on the specified leaves', async () => {
    await expect(save(new Order({ db: contracts.db }))).rejects.toThrow();
    await expect(save(new Estimate({ db: contracts.db }))).rejects.toThrow();
    await expect(
      save(new PurchaseOrder({ db: contracts.db })),
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
    expect(report.baseTypedRows.map((row) => row.id)).toContain(base.id);
    expect(
      report.discriminatorMismatches.some((row) =>
        row._meta_type?.endsWith(':Estimate'),
      ),
    ).toBe(true);
    expect(after.rows).toEqual(before.rows);
  });
});
