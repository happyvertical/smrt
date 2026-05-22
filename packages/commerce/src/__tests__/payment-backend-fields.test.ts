/**
 * Tests for the {@link Payment} backend-identity and USD-drift fields
 * introduced for the marketplace `PaymentBackend` adapter flow but
 * generally useful for any consumer that routes payments through an
 * external adapter and needs to keep track of volatile-currency drift.
 *
 * Verifies:
 *
 * - the six new fields (`backendId`, `backendTxRef`, `nativeAmount`,
 *   `nativeCurrency`, `usdAtQuote`, `usdAtConfirmation`) all default to
 *   empty / zero so existing rows continue to load cleanly
 * - they round-trip through save/load
 * - `usdDrift()` returns the correct positive / negative / zero drift
 * - the existing `Invoice.updatePaymentStatus()`-driven payment-status
 *   semantics are unaffected (that's tested in payment-ledger.test.ts;
 *   this file only adds, never replaces)
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PaymentCollection } from '../collections/PaymentCollection.js';
import { PaymentMethod, PaymentStatus } from '../types/index.js';

describe('Payment backend identity and USD-drift fields', () => {
  let dbPath: string;
  let payments: PaymentCollection;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-payment-backend-${Date.now()}.db`);
    payments = await PaymentCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
  });

  afterEach(() => {
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  it('defaults backend fields to empty / zero for backwards compatibility', async () => {
    const payment = await payments.create({
      contractId: 'contract-bc-1',
      customerId: 'customer-bc-1',
      amount: 100,
    });
    await payment.save();

    expect(payment.backendId).toBe('');
    expect(payment.backendTxRef).toBe('');
    expect(payment.nativeAmount).toBe(0);
    expect(payment.nativeCurrency).toBe('');
    expect(payment.usdAtQuote).toBe(0);
    expect(payment.usdAtConfirmation).toBe(0);

    const loaded = await payments.get({ id: payment.id });
    expect(loaded?.backendId).toBe('');
    expect(loaded?.backendTxRef).toBe('');
    expect(loaded?.nativeAmount).toBe(0);
    expect(loaded?.nativeCurrency).toBe('');
    expect(loaded?.usdAtQuote).toBe(0);
    expect(loaded?.usdAtConfirmation).toBe(0);
  });

  it('round-trips a Base-USDC stablecoin payment', async () => {
    // Stablecoin rails: nativeAmount typically equals amount, USD quote
    // and confirmation match exactly (no drift to account for).
    const payment = await payments.create({
      contractId: 'contract-usdc',
      customerId: 'customer-usdc',
      amount: 199.0,
      currency: 'USD',
      method: PaymentMethod.CRYPTO,
      backendId: 'base-usdc',
      backendTxRef:
        '0x4cb2e2d8b9e7f5a3c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3',
      nativeAmount: 199.0,
      nativeCurrency: 'USDC-base',
      usdAtQuote: 199.0,
      usdAtConfirmation: 199.0,
    });
    await payment.save();

    const loaded = await payments.get({ id: payment.id });
    expect(loaded?.backendId).toBe('base-usdc');
    expect(loaded?.backendTxRef).toBe(
      '0x4cb2e2d8b9e7f5a3c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3',
    );
    expect(loaded?.nativeAmount).toBe(199.0);
    expect(loaded?.nativeCurrency).toBe('USDC-base');
    expect(loaded?.usdAtQuote).toBe(199.0);
    expect(loaded?.usdAtConfirmation).toBe(199.0);
    expect(loaded?.usdDrift()).toBe(0);
  });

  it('round-trips a volatile-currency BTC payment with drift', async () => {
    // BTC rail: nativeAmount is in BTC, currency stays USD (the
    // canonical settlement number), and the operator absorbed +$5 of
    // drift between quote and confirmation.
    const payment = await payments.create({
      contractId: 'contract-btc',
      customerId: 'customer-btc',
      amount: 500.0,
      currency: 'USD',
      method: PaymentMethod.CRYPTO,
      backendId: 'btc',
      backendTxRef:
        'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16',
      nativeAmount: 0.00713,
      nativeCurrency: 'BTC',
      usdAtQuote: 500.0,
      usdAtConfirmation: 505.0,
    });
    await payment.save();

    const loaded = await payments.get({ id: payment.id });
    expect(loaded?.nativeCurrency).toBe('BTC');
    expect(loaded?.nativeAmount).toBeCloseTo(0.00713);
    expect(loaded?.usdAtQuote).toBe(500.0);
    expect(loaded?.usdAtConfirmation).toBe(505.0);
    expect(loaded?.usdDrift()).toBeCloseTo(5.0);
  });

  it('reports negative drift when confirmation valuation drops below quote', async () => {
    const payment = await payments.create({
      contractId: 'contract-btc-drop',
      customerId: 'customer-btc-drop',
      amount: 1000.0,
      method: PaymentMethod.CRYPTO,
      backendId: 'btc',
      backendTxRef: 'tx-drop-1',
      nativeAmount: 0.0145,
      nativeCurrency: 'BTC',
      usdAtQuote: 1000.0,
      usdAtConfirmation: 987.5,
    });
    await payment.save();

    expect(payment.usdDrift()).toBeCloseTo(-12.5);
  });

  it('returns zero drift when either USD timestamp is unset', async () => {
    // Defensive: drift is undefined unless both quote and confirmation
    // valuations are populated. Existing payment rows from before the
    // backend fields existed (or fiat-rail payments where drift is
    // meaningless) must return `0`, not throw or return NaN.
    const payment = await payments.create({
      contractId: 'contract-fiat',
      customerId: 'customer-fiat',
      amount: 250.0,
      method: PaymentMethod.CREDIT_CARD,
      backendId: 'stripe',
      backendTxRef: 'pi_3PnxXyHaKzExample',
    });
    expect(payment.usdAtQuote).toBe(0);
    expect(payment.usdAtConfirmation).toBe(0);
    expect(payment.usdDrift()).toBe(0);
  });

  it('preserves the existing Payment surface', async () => {
    // Regression: the new fields are purely additive. A consumer that
    // never sets them must still be able to use the standard
    // markFailed / cancel / isPending helpers unchanged.
    const payment = await payments.create({
      contractId: 'contract-existing',
      customerId: 'customer-existing',
      amount: 75.0,
      method: PaymentMethod.BANK_TRANSFER,
      transactionId: 'wire-ref-001',
    });
    await payment.save();

    expect(payment.isPending()).toBe(true);
    payment.markFailed('insufficient funds');
    expect(payment.status).toBe(PaymentStatus.FAILED);
    expect(payment.notes).toContain('insufficient funds');
  });
});
