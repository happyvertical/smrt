/**
 * Regression tests for the T2 commerce remediation findings (#1389).
 *
 * Each `describe` block maps to a confirmed finding:
 *
 *  1. [blocking] Invoice.updatePaymentStatus decides PAID with the SAME
 *     epsilon-tolerant test the save-time guard uses, so a float-summed total
 *     paid exactly is PAID-and-saveable (not PARTIAL-then-rejected).
 *  2. [major] A no-line-item invoice whose totalAmount differs from
 *     subtotal+tax by < INVOICE_EPSILON but > the ledger's BALANCE_EPSILON can
 *     still recognize revenue, because totalAmount is snapped to subtotal+tax.
 *  3. [major] Fulfillment rejects illegal status transitions on save and via
 *     its mark* helpers (e.g. DELIVERED → PENDING).
 *  4. [major] FulfillmentLineItem rejects over-fulfilling a contract line
 *     (shipping 50 of 10 ordered).
 *  6. [speculative] PaymentAllocation rejects allocations from different
 *     payments that jointly over-pay an invoice.
 *
 * Round-2 review findings (PR #1592):
 *  - [P1 tenant-isolation] FulfillmentLineItem loads the ordered ContractLineItem
 *    tenant-scoped (a foreign-tenant id fails closed) and rejects a line item
 *    that belongs to a different contract than the parent Fulfillment.
 *  - [P2 zero-total] PaymentAllocation skips the invoice-total cap for a
 *    total=0 invoice (does not throw) per the documented intent.
 *
 * Real in-memory SQLite (no DB mocking), per repo testing conventions. Money
 * math is executed, not asserted from comments.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContractCollection } from '../collections/ContractCollection.js';
import { ContractLineItemCollection } from '../collections/ContractLineItemCollection.js';
import { CustomerCollection } from '../collections/CustomerCollection.js';
import { FulfillmentCollection } from '../collections/FulfillmentCollection.js';
import { FulfillmentLineItemCollection } from '../collections/FulfillmentLineItemCollection.js';
import { InvoiceCollection } from '../collections/InvoiceCollection.js';
import { InvoiceLineItemCollection } from '../collections/InvoiceLineItemCollection.js';
import { PaymentAllocationCollection } from '../collections/PaymentAllocationCollection.js';
import { PaymentCollection } from '../collections/PaymentCollection.js';
import { FulfillmentStatus, InvoiceStatus } from '../types/index.js';

function tmpDb(tag: string): string {
  return join(tmpdir(), `smrt-t2b-${tag}-${Date.now()}-${Math.random()}.db`);
}

// ---------------------------------------------------------------------------
// Finding 1 [blocking]: updatePaymentStatus epsilon parity with the save guard
// ---------------------------------------------------------------------------

describe('Invoice payment-status epsilon (#1389 blocking)', () => {
  let dbPath: string;
  let invoices: InvoiceCollection;
  let lineItems: InvoiceLineItemCollection;
  let payments: PaymentCollection;
  let allocations: PaymentAllocationCollection;

  beforeEach(async () => {
    dbPath = tmpDb('epsilon');
    invoices = await InvoiceCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    lineItems = await InvoiceLineItemCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    payments = await PaymentCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    allocations = await PaymentAllocationCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
  });

  afterEach(() => {
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch {
        // ignore
      }
    }
  });

  it('marks an invoice PAID and saves it when a float-summed total is paid exactly (0.1×3 line items, pay 0.3)', async () => {
    // Confirm the float pitfall is real, executed (not assumed): three 0.1
    // line items sum to slightly MORE than 0.3 under IEEE-754.
    expect(0.1 + 0.1 + 0.1).toBeGreaterThan(0.3);

    const invoice = await invoices.create({
      invoiceNumber: 'INV-EPS-1',
      totalAmount: 0,
    });
    // Get the invoice out of DRAFT so a payment can drive it to PAID.
    invoice.markSent();
    await invoice.save();

    // Three line items of 0.1 each → authoritative total 0.30000000000000004.
    for (let i = 0; i < 3; i++) {
      const li = await lineItems.create({
        invoiceId: invoice.id,
        description: `Item ${i}`,
        quantity: 1,
        unitPrice: 0.1,
      });
      li.amount = li.calculateAmount();
      await li.save();
    }

    // Reload so totalAmount is recomputed from the line items on save.
    const reloaded = await invoices.get({ id: invoice.id });
    if (!reloaded) throw new Error('invoice did not reload');
    await reloaded.save(); // recompute totalAmount from line items
    expect(reloaded.totalAmount).toBeGreaterThan(0.3);

    // Pay EXACTLY 0.3 via an allocation, then update payment status.
    const payment = await payments.create({ amount: 0.3, currency: 'USD' });
    await payment.save();
    const alloc = await allocations.create({
      paymentId: payment.id,
      invoiceId: reloaded.id,
      amount: 0.3,
    });
    await alloc.save();

    const total = await allocations.getTotalAllocatedToInvoice(
      reloaded.id ?? '',
    );
    // Strict `>=` would read 0.3 >= 0.30000000000000004 as false here.
    expect(total >= reloaded.totalAmount).toBe(false);

    reloaded.updatePaymentStatus(total);
    // Epsilon-aware: status is PAID, not PARTIAL.
    expect(reloaded.status).toBe(InvoiceStatus.PAID);

    // …and the save-time guard agrees, so the fully-paid invoice persists.
    await expect(reloaded.save()).resolves.toBeTruthy();

    const final = await invoices.get({ id: reloaded.id });
    expect(final?.status).toBe(InvoiceStatus.PAID);
  });
});

// ---------------------------------------------------------------------------
// Finding 2 [major]: invoice ↔ ledger epsilon gap (no-line-item snap)
// ---------------------------------------------------------------------------

describe('Invoice/ledger epsilon snap (#1389 major)', () => {
  let dbPath: string;
  let invoices: InvoiceCollection;

  beforeEach(async () => {
    dbPath = tmpDb('snap');
    invoices = await InvoiceCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
  });

  afterEach(() => {
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch {
        // ignore
      }
    }
  });

  it('snaps totalAmount to subtotal+tax so a no-line-item invoice recognizes revenue without a ledger-imbalance throw', async () => {
    // subtotal 100.00 / total 100.005: the gap (0.005) is inside the invoice
    // epsilon (0.01) but outside the ledger epsilon (0.001). Confirm the gap
    // straddles both tolerances, executed.
    const gap = Math.abs(100.005 - 100.0);
    expect(gap).toBeLessThanOrEqual(0.01); // passes invoice guard
    expect(gap).toBeGreaterThan(0.001); // would fail ledger balance pre-snap

    const invoice = await invoices.create({
      invoiceNumber: 'INV-SNAP-1',
      subtotal: 100.0,
      taxAmount: 0,
      totalAmount: 100.005,
    });
    await invoice.save();

    // The snap fired: total is exactly subtotal+tax now.
    expect(invoice.totalAmount).toBe(100.0);

    // Real ledger accounts so revenue recognition can actually post.
    const { AccountCollection } = await import('@happyvertical/smrt-ledgers');
    const accounts = await AccountCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    const arAcct = await accounts.create({
      number: '1200',
      name: 'Accounts Receivable',
      type: 'asset',
    });
    await arAcct.save();
    const revAcct = await accounts.create({
      number: '4000',
      name: 'Revenue',
      type: 'revenue',
    });
    await revAcct.save();

    // Pre-snap this would build DR 100.005 / CR 100.00 and journal.post()
    // would throw "not balanced", void, and rethrow. Post-snap it balances.
    const journal = await invoice.recognizeRevenue({
      arAccountId: arAcct.id!,
      revenueAccountId: revAcct.id!,
    } as any);
    expect(journal).toBeTruthy();

    const entries = await journal.getEntries();
    const debit = entries.reduce((s: number, e: any) => s + (e.debit || 0), 0);
    const credit = entries.reduce(
      (s: number, e: any) => s + (e.credit || 0),
      0,
    );
    expect(Math.abs(debit - credit)).toBeLessThan(0.001); // ledger-balanced
  });
});

// ---------------------------------------------------------------------------
// Finding 3 [major]: Fulfillment status-transition guard
// ---------------------------------------------------------------------------

describe('Fulfillment status-transition guard (#1389 major)', () => {
  let dbPath: string;
  let fulfillments: FulfillmentCollection;
  let contracts: ContractCollection;
  let customers: CustomerCollection;

  beforeEach(async () => {
    dbPath = tmpDb('fulfill-guard');
    fulfillments = await FulfillmentCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
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
        // ignore
      }
    }
  });

  async function seedFulfillment(status: FulfillmentStatus) {
    const customer = await customers.create({ profileId: 'fg' });
    await customer.save();
    const contract = await contracts.create({ customerId: customer.id });
    await contract.save();
    const f = await fulfillments.create({
      contractId: contract.id,
      status,
    });
    await f.save();
    return f;
  }

  it('rejects a DELIVERED → PENDING flip via raw assignment on save', async () => {
    const f = await seedFulfillment(FulfillmentStatus.DELIVERED);
    // Reload so the authoritative prior status is read from the DB.
    const reloaded = await fulfillments.get({ id: f.id });
    if (!reloaded) throw new Error('fulfillment did not reload');
    reloaded.status = FulfillmentStatus.PENDING;
    await expect(reloaded.save()).rejects.toThrow(/illegal status transition/);
  });

  it('rejects markShipped on a DELIVERED fulfillment (terminal state)', async () => {
    const f = await seedFulfillment(FulfillmentStatus.DELIVERED);
    expect(() => f.markShipped()).toThrow(/cannot move/);
  });

  it('rejects cancel on a DELIVERED fulfillment', async () => {
    const f = await seedFulfillment(FulfillmentStatus.DELIVERED);
    expect(() => f.cancel()).toThrow(/cannot move/);
  });

  it('rejects markDelivered on a CANCELLED fulfillment', async () => {
    const f = await seedFulfillment(FulfillmentStatus.CANCELLED);
    expect(() => f.markDelivered()).toThrow(/cannot move/);
  });

  it('still allows the legal PENDING → SHIPPED → DELIVERED path', async () => {
    const f = await seedFulfillment(FulfillmentStatus.PENDING);
    f.markShipped('TRACK-1', 'UPS');
    await expect(f.save()).resolves.toBeTruthy();
    f.markDelivered();
    await expect(f.save()).resolves.toBeTruthy();
    expect(f.status).toBe(FulfillmentStatus.DELIVERED);
  });
});

// ---------------------------------------------------------------------------
// Finding 4 [major]: over-fulfillment cap
// ---------------------------------------------------------------------------

describe('FulfillmentLineItem over-fulfillment cap (#1389 major)', () => {
  let dbPath: string;
  let contracts: ContractCollection;
  let customers: CustomerCollection;
  let fulfillments: FulfillmentCollection;
  let fulfillmentItems: FulfillmentLineItemCollection;

  beforeEach(async () => {
    dbPath = tmpDb('over-fulfill');
    contracts = await ContractCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    customers = await CustomerCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    fulfillments = await FulfillmentCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    fulfillmentItems = await FulfillmentLineItemCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
  });

  afterEach(() => {
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch {
        // ignore
      }
    }
  });

  // The ordered ContractLineItem is built through its dedicated
  // `ContractLineItemCollection` (added in PR #1592 round 2 so the
  // over-fulfillment guard can load it tenant-scoped). `collection.create()`
  // already persists (it calls save internally), so the over-fulfillment guard
  // fires inside the FulfillmentLineItem `create()` — the rejection assertions
  // wrap the `create` call, not a later save.
  async function seed() {
    const customer = await customers.create({ profileId: 'of' });
    await customer.save();
    const contract = await contracts.create({ customerId: customer.id });
    await contract.save();

    const lineItems = await ContractLineItemCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    const orderedLine = await lineItems.create({
      contractId: contract.id,
      description: 'Widget',
      quantity: 10, // ordered 10
      unitPrice: 5,
    });
    await orderedLine.save();

    const fulfillment = await fulfillments.create({ contractId: contract.id });
    await fulfillment.save();

    return { contract, orderedLine, fulfillment };
  }

  it('rejects shipping 50 of 10 ordered', async () => {
    const { orderedLine, fulfillment } = await seed();
    await expect(
      fulfillmentItems.create({
        fulfillmentId: fulfillment.id,
        contractLineItemId: orderedLine.id,
        quantityFulfilled: 50,
      }),
    ).rejects.toThrow(/over-fulfill/);
  });

  it('rejects a second fulfillment that pushes the cumulative quantity over the ordered amount', async () => {
    const { orderedLine, fulfillment } = await seed();
    const first = await fulfillmentItems.create({
      fulfillmentId: fulfillment.id,
      contractLineItemId: orderedLine.id,
      quantityFulfilled: 7,
    });
    await first.save();

    await expect(
      fulfillmentItems.create({
        fulfillmentId: fulfillment.id,
        contractLineItemId: orderedLine.id,
        quantityFulfilled: 5, // 7 + 5 = 12 > 10 ordered
      }),
    ).rejects.toThrow(/over-fulfill/);
  });

  it('allows partial fulfillment up to the ordered quantity', async () => {
    const { orderedLine, fulfillment } = await seed();
    const first = await fulfillmentItems.create({
      fulfillmentId: fulfillment.id,
      contractLineItemId: orderedLine.id,
      quantityFulfilled: 6,
    });
    await expect(first.save()).resolves.toBeTruthy();

    const second = await fulfillmentItems.create({
      fulfillmentId: fulfillment.id,
      contractLineItemId: orderedLine.id,
      quantityFulfilled: 4, // 6 + 4 = 10 == ordered, allowed
    });
    await expect(second.save()).resolves.toBeTruthy();
  });

  it('rejects a non-positive quantityFulfilled', async () => {
    const { orderedLine, fulfillment } = await seed();
    await expect(
      fulfillmentItems.create({
        fulfillmentId: fulfillment.id,
        contractLineItemId: orderedLine.id,
        quantityFulfilled: 0,
      }),
    ).rejects.toThrow(/positive number/);
  });

  // -------------------------------------------------------------------------
  // Round-2 [P1 tenant-isolation]: the ContractLineItem is loaded
  // tenant-scoped and must belong to the parent Fulfillment's contract.
  // -------------------------------------------------------------------------

  it('rejects a ContractLineItem that belongs to a different contract than the Fulfillment', async () => {
    // Contract A with an ordered line; Contract B with its own Fulfillment.
    const { orderedLine: lineInContractA } = await seed();

    const customerB = await customers.create({ profileId: 'of-b' });
    await customerB.save();
    const contractB = await contracts.create({ customerId: customerB.id });
    await contractB.save();
    const fulfillmentForB = await fulfillments.create({
      contractId: contractB.id,
    });
    await fulfillmentForB.save();

    // Point contract B's Fulfillment at contract A's line item. Quantity is
    // well within A's ordered 10, so ONLY the cross-contract guard can reject.
    await expect(
      fulfillmentItems.create({
        fulfillmentId: fulfillmentForB.id,
        contractLineItemId: lineInContractA.id,
        quantityFulfilled: 1,
      }),
    ).rejects.toThrow(/different contract/);
  });

  it('rejects a cross-tenant ContractLineItem id (fails closed to "does not exist")', async () => {
    const { enableTenancy, disableTenancy, withTenant } = await import(
      '@happyvertical/smrt-tenancy'
    );
    try {
      enableTenancy();

      // Tenant A owns a contract + ordered line + fulfillment.
      const { lineId, fulfillmentId } = await withTenant(
        { tenantId: 'tenant-a' },
        async () => {
          const customer = await customers.create({ profileId: 'of-ta' });
          await customer.save();
          const contract = await contracts.create({ customerId: customer.id });
          await contract.save();

          const lineItems = await ContractLineItemCollection.create({
            db: { type: 'sqlite', url: dbPath },
          });
          const orderedLine = await lineItems.create({
            contractId: contract.id,
            description: 'Widget-A',
            quantity: 10,
            unitPrice: 5,
          });
          await orderedLine.save();

          const fulfillment = await fulfillments.create({
            contractId: contract.id,
          });
          await fulfillment.save();

          return {
            lineId: orderedLine.id as string,
            fulfillmentId: fulfillment.id as string,
          };
        },
      );

      // Tenant B tries to fulfill against tenant A's line item id. The
      // tenant-scoped load filters the foreign-tenant row out, so the guard
      // sees it as missing and rejects — a foreign-tenant quantity can never
      // be read to size (or bypass) the over-fulfillment cap.
      await withTenant({ tenantId: 'tenant-b' }, async () => {
        await expect(
          fulfillmentItems.create({
            fulfillmentId,
            contractLineItemId: lineId,
            quantityFulfilled: 1,
          }),
        ).rejects.toThrow(/does not exist/);
      });
    } finally {
      disableTenancy();
    }
  });

  it('allows an in-contract line item under the same tenant (happy path)', async () => {
    const { enableTenancy, disableTenancy, withTenant } = await import(
      '@happyvertical/smrt-tenancy'
    );
    try {
      enableTenancy();
      await withTenant({ tenantId: 'tenant-a' }, async () => {
        const customer = await customers.create({ profileId: 'of-happy' });
        await customer.save();
        const contract = await contracts.create({ customerId: customer.id });
        await contract.save();

        const lineItems = await ContractLineItemCollection.create({
          db: { type: 'sqlite', url: dbPath },
        });
        const orderedLine = await lineItems.create({
          contractId: contract.id,
          description: 'Widget-Happy',
          quantity: 10,
          unitPrice: 5,
        });
        await orderedLine.save();

        const fulfillment = await fulfillments.create({
          contractId: contract.id,
        });
        await fulfillment.save();

        const item = await fulfillmentItems.create({
          fulfillmentId: fulfillment.id,
          contractLineItemId: orderedLine.id,
          quantityFulfilled: 4,
        });
        await expect(item.save()).resolves.toBeTruthy();
      });
    } finally {
      disableTenancy();
    }
  });
});

// ---------------------------------------------------------------------------
// Finding 6 [speculative]: PaymentAllocation invoice-level over-pay cap
// ---------------------------------------------------------------------------

describe('PaymentAllocation invoice-level cap (#1389 speculative)', () => {
  let dbPath: string;
  let allocations: PaymentAllocationCollection;
  let payments: PaymentCollection;
  let invoices: InvoiceCollection;

  beforeEach(async () => {
    dbPath = tmpDb('inv-cap');
    allocations = await PaymentAllocationCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    payments = await PaymentCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    invoices = await InvoiceCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
  });

  afterEach(() => {
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch {
        // ignore
      }
    }
  });

  it('rejects allocations from two different payments that jointly over-pay an invoice', async () => {
    const invoice = await invoices.create({
      invoiceNumber: 'INV-CAP-1',
      subtotal: 100,
      taxAmount: 0,
      totalAmount: 100,
    });
    await invoice.save();

    // Two separate payments, each large enough to pass its own per-payment cap.
    const p1 = await payments.create({ amount: 100, currency: 'USD' });
    await p1.save();
    const p2 = await payments.create({ amount: 100, currency: 'USD' });
    await p2.save();

    const a1 = await allocations.create({
      paymentId: p1.id,
      invoiceId: invoice.id,
      amount: 80,
    });
    await a1.save();

    // 80 + 30 = 110 > 100 invoice total → invoice-level cap fires even though
    // p2 alone (100) easily covers a 30 allocation. `create` persists (it calls
    // save internally), so the guard fires there.
    await expect(
      allocations.create({
        paymentId: p2.id,
        invoiceId: invoice.id,
        amount: 30,
      }),
    ).rejects.toThrow(/over-pay invoice/);
  });

  it('allows allocations from different payments that stay within the invoice total', async () => {
    const invoice = await invoices.create({
      invoiceNumber: 'INV-CAP-2',
      subtotal: 100,
      taxAmount: 0,
      totalAmount: 100,
    });
    await invoice.save();

    const p1 = await payments.create({ amount: 100, currency: 'USD' });
    await p1.save();
    const p2 = await payments.create({ amount: 100, currency: 'USD' });
    await p2.save();

    const a1 = await allocations.create({
      paymentId: p1.id,
      invoiceId: invoice.id,
      amount: 60,
    });
    await expect(a1.save()).resolves.toBeTruthy();

    const a2 = await allocations.create({
      paymentId: p2.id,
      invoiceId: invoice.id,
      amount: 40, // 60 + 40 = 100 == total, allowed
    });
    await expect(a2.save()).resolves.toBeTruthy();
  });

  // Round-2 [P2 zero-total]: a freshly-created total=0 invoice must SKIP the
  // invoice-total cap (the documented "zero/missing total skips the cap"
  // intent), not be capped at 0. `Number.isFinite(0) === true`, so the prior
  // `isFinite` guard wrongly fired `over-pay invoice` for any allocation
  // against a total=0 invoice; the `> ALLOCATION_EPSILON` gate skips it.
  it('does not throw when allocating against a total=0 invoice', async () => {
    const invoice = await invoices.create({
      invoiceNumber: 'INV-ZERO',
      subtotal: 0,
      taxAmount: 0,
      totalAmount: 0,
    });
    await invoice.save();
    expect(invoice.totalAmount).toBe(0);

    // Payment large enough to clear the per-payment cap, so ONLY the
    // invoice-total cap could (wrongly) reject here.
    const payment = await payments.create({ amount: 50, currency: 'USD' });
    await payment.save();

    const allocation = await allocations.create({
      paymentId: payment.id,
      invoiceId: invoice.id,
      amount: 50,
    });
    await expect(allocation.save()).resolves.toBeTruthy();
  });
});
