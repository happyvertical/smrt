/**
 * Regression tests for the S5 financial-integrity audit findings (#1390).
 *
 * Each `describe` block maps to a finding from the audit:
 *
 *  1. Invoice totals are recomputed from line items / arithmetic-validated on
 *     save; forged totals, negative amounts, and an amountPaid above the total
 *     are rejected; amountPaid is derived from PaymentAllocations.
 *  2. Financial mutations (`send`, `recognizeRevenue`, `recordPayment`) are not
 *     exposed over MCP — asserted against the generated manifest.
 *  3. PaymentIntent cannot persist a PAID status unless backed by a real,
 *     COMPLETED, amount-matching Payment.
 *  4. PaymentAllocation rejects non-positive amounts and over-applying a
 *     payment; `create`/`delete` are not exposed on the generated API surface.
 *  5. Payout rejects negative grossAmount/operatorFee/supplierNet.
 *  6. Contract / LicenseSale reject illegal status transitions on save.
 *
 * Uses real in-memory SQLite (no DB mocking), per repo testing conventions.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(here, '..', '..', 'dist', 'manifest.json');

import { ContractCollection } from '../collections/ContractCollection.js';
import { InvoiceCollection } from '../collections/InvoiceCollection.js';
import { InvoiceLineItemCollection } from '../collections/InvoiceLineItemCollection.js';
import { PaymentAllocationCollection } from '../collections/PaymentAllocationCollection.js';
import { PaymentCollection } from '../collections/PaymentCollection.js';
import { PaymentIntentCollection } from '../collections/PaymentIntentCollection.js';
import { PayoutCollection } from '../collections/PayoutCollection.js';
import {
  ContractStatus,
  ContractType,
  InvoiceStatus,
  PaymentIntentStatus,
  type PaymentOption,
  PaymentStatus,
} from '../types/index.js';

function tmpDb(tag: string): string {
  return join(
    tmpdir(),
    `smrt-sec-1390-${tag}-${Date.now()}-${Math.random()}.db`,
  );
}

// ---------------------------------------------------------------------------
// Finding 1 + 6 (Invoice): totals recomputed; non-negativity; status guard
// ---------------------------------------------------------------------------

describe('Invoice save-time financial-integrity guard (#1390)', () => {
  let dbPath: string;
  let invoices: InvoiceCollection;
  let lineItems: InvoiceLineItemCollection;
  let allocations: PaymentAllocationCollection;
  let payments: PaymentCollection;

  beforeEach(async () => {
    dbPath = tmpDb('invoice');
    invoices = await InvoiceCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    lineItems = await InvoiceLineItemCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    allocations = await PaymentAllocationCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    payments = await PaymentCollection.create({
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

  it('recomputes subtotal/tax/total from line items, overriding caller totals', async () => {
    const invoice = await invoices.create({
      invoiceNumber: 'INV-RECOMPUTE',
      subtotal: 0,
      taxAmount: 0,
      totalAmount: 0,
    });
    await invoice.save();

    // 2 units @ $100, 5% tax => subtotal 200, tax 10, total 210
    const li = await lineItems.create({
      invoiceId: invoice.id,
      description: 'Widgets',
      quantity: 2,
      unitPrice: 100,
      taxRate: 0.05,
    });
    li.amount = li.calculateAmount();
    await li.save();

    // Caller submits the *correct* total — accepted and snapped to line items.
    invoice.totalAmount = 210;
    await invoice.save();
    expect(invoice.subtotal).toBeCloseTo(200);
    expect(invoice.taxAmount).toBeCloseTo(10);
    expect(invoice.totalAmount).toBeCloseTo(210);
  });

  it('rejects a forged total that disagrees with the line items', async () => {
    const invoice = await invoices.create({
      invoiceNumber: 'INV-FORGED',
      totalAmount: 0,
    });
    await invoice.save();

    const li = await lineItems.create({
      invoiceId: invoice.id,
      description: 'Service',
      quantity: 10,
      unitPrice: 100, // line total 1000
    });
    li.amount = li.calculateAmount();
    await li.save();

    // Attacker claims the invoice is only worth $1 despite $1000 of line items.
    invoice.totalAmount = 1;
    await expect(invoice.save()).rejects.toThrow(/does not match line-item/);
  });

  it('rejects negative amounts', async () => {
    // `collection.create()` persists (calls save internally), so the guard
    // fires there.
    await expect(
      invoices.create({
        invoiceNumber: 'INV-NEG',
        subtotal: -100,
        taxAmount: 0,
        totalAmount: -100,
      }),
    ).rejects.toThrow(/non-negative/);
  });

  it('enforces totalAmount === subtotal + taxAmount when there are no line items', async () => {
    await expect(
      invoices.create({
        invoiceNumber: 'INV-ARITH',
        subtotal: 100,
        taxAmount: 5,
        totalAmount: 9999, // does not equal 105
      }),
    ).rejects.toThrow(/must equal subtotal/);
  });

  it('derives amountPaid from PaymentAllocations rather than trusting the caller', async () => {
    const invoice = await invoices.create({
      invoiceNumber: 'INV-PAID',
      subtotal: 100,
      taxAmount: 0,
      totalAmount: 100,
    });
    await invoice.save();

    const payment = await payments.create({ amount: 40, currency: 'USD' });
    await payment.save();
    const alloc = await allocations.create({
      paymentId: payment.id,
      invoiceId: invoice.id,
      amount: 40,
    });
    await alloc.save();

    // Caller tries to claim the invoice is fully paid; the guard re-derives
    // amountPaid from the single $40 allocation.
    invoice.amountPaid = 100;
    await invoice.save();
    expect(invoice.amountPaid).toBeCloseTo(40);
  });

  it('rejects an illegal status flip done via raw assignment', async () => {
    const invoice = await invoices.create({
      invoiceNumber: 'INV-STATUS',
      subtotal: 100,
      taxAmount: 0,
      totalAmount: 100,
      status: InvoiceStatus.DRAFT,
    });
    await invoice.save();

    // DRAFT → PAID is not a legal direct transition.
    invoice.status = InvoiceStatus.PAID;
    await expect(invoice.save()).rejects.toThrow(/illegal status transition/);
  });

  it('allows the guarded markSent transition (DRAFT → SENT)', async () => {
    const invoice = await invoices.create({
      invoiceNumber: 'INV-SENT',
      subtotal: 100,
      taxAmount: 0,
      totalAmount: 100,
    });
    await invoice.save();

    invoice.markSent();
    await expect(invoice.save()).resolves.toBeDefined();
    expect(invoice.status).toBe(InvoiceStatus.SENT);
  });
});

// ---------------------------------------------------------------------------
// Finding 2: MCP does not expose financial mutations
// ---------------------------------------------------------------------------

describe('MCP surface excludes financial mutations (#1390)', () => {
  it('Invoice/Payment manifests do not expose send/recognizeRevenue/recordPayment over MCP', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const objects: Record<string, any> = manifest.objects;

    const mcpInclude = (name: string): string[] => {
      const obj = objects[`@happyvertical/smrt-commerce:${name}`];
      expect(obj).toBeTruthy();
      return obj.decoratorConfig?.mcp?.include ?? [];
    };

    const invoiceMcp = mcpInclude('Invoice');
    const paymentMcp = mcpInclude('Payment');

    expect(invoiceMcp).not.toContain('send');
    expect(invoiceMcp).not.toContain('recognizeRevenue');
    expect(paymentMcp).not.toContain('recordPayment');
  });
});

// ---------------------------------------------------------------------------
// Finding 3: PaymentIntent PAID must be backed by a real COMPLETED Payment
// ---------------------------------------------------------------------------

describe('PaymentIntent PAID requires a verified Payment (#1390)', () => {
  let dbPath: string;
  let intents: PaymentIntentCollection;
  let payments: PaymentCollection;

  const usdcOption: PaymentOption = {
    backendId: 'base-usdc',
    currency: 'USDC-base',
    chain: 'base',
    payTo: '0xabc0000000000000000000000000000000000001',
    nativeAmount: 199.0,
  };

  beforeEach(async () => {
    dbPath = tmpDb('intent');
    intents = await PaymentIntentCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    payments = await PaymentCollection.create({
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

  async function newIntent() {
    const intent = await intents.create({
      offeringRef: 'sku-sec',
      licenseeEmail: 'b@example.test',
      idempotencyKey: `idem-${Math.random()}`,
      usdPriceLocked: 199,
      paymentOptions: [usdcOption],
    });
    await intent.save();
    return intent;
  }

  it('rejects saving a PAID intent whose Payment does not exist', async () => {
    const intent = await newIntent();
    intent.markPaid({ backendId: 'base-usdc', paymentId: 'does-not-exist' });
    await expect(intent.save()).rejects.toThrow(/does not exist/);
  });

  it('rejects saving a PAID intent whose Payment is not COMPLETED', async () => {
    const intent = await newIntent();
    const pending = await payments.create({
      amount: 199,
      currency: 'USDC-base',
      nativeAmount: 199,
      nativeCurrency: 'USDC-base',
      status: PaymentStatus.PENDING,
    });
    await pending.save();
    intent.markPaid({ backendId: 'base-usdc', paymentId: pending.id });
    await expect(intent.save()).rejects.toThrow(/not COMPLETED/);
  });

  it('rejects saving a PAID intent whose Payment amount does not match the option', async () => {
    const intent = await newIntent();
    const wrong = await payments.create({
      amount: 5,
      currency: 'USDC-base',
      nativeAmount: 5, // option quoted 199
      nativeCurrency: 'USDC-base',
      status: PaymentStatus.COMPLETED,
    });
    await wrong.save();
    intent.markPaid({ backendId: 'base-usdc', paymentId: wrong.id });
    await expect(intent.save()).rejects.toThrow(/does not match option/);
  });

  it('accepts a PAID intent backed by a real, COMPLETED, matching Payment', async () => {
    const intent = await newIntent();
    const good = await payments.create({
      amount: 199,
      currency: 'USDC-base',
      nativeAmount: 199,
      nativeCurrency: 'USDC-base',
      status: PaymentStatus.COMPLETED,
    });
    await good.save();
    await intent.verifyAndMarkPaid({
      backendId: 'base-usdc',
      paymentId: good.id,
    });
    await expect(intent.save()).resolves.toBeDefined();
    expect(intent.status).toBe(PaymentIntentStatus.PAID);

    const loaded = await intents.get({ id: intent.id });
    expect(loaded?.status).toBe(PaymentIntentStatus.PAID);
  });

  it('verifyAndMarkPaid surfaces verification failures before mutating status', async () => {
    const intent = await newIntent();
    await expect(
      intent.verifyAndMarkPaid({ backendId: 'base-usdc', paymentId: 'nope' }),
    ).rejects.toThrow(/does not exist/);
    // status was not advanced
    expect(intent.status).toBe(PaymentIntentStatus.AWAITING_PAYMENT);
    expect(intent.paymentId).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Finding 4: PaymentAllocation positivity + over-allocation cap
// ---------------------------------------------------------------------------

describe('PaymentAllocation integrity guard (#1390)', () => {
  let dbPath: string;
  let allocations: PaymentAllocationCollection;
  let payments: PaymentCollection;
  let invoices: InvoiceCollection;

  beforeEach(async () => {
    dbPath = tmpDb('alloc');
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

  async function seedPaymentAndInvoice(amount: number) {
    const payment = await payments.create({ amount, currency: 'USD' });
    await payment.save();
    const invoice = await invoices.create({
      invoiceNumber: `INV-ALLOC-${Math.random()}`,
      subtotal: amount,
      taxAmount: 0,
      totalAmount: amount,
    });
    await invoice.save();
    return { payment, invoice };
  }

  it('rejects a non-positive allocation amount', async () => {
    const { payment, invoice } = await seedPaymentAndInvoice(100);
    await expect(
      allocations.create({
        paymentId: payment.id,
        invoiceId: invoice.id,
        amount: 0,
      }),
    ).rejects.toThrow(/positive number/);
  });

  it('rejects allocating more than the payment amount across allocations', async () => {
    const { payment, invoice } = await seedPaymentAndInvoice(100);

    const first = await allocations.create({
      paymentId: payment.id,
      invoiceId: invoice.id,
      amount: 80,
    });
    await first.save();

    // Second allocation of 50 would push total to 130 > 100 — `create`
    // persists, so the over-apply guard fires there.
    await expect(
      allocations.create({
        paymentId: payment.id,
        invoiceId: invoice.id,
        amount: 50,
      }),
    ).rejects.toThrow(/over-apply/);
  });

  it('allows allocations that stay within the payment amount', async () => {
    const { payment, invoice } = await seedPaymentAndInvoice(100);
    const alloc = await allocations.create({
      paymentId: payment.id,
      invoiceId: invoice.id,
      amount: 100,
    });
    await expect(alloc.save()).resolves.toBeDefined();
  });

  it('does not expose create/delete on the generated API surface', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const obj =
      manifest.objects['@happyvertical/smrt-commerce:PaymentAllocation'];
    expect(obj).toBeTruthy();
    const apiInclude: string[] = obj.decoratorConfig?.api?.include ?? [];
    expect(apiInclude).not.toContain('create');
    expect(apiInclude).not.toContain('delete');
  });
});

// ---------------------------------------------------------------------------
// Finding 5: Payout non-negativity
// ---------------------------------------------------------------------------

describe('Payout non-negativity guard (#1390)', () => {
  let dbPath: string;
  let payouts: PayoutCollection;

  beforeEach(async () => {
    dbPath = tmpDb('payout');
    payouts = await PayoutCollection.create({
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

  it('rejects a negative operatorFee', async () => {
    // gross=100, fee=-10 => net would need to be 110 to satisfy the invariant,
    // i.e. paying out MORE than was taken in. The negativity guard refuses it.
    // `create` persists (calls save), so the guard fires there.
    await expect(
      payouts.create({
        paymentId: 'pmt-neg-fee',
        vendorId: 'vendor-neg',
        grossAmount: 100,
        operatorFee: -10,
        supplierNet: 110,
        currency: 'USD',
        backendId: 'stripe',
      }),
    ).rejects.toThrow(/non-negative/);
  });

  it('rejects a negative grossAmount', async () => {
    await expect(
      payouts.create({
        paymentId: 'pmt-neg-gross',
        vendorId: 'vendor-neg',
        grossAmount: -100,
        operatorFee: 0,
        supplierNet: -100,
        currency: 'USD',
        backendId: 'stripe',
      }),
    ).rejects.toThrow(/non-negative/);
  });

  it('still accepts a valid non-negative split', async () => {
    const payout = await payouts.create({
      paymentId: 'pmt-ok',
      vendorId: 'vendor-ok',
      grossAmount: 100,
      operatorFee: 10,
      supplierNet: 90,
      currency: 'USD',
      backendId: 'stripe',
    });
    await expect(payout.save()).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Finding 6: Contract / LicenseSale status-transition guard
// ---------------------------------------------------------------------------

describe('Contract status-transition guard (#1390)', () => {
  let dbPath: string;
  let contracts: ContractCollection;

  beforeEach(async () => {
    dbPath = tmpDb('contract');
    contracts = await ContractCollection.create({
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

  it('rejects reviving a terminal (declined) contract back to accepted', async () => {
    const contract = await contracts.create({
      contractType: ContractType.ORDER,
      status: ContractStatus.DRAFT,
      totalAmount: 100,
    });
    await contract.save();

    contract.status = ContractStatus.SENT;
    await contract.save();
    contract.status = ContractStatus.DECLINED;
    await contract.save();

    // DECLINED is terminal — forcing it back to ACCEPTED must throw.
    contract.status = ContractStatus.ACCEPTED;
    await expect(contract.save()).rejects.toThrow(/illegal status transition/);
  });

  it('rejects jumping a completed contract back to draft', async () => {
    const contract = await contracts.create({
      contractType: ContractType.ORDER,
      status: ContractStatus.ACCEPTED,
      totalAmount: 100,
    });
    await contract.save();

    contract.status = ContractStatus.COMPLETED;
    await contract.save();

    contract.status = ContractStatus.DRAFT;
    await expect(contract.save()).rejects.toThrow(/illegal status transition/);
  });

  it('allows the normal DRAFT → SENT → ACCEPTED → COMPLETED path', async () => {
    const contract = await contracts.create({
      contractType: ContractType.ORDER,
      status: ContractStatus.DRAFT,
      totalAmount: 100,
    });
    await contract.save();

    for (const next of [
      ContractStatus.SENT,
      ContractStatus.ACCEPTED,
      ContractStatus.COMPLETED,
    ]) {
      contract.status = next;
      await expect(contract.save()).resolves.toBeDefined();
    }
  });
});
