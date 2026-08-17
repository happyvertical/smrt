/**
 * PostgreSQL round-trip proof for the money columns fixed in #2361.
 *
 * `subtotal: number = 0` compiled to an INTEGER column, and PostgreSQL rejects
 * `19.99` there with `22P02 invalid input syntax for type integer`. SQLite's
 * type affinity stores the REAL anyway, which is why every SQLite suite in this
 * package passed while the same save failed in production. Only a real
 * PostgreSQL lane can hold that line, so this file is the lane.
 *
 * These use `baseDb` rather than the transaction handle: `Invoice.save()`
 * constructs a `PaymentAllocationCollection` of its own from `this.options`,
 * and a nested collection built on a transaction handle does not share its
 * scope.
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

  it('declares every money column as a floating-point type, not integer', async () => {
    const result = await db.query(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
       WHERE (table_name = 'invoices'
              AND column_name IN ('subtotal', 'tax_amount', 'total_amount', 'amount_paid'))
          OR (table_name = 'invoice_line_items'
              AND column_name IN ('quantity', 'unit_price', 'discount', 'tax_rate', 'amount'))
          OR (table_name = 'payment_allocations' AND column_name = 'amount')
       ORDER BY table_name, column_name`,
    );

    const rows = result.rows as {
      table_name: string;
      column_name: string;
      data_type: string;
    }[];

    expect(rows).toHaveLength(10);
    for (const row of rows) {
      expect(row.data_type, `${row.table_name}.${row.column_name}`).toMatch(
        /double precision|real|numeric/,
      );
    }
  });

  it('round-trips fractional invoice amounts that an INTEGER column rejected', async () => {
    const invoice = await invoices.create({
      invoiceNumber: 'INV-2361-FRACTIONAL',
      subtotal: 19.99,
      taxAmount: 1.6,
      totalAmount: 21.59,
    });

    const reloaded = await invoices.get(invoice.id);
    expect(reloaded).toBeTruthy();
    expect(reloaded?.subtotal).toBeCloseTo(19.99, 6);
    expect(reloaded?.taxAmount).toBeCloseTo(1.6, 6);
    expect(reloaded?.totalAmount).toBeCloseTo(21.59, 6);
  });

  it('round-trips fractional line-item price, discount, tax rate and quantity', async () => {
    const invoice = await invoices.create({ invoiceNumber: 'INV-2361-LINES' });

    const lineItem = await lineItems.create({
      invoiceId: invoice.id,
      description: 'Consulting',
      // Billable hours are fractional, which is why `quantity` moved off the
      // integer heuristic alongside the money fields.
      quantity: 2.5,
      unitPrice: 149.99,
      discount: 12.34,
      taxRate: 0.0825,
      amount: 362.64,
    });

    const reloaded = await lineItems.get(lineItem.id);
    expect(reloaded?.quantity).toBeCloseTo(2.5, 6);
    expect(reloaded?.unitPrice).toBeCloseTo(149.99, 6);
    expect(reloaded?.discount).toBeCloseTo(12.34, 6);
    expect(reloaded?.taxRate).toBeCloseTo(0.0825, 6);
    expect(reloaded?.amount).toBeCloseTo(362.64, 6);
  });

  it('round-trips a fractional allocation and derives amountPaid from it', async () => {
    const invoice = await invoices.create({
      invoiceNumber: 'INV-2361-ALLOCATION',
      subtotal: 21.59,
      taxAmount: 0.0,
      totalAmount: 21.59,
    });

    const payment = await payments.create({
      paymentNumber: 'PAY-2361',
      amount: 21.59,
    });

    const allocation = await allocations.create({
      paymentId: payment.id,
      invoiceId: invoice.id,
      amount: 21.59,
    });

    expect((await allocations.get(allocation.id))?.amount).toBeCloseTo(
      21.59,
      6,
    );

    // `amountPaid` is derived from allocations on a persisted save, so this is
    // the only path that can write a fractional value into that column.
    await invoice.save();
    expect((await invoices.get(invoice.id))?.amountPaid).toBeCloseTo(21.59, 6);
  });
});
