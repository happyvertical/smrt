import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { expect } from 'vitest';
import { ContractCollection } from '../../collections/ContractCollection.js';
import { PurchaseContractCollection } from '../../collections/PurchaseContractCollection.js';
import { SalesContractCollection } from '../../collections/SalesContractCollection.js';
import { VendorCollection } from '../../collections/VendorCollection.js';
import { preflightCommercePartyLinks } from '../../migrations/partyLinks.js';
import { SupplierQuote } from '../../models/Contract.js';
import { ContractType } from '../../types/index.js';

/** Exercise public creation, tenant ownership, preflight, and transaction affinity. */
export async function proveSupplierQuote(db: DatabaseInterface): Promise<void> {
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const contracts = await ContractCollection.create({ db });
  const purchases = await PurchaseContractCollection.create({ db });
  const sales = await SalesContractCollection.create({ db });
  const vendors = await VendorCollection.create({ db });
  let quoteId = '';
  await withTenant({ tenantId }, async () => {
    const vendor = await vendors.create({ name: 'Quoted supplier' });
    if (!vendor.id) throw new Error('Expected persisted vendor');
    const quote = await purchases.create({
      _meta_type: '@happyvertical/smrt-commerce:SupplierQuote',
      vendorId: vendor.id,
      reference: 'SQ-REV-2',
      notes: 'Received revision 2',
      terms: 'NET-30',
      expiryDate: new Date('2026-12-01T00:00:00Z'),
    });
    if (!quote.id) throw new Error('Expected persisted supplier quote');
    quoteId = quote.id;
    expect(quote).toBeInstanceOf(SupplierQuote);
    expect(quote).toMatchObject({
      contractType: ContractType.SUPPLIER_QUOTE,
      vendorId: vendor.id,
      tenantId,
    });
    expect('customerId' in quote).toBe(false);
    const loaded = await contracts.get({ id: quote.id }, { cache: false });
    expect(loaded).toBeInstanceOf(SupplierQuote);
    expect(loaded).toMatchObject({
      reference: 'SQ-REV-2',
      notes: 'Received revision 2',
      terms: 'NET-30',
    });
    expect(loaded?.expiryDate?.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(
      (await purchases.findByVendor(vendor.id)).map((row) => row.id),
    ).toContain(quote.id);
    expect(await sales.get({ id: quote.id })).toBeNull();
    await expect(
      purchases.create({
        _meta_type: '@happyvertical/smrt-commerce:SupplierQuote',
      }),
    ).rejects.toThrow();
    await expect(
      purchases.create({
        _meta_type: '@happyvertical/smrt-commerce:UnknownQuote',
      }),
    ).rejects.toThrow();
    const stored = await db.query(
      'SELECT _meta_type FROM contracts WHERE id = ?',
      quote.id,
    );
    expect(stored.rows[0]._meta_type).toBe(
      '@happyvertical/smrt-commerce:SupplierQuote',
    );

    if (!db.transaction) throw new Error('Expected transaction support');
    const rolledBackId = randomUUID();
    await expect(
      db.transaction(async (tx) => {
        const scoped = await PurchaseContractCollection.create({ db: tx });
        await scoped.create({
          id: rolledBackId,
          _meta_type: '@happyvertical/smrt-commerce:SupplierQuote',
          vendorId: vendor.id,
        });
        expect(await scoped.get({ id: rolledBackId })).toBeInstanceOf(
          SupplierQuote,
        );
        throw new Error('rollback supplier quote');
      }),
    ).rejects.toThrow('rollback supplier quote');
    expect(
      await purchases.get({ id: rolledBackId }, { cache: false }),
    ).toBeNull();
    // Preflight uses concrete identity even if contract_type was corrupted.
    await db.query(
      "UPDATE contracts SET vendor_id = NULL, contract_type = 'order' WHERE id = ?",
      quote.id,
    );
    const preflight = await preflightCommercePartyLinks(db);
    expect(preflight.missingRequiredVendor.map((row) => row.id)).toContain(
      quote.id,
    );
    expect(preflight.discriminatorMismatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          _meta_type: '@happyvertical/smrt-commerce:SupplierQuote',
        }),
      ]),
    );
  });
  await withTenant({ tenantId: otherTenantId }, async () => {
    expect(await purchases.get({ id: quoteId }, { cache: false })).toBeNull();
    expect(await purchases.list()).toEqual([]);
  });
}
