/**
 * PostgreSQL lane for commerce money and rate columns (#2361, #2401).
 *
 * Money in this package is **integer minor units** (cents, satoshis) — `$19.99`
 * is `1999`. That is what the INTEGER columns encode, and it is exact, so the
 * lane's job is to prove things a SQLite-only suite cannot:
 *
 *  1. the money columns really are INTEGER and integer minor units round-trip;
 *  2. a fractional *major-unit* write — the actual bug behind this issue — is
 *     rejected rather than silently stored, as SQLite's type affinity does;
 *  3. the major-units → minor-units migration converts a legacy table's column
 *     type and rescales its values, rehearsed against real PostgreSQL rather
 *     than asserted from the emitted SQL (#2401).
 *
 * Genuine rates (`taxRate`) are the opposite case: inherently fractional, so
 * they must be DECIMAL or every rate truncates to 0.
 *
 * Named `*.optional.test.ts` because it needs a real external service: the
 * package's `test:postgres` script runs `vitest run optional.test.ts` as a
 * positional filter, so a new PostgreSQL suite needs no script edit and
 * concurrent PRs never conflict on the same one-line script. Without a
 * PostgreSQL URL the whole file skips itself.
 */

import { randomUUID } from 'node:crypto';
import { BackfillTracker } from '@happyvertical/smrt-core/migrations';
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
import { PayoutCollection } from '../collections/PayoutCollection.js';
import { VendorCollection } from '../collections/VendorCollection.js';
import {
  migrateCommerceMoneyToMinorUnits,
  preflightCommerceMoneyMinorUnits,
} from '../migrations/moneyMinorUnits.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

describePostgres('commerce money columns on PostgreSQL (#2361)', () => {
  let isolated: IsolatedTestDbResult | undefined;
  let db: DatabaseInterface;
  let invoices: InvoiceCollection;
  let lineItems: InvoiceLineItemCollection;
  let allocations: PaymentAllocationCollection;
  let payments: PaymentCollection;
  let payouts: PayoutCollection;

  beforeEach(async () => {
    isolated = await createIsolatedTestDbFromManifest({
      includeObjects: [
        'Contract',
        'ContractLineItem',
        'Customer',
        'Invoice',
        'InvoiceLineItem',
        'Payment',
        'PaymentAllocation',
        'PaymentIntent',
        'Payout',
        'Vendor',
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
    payouts = await PayoutCollection.create({ db });
  });

  afterEach(async () => {
    await isolated?.cleanup();
    isolated = undefined;
  });

  it('declares money columns INTEGER and rate columns floating-point', async () => {
    const result = await db.query(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
       WHERE table_name IN ('invoices', 'invoice_line_items',
                            'payment_allocations', 'contracts',
                            'contract_line_items', 'payments', 'payouts',
                            'vendors', 'customers', 'payment_intents')
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
      // Converted by #2401 — these were REAL major units until then.
      'contracts.subtotal',
      'contracts.tax_amount',
      'contracts.total_amount',
      'contract_line_items.unit_price',
      'contract_line_items.discount',
      'contract_line_items.amount',
      'payments.amount',
      'payments.native_amount',
      'payments.usd_at_quote',
      'payments.usd_at_confirmation',
      'payouts.gross_amount',
      'payouts.operator_fee',
      'payouts.supplier_net',
      'vendors.minimum_order_amount',
      'customers.credit_limit',
      'payment_intents.usd_price_locked',
    ]) {
      expect(byColumn[column], column).toMatch(/integer|bigint/);
    }

    // A rate is inherently fractional; INTEGER here would truncate 0.0825 to 0.
    for (const column of [
      'invoice_line_items.tax_rate',
      'contract_line_items.tax_rate',
      // Contract quantities are decimal on purpose (hours, weight, bandwidth).
      'contract_line_items.quantity',
    ]) {
      expect(byColumn[column], column).toMatch(/double precision|real|numeric/);
    }
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

  it('rejects a fractional major-unit write in the model, before the database', async () => {
    // This is the bug from the issue: `19.99` into a minor-units column.
    // PostgreSQL refuses it (22P02) and SQLite's affinity would store it and
    // hide the mistake — so as of #2401 the *model* rejects it first, on every
    // engine, which is what lets every guard downstream compare exactly.
    await expect(
      invoices.create({
        invoiceNumber: 'INV-2361-FRACTIONAL',
        subtotal: 19.99,
        taxAmount: 0,
        totalAmount: 19.99,
      }),
    ).rejects.toThrow(/integer number of minor units/);

    await expect(
      payments.create({ paymentNumber: 'PAY-FRACTIONAL', amount: 21.59 }),
    ).rejects.toThrow(/integer number of minor units/);
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
    // `Payment.amount`. Both are INTEGER minor units as of #2401, so the cap is
    // an exact integer comparison with no tolerance.
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

    // One minor unit over the payment is over-application, not rounding.
    await expect(
      allocations.create({
        paymentId: payment.id,
        invoiceId: invoice.id,
        amount: 1,
      }),
    ).rejects.toThrow(/over-apply/);
  });

  it('round-trips a payout triple and enforces the invariant exactly', async () => {
    const payment = await payments.create({
      paymentNumber: 'PAY-2401-PAYOUT',
      amount: 19900,
      nativeAmount: 19900,
      nativeCurrency: 'USDC-base',
      backendId: 'base-usdc',
    });
    // `Payout.vendorId` is a real foreign key, so the vendor has to exist on a
    // database that actually enforces one.
    const vendors = await VendorCollection.create({ db });
    const vendor = await vendors.create({
      // `profileId` is a cross-package reference, which is a native `uuid`
      // column on PostgreSQL — a readable slug fails with 22P02.
      profileId: randomUUID(),
      minimumOrderAmount: 5000,
    });

    const payout = await payouts.create({
      paymentId: payment.id,
      vendorId: vendor.id,
      grossAmount: 19900,
      operatorFee: 1990,
      supplierNet: 17910,
      currency: 'USDC-base',
      backendId: 'base-usdc',
    });

    const reloaded = await payouts.get(payout.id);
    expect(reloaded?.grossAmount).toBe(19900);
    expect(reloaded?.operatorFee).toBe(1990);
    expect(reloaded?.supplierNet).toBe(17910);
  });
});

describePostgres('commerce money minor-units migration (#2401)', () => {
  let isolated: IsolatedTestDbResult | undefined;
  let db: DatabaseInterface;

  beforeEach(async () => {
    // A bare isolated database: the migration is rehearsed against a *legacy*
    // schema built by hand, i.e. the REAL major-unit columns a deployment that
    // predates #2401 actually has.
    isolated = await createIsolatedTestDbFromManifest({
      includeObjects: ['Invoice'],
    });
    if (isolated.config.type !== 'postgres') {
      throw new Error('Expected a PostgreSQL test database');
    }
    db = isolated.baseDb;
    // `_smrt_backfills` is what makes the migration idempotent, so each case
    // has to start with an empty ledger or the second test's marker would make
    // the third a no-op.
    await db.query('DROP TABLE IF EXISTS _smrt_backfills');
    BackfillTracker.invalidateInitialization(db);
    await db.query('DROP TABLE IF EXISTS payments');
    await db.query(
      `CREATE TABLE payments (
         id TEXT PRIMARY KEY NOT NULL,
         amount DOUBLE PRECISION DEFAULT 0.0,
         native_amount DOUBLE PRECISION DEFAULT 0.0,
         usd_at_quote DOUBLE PRECISION DEFAULT 0.0,
         usd_at_confirmation DOUBLE PRECISION DEFAULT 0.0
       )`,
    );
  });

  afterEach(async () => {
    await isolated?.cleanup();
    isolated = undefined;
  });

  async function seed(rows: Array<[string, number]>): Promise<void> {
    for (const [id, amount] of rows) {
      await db.query(
        'INSERT INTO payments (id, amount, native_amount) VALUES (?, ?, 0)',
        id,
        amount,
      );
    }
  }

  it('preflights a legacy decimal table and reports it as pending', async () => {
    await seed([
      ['p1', 19.99],
      ['p2', 1.6],
    ]);

    const preflight = await preflightCommerceMoneyMinorUnits(db);
    const amountColumn = preflight.columns.find(
      (column) => column.table === 'payments' && column.column === 'amount',
    );

    expect(amountColumn?.state).toBe('pending');
    expect(amountColumn?.inspectedRows).toBe(2);
    expect(preflight.ok).toBe(true);
    // The tables that were already INTEGER since #2361 are not in the target
    // list at all, so nothing here claims to convert them.
    expect(
      preflight.columns.some((column) => column.table === 'invoices'),
    ).toBe(false);
  });

  it('changes the column type and rescales values, and is idempotent', async () => {
    await seed([
      ['p1', 19.99],
      ['p2', 1.6],
    ]);

    const first = await migrateCommerceMoneyToMinorUnits(db);
    expect(first.ran).toBe(true);
    expect(first.declaredTypeChangePending).toEqual([]);

    const type = await db.query(
      `SELECT data_type FROM information_schema.columns
       WHERE table_name = 'payments' AND column_name = 'amount'`,
    );
    expect((type.rows[0] as { data_type: string }).data_type).toBe('integer');

    const rows = await db.query('SELECT id, amount FROM payments ORDER BY id');
    expect(rows.rows).toEqual([
      { id: 'p1', amount: 1999 },
      { id: 'p2', amount: 160 },
    ]);

    const second = await migrateCommerceMoneyToMinorUnits(db);
    expect(second.ran).toBe(false);
    const after = await db.query(
      'SELECT amount FROM payments WHERE id = ?',
      'p1',
    );
    expect((after.rows[0] as { amount: number }).amount).toBe(1999);
  });

  it('refuses to convert a row that would be rounded away', async () => {
    await seed([['p1', 0.005]]);

    await expect(migrateCommerceMoneyToMinorUnits(db)).rejects.toThrow(
      /would be rounded/,
    );

    // The refusal leaves the column and the data untouched.
    const type = await db.query(
      `SELECT data_type FROM information_schema.columns
       WHERE table_name = 'payments' AND column_name = 'amount'`,
    );
    expect((type.rows[0] as { data_type: string }).data_type).toBe(
      'double precision',
    );
  });

  it('rounds a negative half away from zero, matching the preflight', async () => {
    // PostgreSQL's `round(double precision)` is banker's rounding: it would
    // store `-0` for a -0.5-cent credit while the preflight predicted `-1`.
    // The DDL casts to `numeric` to select the half-away-from-zero overload,
    // so the database and the preflight agree (#2401). Money is legitimately
    // negative here — a billing credit.
    await db.query(
      'INSERT INTO payments (id, amount, native_amount) VALUES (?, ?, 0)',
      'credit',
      -0.005,
    );

    const preflight = await preflightCommerceMoneyMinorUnits(db);
    const amountColumn = preflight.columns.find(
      (column) => column.table === 'payments' && column.column === 'amount',
    );
    expect(amountColumn?.nonIntegral).toEqual([
      { id: 'credit', value: -0.005, scaled: -0.5 },
    ]);

    await migrateCommerceMoneyToMinorUnits(db, { force: true });

    const row = await db.query(
      'SELECT amount FROM payments WHERE id = ?',
      'credit',
    );
    expect((row.rows[0] as { amount: number }).amount).toBe(-1);
  });

  it('leaves payments.native_amount alone — its scale is per-asset', async () => {
    // A BTC rail stores satoshis (x1e8) in the same column a fiat rail stores
    // cents (x1e2), so no single scale converts it. A blanket x100 here would
    // turn 0.00713 BTC into 1 instead of 713_000 sats, and a round 0.01 BTC
    // would even pass the integrality preflight while being wrong by six
    // orders of magnitude. It converts through COMMERCE_NATIVE_UNIT_COLUMNS
    // after the operator normalises each row to its own asset (#2401).
    await db.query(
      'INSERT INTO payments (id, amount, native_amount) VALUES (?, ?, ?)',
      'p-btc',
      19.99,
      0.00713,
    );

    const preflight = await preflightCommerceMoneyMinorUnits(db);
    expect(
      preflight.columns.some((column) => column.column === 'native_amount'),
    ).toBe(false);

    await migrateCommerceMoneyToMinorUnits(db);

    const type = await db.query(
      `SELECT data_type FROM information_schema.columns
       WHERE table_name = 'payments' AND column_name = 'native_amount'`,
    );
    expect((type.rows[0] as { data_type: string }).data_type).toBe(
      'double precision',
    );
    const row = await db.query(
      'SELECT native_amount FROM payments WHERE id = ?',
      'p-btc',
    );
    expect(
      (row.rows[0] as { native_amount: number }).native_amount,
    ).toBeCloseTo(0.00713, 8);
  });
});
