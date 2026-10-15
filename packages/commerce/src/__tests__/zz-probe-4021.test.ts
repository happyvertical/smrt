import { getTestDatabase } from '@happyvertical/smrt-core';
import { describe, expect } from 'vitest';
import { ContractCollection } from '../collections/ContractCollection.js';
import { CustomerCollection } from '../collections/CustomerCollection.js';
import { InvoiceCollection } from '../collections/InvoiceCollection.js';
import { tenantIt } from './helpers/v2-tenant.js';

const it = tenantIt();
describe('probe', () => {
  it('first insert totals', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const cu = await (await CustomerCollection.create({ db })).create({
      id: 'c1',
      profileId: 'p',
    });
    await cu.save();
    const contracts = await ContractCollection.create({ db });
    const c = await contracts.create({
      _meta_type: 'Order',
      customerId: 'c1',
      totalAmount: 1080,
      subtotal: 1000,
    });
    const loaded = await contracts.get({ id: c.id });
    const invoices = await InvoiceCollection.create({ db });
    const i = await invoices.create({
      totalAmount: 1080,
      subtotal: 1000,
      invoiceNumber: 'X',
      customerId: 'c1',
    });
    const li = await invoices.get({ id: i.id });
    expect([
      loaded?.totalAmount,
      loaded?.subtotal,
      li?.totalAmount,
      li?.subtotal,
    ]).toEqual(['x']);
    expect(1).toBe(1);
  });
});
