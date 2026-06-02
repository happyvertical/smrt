/**
 * Tests for the {@link Payout} model — covers the issue's acceptance
 * criteria:
 *
 * - create-from-Payment via the collection convenience
 * - status transitions: pending → sent → confirmed (and pending/sent → failed)
 * - failed-and-reset via the dedicated `resetFromFailed()` helper
 * - query-by-Vendor / by-Payment / by-status / by-backendTxRef
 * - amount invariant (gross = fee + net) enforced on save
 * - status-machine guards (no skipping states, no rolling back a
 *   confirmed payout)
 *
 * Uses real in-memory SQLite (no mocks of database operations).
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PaymentCollection } from '../collections/PaymentCollection.js';
import { PayoutCollection } from '../collections/PayoutCollection.js';
import type { Payout } from '../models/Payout.js';
import { PayoutStatus } from '../types/index.js';

describe('Payout', () => {
  let dbPath: string;
  let payouts: PayoutCollection;
  let payments: PaymentCollection;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-payout-${Date.now()}.db`);
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

  it('creates a pending payout from a source payment', async () => {
    const payment = await payments.create({
      contractId: 'contract-1',
      customerId: 'customer-1',
      amount: 199.0,
      currency: 'USD',
      backendId: 'base-usdc',
      backendTxRef: '0xtx-1',
      nativeAmount: 199.0,
      nativeCurrency: 'USDC-base',
    });
    await payment.save();

    const payout = await payouts.createFromPayment({
      payment,
      vendorId: 'vendor-1',
      operatorFee: 19.9,
      notes: 'first remit',
    });
    expect(payout.id).toBeFalsy();
    await payout.save();

    expect(payout.status).toBe(PayoutStatus.PENDING);
    expect(payout.paymentId).toBe(payment.id);
    expect(payout.vendorId).toBe('vendor-1');
    expect(payout.grossAmount).toBe(199.0);
    expect(payout.operatorFee).toBe(19.9);
    expect(payout.supplierNet).toBeCloseTo(179.1);
    expect(payout.backendId).toBe('base-usdc');
    expect(payout.currency).toBe('USDC-base');
    expect(payout.notes).toBe('first remit');

    const loaded = await payouts.get({ id: payout.id });
    expect(loaded?.paymentId).toBe(payment.id);
    expect(loaded?.grossAmount).toBe(199.0);
  });

  it('carries the source payment tenant onto the payout (no active context)', async () => {
    // Regression: a background payout job iterating Payment rows runs outside
    // any tenant context, so the tenancy interceptor can't auto-stamp a tenant.
    // Without explicitly carrying payment.tenantId, the payout would save as
    // global/null and drop out of tenant-filtered payout queries.
    const payment = await payments.create({
      contractId: 'contract-tenant',
      customerId: 'customer-tenant',
      amount: 500,
      currency: 'USD',
      backendId: 'base-usdc',
      nativeAmount: 500,
      nativeCurrency: 'USDC-base',
      tenantId: 'tenant-A',
    });
    await payment.save();
    expect(payment.tenantId).toBe('tenant-A');

    const payout = await payouts.createFromPayment({
      payment,
      vendorId: 'vendor-tenant',
      operatorFee: 50,
    });
    // The fix: the payout inherits the payment's tenant before save.
    expect(payout.tenantId).toBe('tenant-A');
    await payout.save();

    const loaded = await payouts.get({ id: payout.id });
    expect(loaded?.tenantId).toBe('tenant-A');

    // And it must surface in a tenant-filtered query rather than as a global row.
    const forTenant = await payouts.findByTenant('tenant-A');
    expect(forTenant.map((p) => p.id)).toContain(payout.id);
  });

  it('falls back to amount / currency when no backend rail is set', async () => {
    // Defensive: a manually-recorded Payment with no PaymentBackend
    // adapter (e.g. a bank-transfer row entered by a human bookkeeper)
    // still needs to be payoutable.
    const payment = await payments.create({
      contractId: 'contract-fiat',
      customerId: 'customer-fiat',
      amount: 1000,
      currency: 'USD',
    });
    await payment.save();

    const payout = await payouts.createFromPayment({
      payment,
      vendorId: 'vendor-fiat',
      operatorFee: 50,
    });
    expect(payout.grossAmount).toBe(1000);
    expect(payout.currency).toBe('USD');
    expect(payout.supplierNet).toBe(950);
  });

  it('walks the happy-path status machine: pending → sent → confirmed', async () => {
    const payout = await payouts.create({
      paymentId: 'pmt-x',
      vendorId: 'vendor-x',
      grossAmount: 100,
      operatorFee: 10,
      supplierNet: 90,
      currency: 'USDC-base',
      backendId: 'base-usdc',
    });
    await payout.save();

    payout.markSent('0xoutgoing-tx-1');
    expect(payout.status).toBe(PayoutStatus.SENT);
    expect(payout.backendTxRef).toBe('0xoutgoing-tx-1');
    expect(payout.sentAt).toBeInstanceOf(Date);
    await payout.save();

    payout.markConfirmed();
    expect(payout.status).toBe(PayoutStatus.CONFIRMED);
    expect(payout.confirmedAt).toBeInstanceOf(Date);
    await payout.save();

    const loaded = await payouts.get({ id: payout.id });
    expect(loaded?.status).toBe(PayoutStatus.CONFIRMED);
    expect(loaded?.backendTxRef).toBe('0xoutgoing-tx-1');
  });

  it('refuses to skip states', async () => {
    const payout = await payouts.create({
      paymentId: 'pmt-skip',
      vendorId: 'vendor-skip',
      grossAmount: 100,
      operatorFee: 10,
      supplierNet: 90,
      currency: 'USDC-base',
      backendId: 'base-usdc',
    });
    await payout.save();

    // pending → confirmed is invalid
    expect(() => payout.markConfirmed()).toThrow(
      /cannot transition to CONFIRMED/,
    );

    // markSent requires a non-empty backendTxRef
    expect(() => payout.markSent('')).toThrow(/requires a backendTxRef/);

    payout.markSent('tx-1');
    payout.markConfirmed();

    // confirmed → anything (except failed which is also blocked) is invalid
    expect(() => payout.markSent('tx-2')).toThrow(/cannot transition to SENT/);
    expect(() => payout.markConfirmed()).toThrow(
      /cannot transition to CONFIRMED/,
    );
    expect(() => payout.markFailed('nope')).toThrow(
      /cannot transition to FAILED/,
    );
  });

  it('moves to failed from pending or sent, but not from confirmed', async () => {
    const a = await payouts.create({
      paymentId: 'pmt-fail-a',
      vendorId: 'vendor-fail',
      grossAmount: 10,
      operatorFee: 1,
      supplierNet: 9,
      currency: 'USDC-base',
      backendId: 'base-usdc',
    });
    await a.save();

    a.markFailed('rail offline');
    expect(a.status).toBe(PayoutStatus.FAILED);
    expect(a.failedAt).toBeInstanceOf(Date);
    expect(a.failureReason).toBe('rail offline');

    const b = await payouts.create({
      paymentId: 'pmt-fail-b',
      vendorId: 'vendor-fail',
      grossAmount: 10,
      operatorFee: 1,
      supplierNet: 9,
      currency: 'USDC-base',
      backendId: 'base-usdc',
    });
    await b.save();
    b.markSent('tx-sent-then-failed');
    b.markFailed('chain rejected');
    expect(b.status).toBe(PayoutStatus.FAILED);
    expect(b.failureReason).toBe('chain rejected');
  });

  it('allows operator-driven reset from failed back to pending', async () => {
    const payout = await payouts.create({
      paymentId: 'pmt-reset',
      vendorId: 'vendor-reset',
      grossAmount: 10,
      operatorFee: 1,
      supplierNet: 9,
      currency: 'USDC-base',
      backendId: 'base-usdc',
    });
    await payout.save();
    payout.markSent('tx-old');
    payout.markFailed('insufficient gas');
    payout.confirmedAt = new Date('2099-01-01T00:00:00.000Z');
    await payout.save();

    payout.resetFromFailed();
    expect(payout.status).toBe(PayoutStatus.PENDING);
    expect(payout.failureReason).toBe('');
    expect(payout.sentAt).toBeNull();
    expect(payout.confirmedAt).toBeNull();
    expect(payout.failedAt).toBeNull();
    // The old tx ref is cleared so the next attempt can use a fresh one
    expect(payout.backendTxRef).toBe('');
    await payout.save();

    payout.markSent('tx-new');
    payout.markConfirmed();
    expect(payout.status).toBe(PayoutStatus.CONFIRMED);
    expect(payout.backendTxRef).toBe('tx-new');
  });

  it('refuses to reset from any non-failed status', async () => {
    const payout = await payouts.create({
      paymentId: 'pmt-no-reset',
      vendorId: 'vendor-no-reset',
      grossAmount: 10,
      operatorFee: 1,
      supplierNet: 9,
      currency: 'USDC-base',
      backendId: 'base-usdc',
    });
    await payout.save();
    expect(() => payout.resetFromFailed()).toThrow(/cannot reset/);
  });

  it('rejects an amount-invariant violation on save', async () => {
    // Build with correct math so the implicit save() inside
    // collection.create() succeeds; then mutate to bad math and
    // assert the explicit save() trips the invariant. This catches
    // the common failure mode where a caller wires up the wrong
    // fee/net combo via direct field assignment, bypassing
    // `createFromPayment`'s computed split.
    const payout = await payouts.create({
      paymentId: 'pmt-bad-math',
      vendorId: 'vendor-bad-math',
      grossAmount: 100,
      operatorFee: 10,
      supplierNet: 90,
      currency: 'USDC-base',
      backendId: 'base-usdc',
    });
    await payout.save();
    payout.supplierNet = 95; // should still be 90
    await expect(payout.save()).rejects.toThrow(/amount invariant/);
  });

  it('tolerates sub-cent rounding noise', async () => {
    // Decimal arithmetic on stablecoins can introduce floating-point
    // fuzz; the model tolerates up to 1¢ of drift before flagging it
    // as a real invariant violation.
    const payout = await payouts.create({
      paymentId: 'pmt-rounding',
      vendorId: 'vendor-rounding',
      grossAmount: 0.3,
      operatorFee: 0.1,
      supplierNet: 0.2 + 1e-12, // a hair over 0.2 from arithmetic
      currency: 'USDC-base',
      backendId: 'base-usdc',
    });
    await expect(payout.save()).resolves.toBeDefined();
  });

  it('re-coerces ISO-string timestamps after collection initialization', async () => {
    const payout = await payouts.create({
      paymentId: 'pmt-date-strings',
      vendorId: 'vendor-date-strings',
      grossAmount: 100,
      operatorFee: 10,
      supplierNet: 90,
      currency: 'USDC-base',
      backendId: 'base-usdc',
      status: PayoutStatus.FAILED,
      sentAt: '2099-01-01T00:00:00.000Z',
      confirmedAt: '2099-01-02T00:00:00.000Z',
      failedAt: '2099-01-03T00:00:00.000Z',
    } as any);

    expect(payout.sentAt).toBeInstanceOf(Date);
    expect(payout.confirmedAt).toBeInstanceOf(Date);
    expect(payout.failedAt).toBeInstanceOf(Date);
    expect(payout.sentAt?.toISOString()).toBe('2099-01-01T00:00:00.000Z');
    expect(payout.confirmedAt?.toISOString()).toBe('2099-01-02T00:00:00.000Z');
    expect(payout.failedAt?.toISOString()).toBe('2099-01-03T00:00:00.000Z');
  });
});

describe('PayoutCollection — queries', () => {
  let dbPath: string;
  let payouts: PayoutCollection;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-payout-queries-${Date.now()}.db`);
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

  async function makePayout(
    fields: Partial<{
      paymentId: string;
      vendorId: string;
      grossAmount: number;
      operatorFee: number;
      supplierNet: number;
      currency: string;
      backendId: string;
      status: PayoutStatus;
      backendTxRef: string;
    }>,
  ): Promise<Payout> {
    const p = await payouts.create({
      paymentId: 'pmt-default',
      vendorId: 'vendor-default',
      grossAmount: 10,
      operatorFee: 1,
      supplierNet: 9,
      currency: 'USDC-base',
      backendId: 'base-usdc',
      status: PayoutStatus.PENDING,
      ...fields,
    });
    await p.save();
    return p;
  }

  it('finds by vendor and by payment', async () => {
    const a = await makePayout({ vendorId: 'v-1', paymentId: 'pmt-A' });
    await makePayout({ vendorId: 'v-1', paymentId: 'pmt-B' });
    await makePayout({ vendorId: 'v-2', paymentId: 'pmt-A' });

    const byVendor = await payouts.findByVendor('v-1');
    expect(byVendor).toHaveLength(2);

    const byPayment = await payouts.findByPayment('pmt-A');
    expect(byPayment).toHaveLength(2);
    expect(byPayment.some((p) => p.id === a.id)).toBe(true);
  });

  it('finds by status and by backendTxRef', async () => {
    const pending = await makePayout({
      vendorId: 'v-q',
      status: PayoutStatus.PENDING,
    });
    const sent = await makePayout({
      vendorId: 'v-q',
      status: PayoutStatus.SENT,
      backendTxRef: 'tx-q-sent',
    });
    await makePayout({ vendorId: 'v-q', status: PayoutStatus.CONFIRMED });

    expect(await payouts.findPending()).toHaveLength(1);
    expect(
      (await payouts.findByStatus(PayoutStatus.CONFIRMED)).length,
    ).toBeGreaterThanOrEqual(1);
    expect((await payouts.findByBackendTxRef('tx-q-sent'))?.id).toBe(sent.id);
    expect(await payouts.findByBackendTxRef('')).toBeNull();
    expect(await payouts.findByBackendTxRef('not-a-real-tx')).toBeNull();
    expect(pending.id).toBeDefined();
  });

  it('sums confirmed payouts per vendor', async () => {
    await makePayout({
      vendorId: 'v-sum',
      status: PayoutStatus.CONFIRMED,
      grossAmount: 100,
      operatorFee: 10,
      supplierNet: 90,
    });
    await makePayout({
      vendorId: 'v-sum',
      status: PayoutStatus.CONFIRMED,
      grossAmount: 50,
      operatorFee: 5,
      supplierNet: 45,
    });
    // A pending one should NOT count toward the confirmed total
    await makePayout({
      vendorId: 'v-sum',
      status: PayoutStatus.PENDING,
      grossAmount: 999,
      operatorFee: 99,
      supplierNet: 900,
    });

    expect(await payouts.getConfirmedTotalForVendor('v-sum')).toBeCloseTo(135);
  });
});
