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
    await withSystemContext(async () => {
      await (await contracts.create({ reference: 'g-contract' })).save();
    });

    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          contracts.findGlobal(),
        ),
        'reference',
      ),
    ).toEqual(['g-contract']);
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          contracts.findWithGlobals('tenant-1'),
        ),
        'reference',
      ),
    ).toEqual(['g-contract', 't1-contract']);
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
    ).toEqual(['g-contract', 't2-contract']);
  });

  it('ContractLineItemCollection.findGlobal/findWithGlobals do not throw and stay tenant-scoped', async () => {
    const items = await ContractLineItemCollection.create({ db });
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      await (await items.create({ description: 't1-line' })).save();
    });
    await withTenant({ tenantId: 'tenant-2' }, async () => {
      await (await items.create({ description: 't2-line' })).save();
    });
    await withSystemContext(async () => {
      await (await items.create({ description: 'g-line' })).save();
    });

    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () => items.findGlobal()),
        'description',
      ),
    ).toEqual(['g-line']);
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          items.findWithGlobals('tenant-1'),
        ),
        'description',
      ),
    ).toEqual(['g-line', 't1-line']);
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
    ).toEqual(['g-line', 't2-line']);
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
    // Fresh DRAFT invoice, zero amounts → satisfies the save-time financial
    // invariant (totalAmount === subtotal + taxAmount).
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      await (await invoices.create({ invoiceNumber: 't1-inv' })).save();
    });
    await withTenant({ tenantId: 'tenant-2' }, async () => {
      await (await invoices.create({ invoiceNumber: 't2-inv' })).save();
    });
    await withSystemContext(async () => {
      await (await invoices.create({ invoiceNumber: 'g-inv' })).save();
    });

    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () => invoices.findGlobal()),
        'invoiceNumber',
      ),
    ).toEqual(['g-inv']);
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          invoices.findWithGlobals('tenant-1'),
        ),
        'invoiceNumber',
      ),
    ).toEqual(['g-inv', 't1-inv']);
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
    ).toEqual(['g-inv', 't2-inv']);
  });

  it('InvoiceLineItemCollection.findGlobal/findWithGlobals do not throw and stay tenant-scoped', async () => {
    const items = await InvoiceLineItemCollection.create({ db });
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      await (await items.create({ description: 't1-ili' })).save();
    });
    await withTenant({ tenantId: 'tenant-2' }, async () => {
      await (await items.create({ description: 't2-ili' })).save();
    });
    await withSystemContext(async () => {
      await (await items.create({ description: 'g-ili' })).save();
    });

    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () => items.findGlobal()),
        'description',
      ),
    ).toEqual(['g-ili']);
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          items.findWithGlobals('tenant-1'),
        ),
        'description',
      ),
    ).toEqual(['g-ili', 't1-ili']);
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
    ).toEqual(['g-ili', 't2-ili']);
  });

  it('PaymentAllocationCollection.findGlobal/findWithGlobals do not throw and stay tenant-scoped', async () => {
    const allocations = await PaymentAllocationCollection.create({ db });
    // No paymentId/invoiceId → the FK-resolution caps are skipped; only the
    // positive-amount check applies (amount = 1).
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      await (await allocations.create({ amount: 1, notes: 't1-alloc' })).save();
    });
    await withTenant({ tenantId: 'tenant-2' }, async () => {
      await (await allocations.create({ amount: 1, notes: 't2-alloc' })).save();
    });
    await withSystemContext(async () => {
      await (await allocations.create({ amount: 1, notes: 'g-alloc' })).save();
    });

    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          allocations.findGlobal(),
        ),
        'notes',
      ),
    ).toEqual(['g-alloc']);
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          allocations.findWithGlobals('tenant-1'),
        ),
        'notes',
      ),
    ).toEqual(['g-alloc', 't1-alloc']);
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
    ).toEqual(['g-alloc', 't2-alloc']);
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
    // Payout.save() requires a resolvable source Payment (cap enforcement) and
    // grossAmount <= the payment's funded amount. Seed a Payment per context,
    // then a zero-amount Payout that references it.
    const seed = async (tag: string): Promise<void> => {
      const payment = await payments.create({ amount: 10 });
      await payment.save();
      await (
        await payouts.create({
          paymentId: payment.id ?? '',
          vendorId: 'vendor-1',
          grossAmount: 0,
          operatorFee: 0,
          supplierNet: 0,
          notes: tag,
        })
      ).save();
    };
    await withTenant({ tenantId: 'tenant-1' }, () => seed('t1-payout'));
    await withTenant({ tenantId: 'tenant-2' }, () => seed('t2-payout'));
    await withSystemContext(() => seed('g-payout'));

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
