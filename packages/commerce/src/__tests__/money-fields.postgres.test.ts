/**
 * PostgreSQL lane for commerce money and rate columns (#2361).
 *
 * Money in this package is **integer minor units** (cents, satoshis) — `$19.99`
 * is `1999`. That is what the INTEGER columns encode, and it is exact, so the
 * lane's job is to prove two things a SQLite-only suite cannot:
 *
 *  1. the money columns really are INTEGER and integer minor units round-trip;
 *  2. a fractional *major-unit* write — the actual bug behind this issue — is
 *     rejected rather than silently stored, as SQLite's type affinity does.
 *
 * Genuine rates (`taxRate`) are the opposite case: inherently fractional, so
 * they must be DECIMAL or every rate truncates to 0.
 */

import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InvoiceCollection } from '../collections/InvoiceCollection.js';
import { InvoiceLineItemCollection } from '../collections/InvoiceLineItemCollection.js';
import { PaymentAllocationCollection } from '../collections/PaymentAllocationCollection.js';
import { PaymentCollection } from '../collections/PaymentCollection.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

describePostgres('commerce money columns on PostgreSQL (#2361)', () => {
  let isolated: IsolatedTestDbResult | undefined;
  let db: DatabaseInterface;
  let invoices: InvoiceCollection;
  let lineItems: InvoiceLineItemCollection;
  let allocations: PaymentAllocationCollection;
  let payments: PaymentCollection;

  beforeEach(async () => {
    isolated = await createIsolatedTestDbFromManifest({
      includeObjects: [
        'Invoice',
        'InvoiceLineItem',
        'Payment',
        'PaymentAllocation',
      ],
    });
    if (isolated.config.type !== 'postgres') {
      throw new Error('Expected a PostgreSQL test database');
    }
    // `Invoice.save()` builds a PaymentAllocationCollection of its own from
    // `this.options`, which a transaction handle would not share.
    db = isolated.baseDb;
    invoices = await InvoiceCollection.create({ db });
    lineItems = await InvoiceLineItemCollection.create({ db });
    allocations = await PaymentAllocationCollection.create({ db });
    payments = await PaymentCollection.create({ db });
  });

  afterEach(async () => {
    await isolated?.cleanup();
    isolated = undefined;
  });

  it('declares money columns INTEGER and rate columns floating-point', async () => {
    const result = await db.query(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
       WHERE (table_name = 'invoices'
              AND column_name IN ('subtotal', 'tax_amount', 'total_amount', 'amount_paid'))
          OR (table_name = 'invoice_line_items'
              AND column_name IN ('unit_price', 'discount', 'amount', 'tax_rate'))
          OR (table_name = 'payment_allocations' AND column_name = 'amount')
       ORDER BY table_name, column_name`,
    );

    const byColumn = Object.fromEntries(
      (
        result.rows as {
          table_name: string;
          column_name: string;
          data_type: string;
        }[]
      ).map((row) => [`${row.table_name}.${row.column_name}`, row.data_type]),
    );

    for (const column of [
      'invoices.subtotal',
      'invoices.tax_amount',
      'invoices.total_amount',
      'invoices.amount_paid',
      'invoice_line_items.unit_price',
      'invoice_line_items.discount',
      'invoice_line_items.amount',
      'payment_allocations.amount',
    ]) {
      expect(byColumn[column], column).toMatch(/integer|bigint/);
    }

    // A rate is inherently fractional; INTEGER here would truncate 0.0825 to 0.
    expect(byColumn['invoice_line_items.tax_rate']).toMatch(
      /double precision|real|numeric/,
    );
  });

  it('round-trips invoice amounts as exact integer minor units', async () => {
    // $19.99 + $1.60 tax = $21.59, expressed as cents.
    const invoice = await invoices.create({
      invoiceNumber: 'INV-2361-MINOR-UNITS',
      subtotal: 1999,
      taxAmount: 160,
      totalAmount: 2159,
    });

    const reloaded = await invoices.get(invoice.id);
    expect(reloaded).toBeTruthy();
    // Exact equality, not toBeCloseTo — that is the point of minor units.
    expect(reloaded?.subtotal).toBe(1999);
    expect(reloaded?.taxAmount).toBe(160);
    expect(reloaded?.totalAmount).toBe(2159);
  });

  it('rejects a fractional major-unit write instead of silently storing it', async () => {
    // This is the bug from the issue: `19.99` into a minor-units column.
    // PostgreSQL refuses it (22P02); SQLite's affinity would store it and hide
    // the mistake. Catching it before the database is the desired end state —
    // see the note in the PR: that guard cannot land until `Payment.amount`
    // moves to minor units alongside `PaymentAllocation.amount`.
    await expect(
      invoices.create({
        invoiceNumber: 'INV-2361-FRACTIONAL',
        subtotal: 19.99,
        taxAmount: 0,
        totalAmount: 19.99,
      }),
    ).rejects.toThrow();
  });

  it('round-trips line-item minor units alongside a fractional tax rate', async () => {
    const invoice = await invoices.create({ invoiceNumber: 'INV-2361-LINES' });

    const lineItem = await lineItems.create({
      invoiceId: invoice.id,
      description: 'Consulting',
      quantity: 2,
      unitPrice: 14999, // $149.99
      discount: 1234, // $12.34
      taxRate: 0.0825, // 8.25% — a rate, so genuinely fractional
      amount: 28764, // 2 * 14999 - 1234
    });

    const reloaded = await lineItems.get(lineItem.id);
    expect(reloaded?.quantity).toBe(2);
    expect(reloaded?.unitPrice).toBe(14999);
    expect(reloaded?.discount).toBe(1234);
    expect(reloaded?.amount).toBe(28764);
    expect(reloaded?.taxRate).toBeCloseTo(0.0825, 6);
  });

  it('round-trips an allocation and derives amountPaid from it', async () => {
    const invoice = await invoices.create({
      invoiceNumber: 'INV-2361-ALLOCATION',
      subtotal: 2159,
      taxAmount: 0,
      totalAmount: 2159,
    });

    // `PaymentAllocation.save()` caps the allocation against the persisted
    // `Payment.amount`, so both sides must be in the same units. `Payment` is
    // still a DECIMAL column (out of scope here), which is exactly why that
    // pair has to convert together.
    const payment = await payments.create({
      paymentNumber: 'PAY-2361',
      amount: 2159,
    });

    const allocation = await allocations.create({
      paymentId: payment.id,
      invoiceId: invoice.id,
      amount: 2159,
    });

    expect((await allocations.get(allocation.id))?.amount).toBe(2159);

    await invoice.save();
    expect((await invoices.get(invoice.id))?.amountPaid).toBe(2159);
  });
});
