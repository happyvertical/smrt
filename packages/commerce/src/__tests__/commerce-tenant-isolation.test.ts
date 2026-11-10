/**
 * Regression tests for the tenant-global query helpers (#1600) in smrt-commerce.
 *
 * Every commerce model is `@TenantScoped({ mode: 'optional' })` (own table, plus
 * Contract / ContractLineItem on an STI table). Their collections used to expose:
 *   findGlobal()          → list({ where: { tenantId: null } })
 *   findWithGlobals(tid)  → raw `WHERE tenant_id = ? OR tenant_id IS NULL`
 * Under an ACTIVE tenant context with tenancy enabled (default `'throw'`
 * policy) BOTH throw: the explicit `tenant_id IS NULL` filter is flagged as an
 * isolation violation, and unflagged raw SQL on a tenant-scoped class is
 * blocked. `findWithGlobals` also trusted its caller-supplied `tenantId`.
 *
 * They now route through the shared `@happyvertical/smrt-tenancy` helpers, which
 * run raw with `{ allowRawOnTenantScoped: true }` and fail closed when an active
 * tenant context requests another tenant's rows (admin/system path keeps the
 * cross-tenant capability). Mirrors
 * `packages/ledgers/src/__tests__/ledgers-tenant-isolation.test.ts`.
 *
 * Real in-memory SQLite, no DB mocking, tenancy enabled under the default
 * `'throw'` policy, per `.claude/rules/testing.md`.
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withSystemContext,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContractCollection } from '../collections/ContractCollection';
import { ContractLineItemCollection } from '../collections/ContractLineItemCollection';
import { CustomerCollection } from '../collections/CustomerCollection';
import { FulfillmentCollection } from '../collections/FulfillmentCollection';
import { FulfillmentLineItemCollection } from '../collections/FulfillmentLineItemCollection';
import { InvoiceCollection } from '../collections/InvoiceCollection';
import { InvoiceLineItemCollection } from '../collections/InvoiceLineItemCollection';
import { PaymentAllocationCollection } from '../collections/PaymentAllocationCollection';
import { PaymentCollection } from '../collections/PaymentCollection';
import { PaymentIntentCollection } from '../collections/PaymentIntentCollection';
import { PayoutCollection } from '../collections/PayoutCollection';
import { VendorCollection } from '../collections/VendorCollection';

const sorted = (rows: Array<Record<string, any>>, field: string): string[] =>
  rows.map((r) => String(r[field] ?? '')).sort();

describe('commerce tenant isolation (#1600)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    enableTenancy(); // default rawQueryPolicy: 'throw'
  });

  afterEach(async () => {
    disableTenancy();
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  it('ContractCollection.findGlobal/findWithGlobals do not throw and stay tenant-scoped', async () => {
    const contracts = await ContractCollection.create({ db });
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      await (await contracts.create({ reference: 't1-contract' })).save();
    });
    await withTenant({ tenantId: 'tenant-2' }, async () => {
      await (await contracts.create({ reference: 't2-contract' })).save();
    });
    // Money documents always belong to a tenant (#4021).
    await expect(
      withSystemContext(async () =>
        (await contracts.create({ reference: 'g-contract' })).save(),
      ),
    ).rejects.toThrow(/require a tenant/);

    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          contracts.findGlobal(),
        ),
        'reference',
      ),
    ).toEqual([]);
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          contracts.findWithGlobals('tenant-1'),
        ),
        'reference',
      ),
    ).toEqual(['t1-contract']);
    await expect(
      withTenant({ tenantId: 'tenant-1' }, () =>
        contracts.findWithGlobals('tenant-2'),
      ),
    ).rejects.toThrow(/isolation/i);
    expect(
      sorted(
        await withSystemContext(() => contracts.findWithGlobals('tenant-2')),
        'reference',
      ),
    ).toEqual(['t2-contract']);
  });

  it('ContractLineItemCollection.findGlobal/findWithGlobals do not throw and stay tenant-scoped', async () => {
    const items = await ContractLineItemCollection.create({ db });
    const contracts = await ContractCollection.create({ db });
    for (const [tenantId, description] of [
      ['tenant-1', 't1-line'],
      ['tenant-2', 't2-line'],
    ])
      await withTenant({ tenantId }, async () => {
        const contract = await contracts.create({ reference: description });
        await items.create({ contractId: contract.id, description });
      });

    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () => items.findGlobal()),
        'description',
      ),
    ).toEqual([]);
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          items.findWithGlobals('tenant-1'),
        ),
        'description',
      ),
    ).toEqual(['t1-line']);
    await expect(
      withTenant({ tenantId: 'tenant-1' }, () =>
        items.findWithGlobals('tenant-2'),
      ),
    ).rejects.toThrow(/isolation/i);
    expect(
      sorted(
        await withSystemContext(() => items.findWithGlobals('tenant-2')),
        'description',
      ),
    ).toEqual(['t2-line']);
  });

  it('CustomerCollection.findGlobal/findWithGlobals do not throw and stay tenant-scoped', async () => {
    const customers = await CustomerCollection.create({ db });
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      await (await customers.create({ paymentTerms: 't1-cust' })).save();
    });
    await withTenant({ tenantId: 'tenant-2' }, async () => {
      await (await customers.create({ paymentTerms: 't2-cust' })).save();
    });
    await withSystemContext(async () => {
      await (await customers.create({ paymentTerms: 'g-cust' })).save();
    });

    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          customers.findGlobal(),
        ),
        'paymentTerms',
      ),
    ).toEqual(['g-cust']);
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          customers.findWithGlobals('tenant-1'),
        ),
        'paymentTerms',
      ),
    ).toEqual(['g-cust', 't1-cust']);
    await expect(
      withTenant({ tenantId: 'tenant-1' }, () =>
        customers.findWithGlobals('tenant-2'),
      ),
    ).rejects.toThrow(/isolation/i);
    expect(
      sorted(
        await withSystemContext(() => customers.findWithGlobals('tenant-2')),
        'paymentTerms',
      ),
    ).toEqual(['g-cust', 't2-cust']);
  });

  it('FulfillmentCollection.findGlobal/findWithGlobals do not throw and stay tenant-scoped', async () => {
    const fulfillments = await FulfillmentCollection.create({ db });
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      await (await fulfillments.create({ trackingNumber: 't1-ship' })).save();
    });
    await withTenant({ tenantId: 'tenant-2' }, async () => {
      await (await fulfillments.create({ trackingNumber: 't2-ship' })).save();
    });
    await withSystemContext(async () => {
      await (await fulfillments.create({ trackingNumber: 'g-ship' })).save();
    });

    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          fulfillments.findGlobal(),
        ),
        'trackingNumber',
      ),
    ).toEqual(['g-ship']);
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          fulfillments.findWithGlobals('tenant-1'),
        ),
        'trackingNumber',
      ),
    ).toEqual(['g-ship', 't1-ship']);
    await expect(
      withTenant({ tenantId: 'tenant-1' }, () =>
        fulfillments.findWithGlobals('tenant-2'),
      ),
    ).rejects.toThrow(/isolation/i);
    expect(
      sorted(
        await withSystemContext(() => fulfillments.findWithGlobals('tenant-2')),
        'trackingNumber',
      ),
    ).toEqual(['g-ship', 't2-ship']);
  });

  it('FulfillmentLineItemCollection.findGlobal/findWithGlobals do not throw and stay tenant-scoped', async () => {
    const items = await FulfillmentLineItemCollection.create({ db });
    // No contractLineItemId → the over-fulfillment guard is skipped; only the
    // positive-quantity check (default quantityFulfilled = 1) applies.
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      await (await items.create({ notes: 't1-fli' })).save();
    });
    await withTenant({ tenantId: 'tenant-2' }, async () => {
      await (await items.create({ notes: 't2-fli' })).save();
    });
    await withSystemContext(async () => {
      await (await items.create({ notes: 'g-fli' })).save();
    });

    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () => items.findGlobal()),
        'notes',
      ),
    ).toEqual(['g-fli']);
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          items.findWithGlobals('tenant-1'),
        ),
        'notes',
      ),
    ).toEqual(['g-fli', 't1-fli']);
    await expect(
      withTenant({ tenantId: 'tenant-1' }, () =>
        items.findWithGlobals('tenant-2'),
      ),
    ).rejects.toThrow(/isolation/i);
    expect(
      sorted(
        await withSystemContext(() => items.findWithGlobals('tenant-2')),
        'notes',
      ),
    ).toEqual(['g-fli', 't2-fli']);
  });

  it('InvoiceCollection.findGlobal/findWithGlobals do not throw and stay tenant-scoped', async () => {
    const invoices = await InvoiceCollection.create({ db });
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      await (await invoices.create({ invoiceNumber: 't1-inv' })).save();
    });
    await withTenant({ tenantId: 'tenant-2' }, async () => {
      await (await invoices.create({ invoiceNumber: 't2-inv' })).save();
    });
    // Money documents always belong to a tenant (#4021).
    await expect(
      withSystemContext(async () =>
        (await invoices.create({ invoiceNumber: 'g-inv' })).save(),
      ),
    ).rejects.toThrow(/require a tenant/);

    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () => invoices.findGlobal()),
        'invoiceNumber',
      ),
    ).toEqual([]);
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          invoices.findWithGlobals('tenant-1'),
        ),
        'invoiceNumber',
      ),
    ).toEqual(['t1-inv']);
    await expect(
      withTenant({ tenantId: 'tenant-1' }, () =>
        invoices.findWithGlobals('tenant-2'),
      ),
    ).rejects.toThrow(/isolation/i);
    expect(
      sorted(
        await withSystemContext(() => invoices.findWithGlobals('tenant-2')),
        'invoiceNumber',
      ),
    ).toEqual(['t2-inv']);
  });

  it('InvoiceLineItemCollection.findGlobal/findWithGlobals do not throw and stay tenant-scoped', async () => {
    const items = await InvoiceLineItemCollection.create({ db });
    const invoices = await InvoiceCollection.create({ db });
    for (const [tenantId, description] of [
      ['tenant-1', 't1-ili'],
      ['tenant-2', 't2-ili'],
    ])
      await withTenant({ tenantId }, async () => {
        const invoice = await invoices.create({ invoiceNumber: description });
        await items.create({ invoiceId: invoice.id, description });
      });

    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () => items.findGlobal()),
        'description',
      ),
    ).toEqual([]);
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          items.findWithGlobals('tenant-1'),
        ),
        'description',
      ),
    ).toEqual(['t1-ili']);
    await expect(
      withTenant({ tenantId: 'tenant-1' }, () =>
        items.findWithGlobals('tenant-2'),
      ),
    ).rejects.toThrow(/isolation/i);
    expect(
      sorted(
        await withSystemContext(() => items.findWithGlobals('tenant-2')),
        'description',
      ),
    ).toEqual(['t2-ili']);
  });

  it('PaymentAllocationCollection.findGlobal/findWithGlobals do not throw and stay tenant-scoped', async () => {
    const allocations = await PaymentAllocationCollection.create({ db });
    const payments = await PaymentCollection.create({ db });
    const invoices = await InvoiceCollection.create({ db });
    const createAllocation = async (notes: string) => {
      const payment = await payments.create({ amount: 1 });
      const invoice = await invoices.create({ currency: 'USD' });
      await (await InvoiceLineItemCollection.create({ db })).create({
        invoiceId: invoice.id,
        description: notes,
        quantity: 1,
        unitPrice: 1,
      });
      await allocations.create({
        paymentId: payment.id,
        invoiceId: invoice.id,
        amount: 1,
        notes,
      });
    };
    await withTenant({ tenantId: 'tenant-1' }, () =>
      createAllocation('t1-alloc'),
    );
    await withTenant({ tenantId: 'tenant-2' }, () =>
      createAllocation('t2-alloc'),
    );
    // A global allocation would need a global invoice; money documents always
    // belong to a tenant (#4021).

    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          allocations.findGlobal(),
        ),
        'notes',
      ),
    ).toEqual([]);
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          allocations.findWithGlobals('tenant-1'),
        ),
        'notes',
      ),
    ).toEqual(['t1-alloc']);
    await expect(
      withTenant({ tenantId: 'tenant-1' }, () =>
        allocations.findWithGlobals('tenant-2'),
      ),
    ).rejects.toThrow(/isolation/i);
    expect(
      sorted(
        await withSystemContext(() => allocations.findWithGlobals('tenant-2')),
        'notes',
      ),
    ).toEqual(['t2-alloc']);
  });

  it('PaymentCollection.findGlobal/findWithGlobals do not throw and stay tenant-scoped', async () => {
    const payments = await PaymentCollection.create({ db });
    // Fresh PENDING payment → no state-machine guard fires.
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      await (await payments.create({ reference: 't1-pay' })).save();
    });
    await withTenant({ tenantId: 'tenant-2' }, async () => {
      await (await payments.create({ reference: 't2-pay' })).save();
    });
    await withSystemContext(async () => {
      await (await payments.create({ reference: 'g-pay' })).save();
    });

    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () => payments.findGlobal()),
        'reference',
      ),
    ).toEqual(['g-pay']);
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          payments.findWithGlobals('tenant-1'),
        ),
        'reference',
      ),
    ).toEqual(['g-pay', 't1-pay']);
    await expect(
      withTenant({ tenantId: 'tenant-1' }, () =>
        payments.findWithGlobals('tenant-2'),
      ),
    ).rejects.toThrow(/isolation/i);
    expect(
      sorted(
        await withSystemContext(() => payments.findWithGlobals('tenant-2')),
        'reference',
      ),
    ).toEqual(['g-pay', 't2-pay']);
  });

  it('PaymentIntentCollection.findGlobal/findWithGlobals do not throw and stay tenant-scoped', async () => {
    const intents = await PaymentIntentCollection.create({ db });
    // Default AWAITING_PAYMENT status → no PAID/ISSUED backing verification.
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      await (await intents.create({ notes: 't1-intent' })).save();
    });
    await withTenant({ tenantId: 'tenant-2' }, async () => {
      await (await intents.create({ notes: 't2-intent' })).save();
    });
    await withSystemContext(async () => {
      await (await intents.create({ notes: 'g-intent' })).save();
    });

    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () => intents.findGlobal()),
        'notes',
      ),
    ).toEqual(['g-intent']);
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          intents.findWithGlobals('tenant-1'),
        ),
        'notes',
      ),
    ).toEqual(['g-intent', 't1-intent']);
    await expect(
      withTenant({ tenantId: 'tenant-1' }, () =>
        intents.findWithGlobals('tenant-2'),
      ),
    ).rejects.toThrow(/isolation/i);
    expect(
      sorted(
        await withSystemContext(() => intents.findWithGlobals('tenant-2')),
        'notes',
      ),
    ).toEqual(['g-intent', 't2-intent']);
  });

  it('PayoutCollection.findGlobal/findWithGlobals do not throw and stay tenant-scoped', async () => {
    const payments = await PaymentCollection.create({ db });
    const payouts = await PayoutCollection.create({ db });
    const vendors = await VendorCollection.create({ db });
    // Payout.save() requires a resolvable source Payment (cap enforcement) and
    // grossAmount <= the payment's funded amount. Seed a Payment per context,
    // then a zero-amount Payout that references it.
    const seed = async (tag: string, vendorId: string): Promise<void> => {
      await (await vendors.create({ id: vendorId, name: tag })).save();
      const payment = await payments.create({ amount: 10 });
      await payment.save();
      await (
        await payouts.create({
          paymentId: payment.id ?? '',
          vendorId,
          grossAmount: 0,
          operatorFee: 0,
          supplierNet: 0,
          notes: tag,
        })
      ).save();
    };
    await withTenant({ tenantId: 'tenant-1' }, () =>
      seed('t1-payout', 'vendor-1'),
    );
    await withTenant({ tenantId: 'tenant-2' }, () =>
      seed('t2-payout', 'vendor-2'),
    );
    await withSystemContext(() => seed('g-payout', 'vendor-g'));

    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () => payouts.findGlobal()),
        'notes',
      ),
    ).toEqual(['g-payout']);
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          payouts.findWithGlobals('tenant-1'),
        ),
        'notes',
      ),
    ).toEqual(['g-payout', 't1-payout']);
    await expect(
      withTenant({ tenantId: 'tenant-1' }, () =>
        payouts.findWithGlobals('tenant-2'),
      ),
    ).rejects.toThrow(/isolation/i);
    expect(
      sorted(
        await withSystemContext(() => payouts.findWithGlobals('tenant-2')),
        'notes',
      ),
    ).toEqual(['g-payout', 't2-payout']);
  });

  it('VendorCollection.findGlobal/findWithGlobals do not throw and stay tenant-scoped', async () => {
    const vendors = await VendorCollection.create({ db });
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      await (await vendors.create({ paymentTerms: 't1-vendor' })).save();
    });
    await withTenant({ tenantId: 'tenant-2' }, async () => {
      await (await vendors.create({ paymentTerms: 't2-vendor' })).save();
    });
    await withSystemContext(async () => {
      await (await vendors.create({ paymentTerms: 'g-vendor' })).save();
    });

    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () => vendors.findGlobal()),
        'paymentTerms',
      ),
    ).toEqual(['g-vendor']);
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          vendors.findWithGlobals('tenant-1'),
        ),
        'paymentTerms',
      ),
    ).toEqual(['g-vendor', 't1-vendor']);
    await expect(
      withTenant({ tenantId: 'tenant-1' }, () =>
        vendors.findWithGlobals('tenant-2'),
      ),
    ).rejects.toThrow(/isolation/i);
    expect(
      sorted(
        await withSystemContext(() => vendors.findWithGlobals('tenant-2')),
        'paymentTerms',
      ),
    ).toEqual(['g-vendor', 't2-vendor']);
  });
});
