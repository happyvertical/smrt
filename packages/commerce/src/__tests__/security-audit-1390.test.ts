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
  PayoutStatus,
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

// ---------------------------------------------------------------------------
// Round 2, Finding 1 (Payment): COMPLETED is settlement-gated; an existing
// row cannot be raw-promoted to COMPLETED, so a forged COMPLETED Payment can't
// satisfy PaymentIntent's PAID verification.
// ---------------------------------------------------------------------------

describe('Payment COMPLETED settlement guard (#1390 round 2)', () => {
  let dbPath: string;
  let payments: PaymentCollection;

  beforeEach(async () => {
    dbPath = tmpDb('payment-complete');
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

  it('rejects raw-promoting a persisted PENDING payment to COMPLETED', async () => {
    const payment = await payments.create({
      amount: 199,
      currency: 'USD',
      status: PaymentStatus.PENDING,
    });
    await payment.save();

    // Reload so the instance carries a persisted prior status of PENDING (the
    // exact shape a generated REST update mutates).
    const loaded = await payments.get({ id: payment.id });
    expect(loaded).toBeTruthy();
    (loaded as any).status = PaymentStatus.COMPLETED;
    await expect((loaded as any).save()).rejects.toThrow(
      /cannot promote an existing payment to COMPLETED/,
    );

    // The persisted row is untouched.
    const reloaded = await payments.get({ id: payment.id });
    expect(reloaded?.status).toBe(PaymentStatus.PENDING);
  });

  it('rejects an illegal status transition on an existing payment', async () => {
    const payment = await payments.create({
      amount: 50,
      currency: 'USD',
      status: PaymentStatus.PENDING,
    });
    await payment.save();
    payment.markFailed('card declined');
    await payment.save();

    // FAILED is terminal — forcing it back to PENDING must throw.
    payment.status = PaymentStatus.PENDING;
    await expect(payment.save()).rejects.toThrow(/illegal status transition/);
  });
});

// ---------------------------------------------------------------------------
// Round 2, Finding 2 (PaymentIntent): an already-PAID intent cannot be
// repointed to a bogus Payment, and ISSUED must stay backed.
// ---------------------------------------------------------------------------

describe('PaymentIntent repoint / issued guard (#1390 round 2)', () => {
  let dbPath: string;
  let intents: PaymentIntentCollection;
  let payments: PaymentCollection;

  const usdcOption: PaymentOption = {
    backendId: 'base-usdc',
    currency: 'USDC-base',
    chain: 'base',
    payTo: '0xabc0000000000000000000000000000000000002',
    nativeAmount: 199.0,
  };

  beforeEach(async () => {
    dbPath = tmpDb('intent-repoint');
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

  async function paidIntent() {
    const intent = await intents.create({
      offeringRef: 'sku-repoint',
      licenseeEmail: 'c@example.test',
      idempotencyKey: `idem-${Math.random()}`,
      usdPriceLocked: 199,
      paymentOptions: [usdcOption],
    });
    await intent.save();
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
    await intent.save();
    return { intent, good };
  }

  it('rejects repointing an already-PAID intent to a non-existent Payment', async () => {
    const { intent } = await paidIntent();
    expect(intent.status).toBe(PaymentIntentStatus.PAID);

    // Status stays PAID (a no-op transition) but the backing paymentId is
    // swapped to a bogus row — round 1 only verified the transition edge, so
    // this previously slipped through. It must now be rejected.
    intent.paymentId = 'totally-bogus';
    await expect(intent.save()).rejects.toThrow(/does not exist/);
  });

  it('keeps ISSUED backed by the original verified Payment', async () => {
    const { intent } = await paidIntent();
    intent.markIssued();
    await expect(intent.save()).resolves.toBeDefined();
    expect(intent.status).toBe(PaymentIntentStatus.ISSUED);

    // Now repoint the ISSUED intent at a bogus payment — must be rejected.
    intent.paymentId = 'nope';
    await expect(intent.save()).rejects.toThrow(/does not exist/);
  });

  it('rejects an illegal status skip (awaiting_payment → issued)', async () => {
    const intent = await intents.create({
      offeringRef: 'sku-skip',
      licenseeEmail: 'd@example.test',
      idempotencyKey: `idem-${Math.random()}`,
      usdPriceLocked: 199,
      paymentOptions: [usdcOption],
    });
    await intent.save();

    // Force the status straight to ISSUED, skipping PAID entirely.
    intent.status = PaymentIntentStatus.ISSUED;
    await expect(intent.save()).rejects.toThrow(/illegal status transition/);
  });
});

// ---------------------------------------------------------------------------
// Round 2, Finding 3 (Invoice): status reconciled against derived amountPaid;
// new invoices can't start PAID.
// ---------------------------------------------------------------------------

describe('Invoice payment-status reconciliation (#1390 round 2)', () => {
  let dbPath: string;
  let invoices: InvoiceCollection;

  beforeEach(async () => {
    dbPath = tmpDb('invoice-reconcile');
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

  it('rejects a raw SENT → PAID flip with no allocations (amountPaid stays 0)', async () => {
    const invoice = await invoices.create({
      invoiceNumber: 'INV-SENT-PAID',
      subtotal: 100,
      taxAmount: 0,
      totalAmount: 100,
    });
    await invoice.save();
    invoice.markSent();
    await invoice.save();

    // No PaymentAllocations exist, so derived amountPaid is 0 — claiming PAID
    // is inconsistent and must be rejected.
    invoice.status = InvoiceStatus.PAID;
    await expect(invoice.save()).rejects.toThrow(
      /status is PAID but derived amountPaid/,
    );
  });

  it('rejects a new invoice that starts PAID', async () => {
    await expect(
      invoices.create({
        invoiceNumber: 'INV-NEW-PAID',
        subtotal: 100,
        taxAmount: 0,
        totalAmount: 100,
        amountPaid: 100,
        status: InvoiceStatus.PAID,
      }),
    ).rejects.toThrow(/a new invoice cannot start/);
  });

  it('forces a new invoice to start with amountPaid = 0', async () => {
    const invoice = await invoices.create({
      invoiceNumber: 'INV-NEW-UNPAID',
      subtotal: 100,
      taxAmount: 0,
      totalAmount: 100,
      amountPaid: 75, // caller-supplied — must be ignored on create
    });
    expect(invoice.amountPaid).toBe(0);
    expect(invoice.status).toBe(InvoiceStatus.DRAFT);
  });
});

// ---------------------------------------------------------------------------
// Round 2, Finding 4 (Payout): state-machine transitions + source-payment cap.
// ---------------------------------------------------------------------------

describe('Payout state-machine + cap guard (#1390 round 2)', () => {
  let dbPath: string;
  let payouts: PayoutCollection;
  let payments: PaymentCollection;

  beforeEach(async () => {
    dbPath = tmpDb('payout-sm');
    payouts = await PayoutCollection.create({
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

  it('rejects a raw pending → confirmed skip on an existing payout', async () => {
    const payout = await payouts.create({
      paymentId: 'pmt-skip-confirm',
      vendorId: 'vendor-skip',
      grossAmount: 100,
      operatorFee: 10,
      supplierNet: 90,
      currency: 'USD',
      backendId: 'stripe',
    });
    await payout.save();

    // Raw mass-assign straight to CONFIRMED, skipping SENT.
    payout.status = PayoutStatus.CONFIRMED;
    await expect(payout.save()).rejects.toThrow(/illegal status transition/);
  });

  it('rejects a SENT payout without a backendTxRef', async () => {
    const payout = await payouts.create({
      paymentId: 'pmt-sent-notx',
      vendorId: 'vendor-sent',
      grossAmount: 100,
      operatorFee: 10,
      supplierNet: 90,
      currency: 'USD',
      backendId: 'stripe',
    });
    await payout.save();

    // Force SENT without going through markSent() (which would require a ref).
    payout.status = PayoutStatus.SENT;
    await expect(payout.save()).rejects.toThrow(/requires a backendTxRef/);
  });

  it('caps grossAmount against the source Payment funded amount', async () => {
    const payment = await payments.create({
      amount: 100,
      currency: 'USD',
    });
    await payment.save();

    // Payout claims to remit 500 against a payment that only brought in 100.
    await expect(
      payouts.create({
        paymentId: payment.id,
        vendorId: 'vendor-over',
        grossAmount: 500,
        operatorFee: 50,
        supplierNet: 450,
        currency: 'USD',
        backendId: 'stripe',
      }),
    ).rejects.toThrow(/exceeds the source Payment/);
  });

  it('allows a payout within the source Payment funded amount', async () => {
    const payment = await payments.create({ amount: 100, currency: 'USD' });
    await payment.save();
    const payout = await payouts.create({
      paymentId: payment.id,
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
// Round 2, Finding 6 (PaymentAllocation): missing Payment is a hard error.
// ---------------------------------------------------------------------------

describe('PaymentAllocation missing-Payment hard error (#1390 round 2)', () => {
  let dbPath: string;
  let allocations: PaymentAllocationCollection;
  let invoices: InvoiceCollection;

  beforeEach(async () => {
    dbPath = tmpDb('alloc-missing');
    allocations = await PaymentAllocationCollection.create({
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

  it('rejects an allocation whose referenced Payment does not exist', async () => {
    const invoice = await invoices.create({
      invoiceNumber: 'INV-ALLOC-MISSING',
      subtotal: 100,
      taxAmount: 0,
      totalAmount: 100,
    });
    await invoice.save();

    // No Payment row exists for this id — the cap can't be enforced, so the
    // allocation must be rejected outright rather than silently skipping it.
    await expect(
      allocations.create({
        paymentId: 'no-such-payment',
        invoiceId: invoice.id,
        amount: 100,
      }),
    ).rejects.toThrow(/does not exist/);
  });
});

// ---------------------------------------------------------------------------
// Round 2, Finding 5 (Invoice.recognizeRevenue): fresh totals + rollback.
// ---------------------------------------------------------------------------

describe('Invoice.recognizeRevenue freshness + rollback (#1390 round 2)', () => {
  let dbPath: string;
  let invoices: InvoiceCollection;
  let lineItems: InvoiceLineItemCollection;

  beforeEach(async () => {
    dbPath = tmpDb('recognize');
    invoices = await InvoiceCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    lineItems = await InvoiceLineItemCollection.create({
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

  it('rejects recognizing revenue off a forged total before posting any journal', async () => {
    const invoice = await invoices.create({
      invoiceNumber: 'INV-REV-FORGED',
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

    // Forge a tiny total in memory, then try to recognize revenue. The
    // pre-journal recompute must reject it, and no arJournalId is set.
    invoice.totalAmount = 1;
    await expect(invoice.recognizeRevenue({} as any)).rejects.toThrow(
      /does not match line-item/,
    );
    expect(invoice.arJournalId).toBe('');

    // The persisted invoice carries no journal reference (NULL deserializes as
    // null or empty string depending on the column default).
    const reloaded = await invoices.get({ id: invoice.id });
    expect(reloaded?.arJournalId || '').toBe('');
  });
});
