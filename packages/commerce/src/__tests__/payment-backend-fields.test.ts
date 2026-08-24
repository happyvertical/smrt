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
 *
 * Every monetary value here is **integer minor units** (#2401): US cents for
 * `amount` / `usdAtQuote` / `usdAtConfirmation`, and the native asset's own
 * minor unit for `nativeAmount` — satoshis on the BTC rail. That is why the
 * drift assertions are exact `toBe` rather than `toBeCloseTo`.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PaymentCollection } from '../collections/PaymentCollection.js';
import { PaymentMethod, PaymentStatus } from '../types/index.js';
import { seedCommerceForeignKeyFixtures } from './foreign-key-fixtures.js';

describe('Payment backend identity and USD-drift fields', () => {
  let dbPath: string;
  let payments: PaymentCollection;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-payment-backend-${Date.now()}.db`);
    payments = await PaymentCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    await seedCommerceForeignKeyFixtures({
      db: { type: 'sqlite', url: dbPath },
      customerIds: [
        'customer-bc-1',
        'customer-usdc',
        'customer-btc',
        'customer-btc-drop',
        'customer-fiat',
        'customer-existing',
      ],
      contractIds: [
        'contract-bc-1',
        'contract-usdc',
        'contract-btc',
        'contract-btc-drop',
        'contract-fiat',
        'contract-existing',
      ],
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

  it('persists omitted optional payment relationships as null', async () => {
    const payment = await payments.create({ amount: 100 });
    await payment.save();

    expect(payment.contractId).toBeNull();
    expect(payment.customerId).toBeNull();
    const loaded = await payments.get({ id: payment.id });
    expect(loaded?.contractId).toBeNull();
    expect(loaded?.customerId).toBeNull();
  });

  it('round-trips a Base-USDC stablecoin payment', async () => {
    // Stablecoin rails: nativeAmount typically equals amount, USD quote
    // and confirmation match exactly (no drift to account for).
    const payment = await payments.create({
      contractId: 'contract-usdc',
      customerId: 'customer-usdc',
      amount: 19900, // $199.00
      currency: 'USD',
      method: PaymentMethod.CRYPTO,
      backendId: 'base-usdc',
      backendTxRef:
        '0x4cb2e2d8b9e7f5a3c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3',
      nativeAmount: 19900, // USDC has 2 display decimals; same minor units
      nativeCurrency: 'USDC-base',
      usdAtQuote: 19900,
      usdAtConfirmation: 19900,
    });
    await payment.save();

    const loaded = await payments.get({ id: payment.id });
    expect(loaded?.backendId).toBe('base-usdc');
    expect(loaded?.backendTxRef).toBe(
      '0x4cb2e2d8b9e7f5a3c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3',
    );
    expect(loaded?.nativeAmount).toBe(19900);
    expect(loaded?.nativeCurrency).toBe('USDC-base');
    expect(loaded?.usdAtQuote).toBe(19900);
    expect(loaded?.usdAtConfirmation).toBe(19900);
    expect(loaded?.usdDrift()).toBe(0);
  });

  it('round-trips a volatile-currency BTC payment with drift', async () => {
    // BTC rail: nativeAmount is in satoshis, currency stays USD (the
    // canonical settlement number), and the operator absorbed +$5 of
    // drift between quote and confirmation. 0.00713 BTC is 713_000 sats —
    // the whole point of minor units on a volatile rail.
    const payment = await payments.create({
      contractId: 'contract-btc',
      customerId: 'customer-btc',
      amount: 50000, // $500.00
      currency: 'USD',
      method: PaymentMethod.CRYPTO,
      backendId: 'btc',
      backendTxRef:
        'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16',
      nativeAmount: 713_000, // 0.00713 BTC in satoshis
      nativeCurrency: 'BTC',
      usdAtQuote: 50000,
      usdAtConfirmation: 50500,
    });
    await payment.save();

    const loaded = await payments.get({ id: payment.id });
    expect(loaded?.nativeCurrency).toBe('BTC');
    // Exact, not toBeCloseTo — satoshis are whole numbers.
    expect(loaded?.nativeAmount).toBe(713_000);
    expect(loaded?.usdAtQuote).toBe(50000);
    expect(loaded?.usdAtConfirmation).toBe(50500);
    expect(loaded?.usdDrift()).toBe(500); // +$5.00
  });

  it('reports negative drift when confirmation valuation drops below quote', async () => {
    const payment = await payments.create({
      contractId: 'contract-btc-drop',
      customerId: 'customer-btc-drop',
      amount: 100000, // $1,000.00
      method: PaymentMethod.CRYPTO,
      backendId: 'btc',
      backendTxRef: 'tx-drop-1',
      nativeAmount: 1_450_000, // 0.0145 BTC in satoshis
      nativeCurrency: 'BTC',
      usdAtQuote: 100000,
      usdAtConfirmation: 98750,
    });
    await payment.save();

    expect(payment.usdDrift()).toBe(-1250); // -$12.50
  });

  it('returns zero drift when either USD timestamp is unset', async () => {
    // Defensive: drift is undefined unless both quote and confirmation
    // valuations are populated. Existing payment rows from before the
    // backend fields existed (or fiat-rail payments where drift is
    // meaningless) must return `0`, not throw or return NaN.
    const payment = await payments.create({
      contractId: 'contract-fiat',
      customerId: 'customer-fiat',
      amount: 25000, // $250.00
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
      amount: 7500, // $75.00
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
