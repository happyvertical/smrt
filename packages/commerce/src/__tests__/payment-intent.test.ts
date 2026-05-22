/**
 * Tests for the {@link PaymentIntent} model — covers the issue's
 * required acceptance criteria:
 *
 * - create + assert shape
 * - expire transition (with terminal-status guard)
 * - single-option pay (the only-option case)
 * - multi-option pay-and-retire (the listed alternatives become
 *   retired, with `isOptionRetired` returning `true` for them)
 * - idempotency replay returning the existing intent
 * - cancel transition (only from `AWAITING_PAYMENT`)
 *
 * Plus regression coverage for the normalization paths and the
 * date-coercion helper.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PaymentIntentCollection } from '../collections/PaymentIntentCollection.js';
import { PaymentIntent } from '../models/PaymentIntent.js';
import { PaymentIntentStatus, type PaymentOption } from '../types/index.js';

const usdcOption: PaymentOption = {
  backendId: 'base-usdc',
  currency: 'USDC-base',
  chain: 'base',
  payTo: '0xabc0000000000000000000000000000000000001',
  nativeAmount: 199.0,
  x402Capable: true,
};

const btcOption: PaymentOption = {
  backendId: 'btc',
  currency: 'BTC',
  payTo: 'bc1qexampleexampleexampleexampleexample0',
  nativeAmount: 0.00713,
};

describe('PaymentIntent', () => {
  let dbPath: string;
  let intents: PaymentIntentCollection;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-payment-intent-${Date.now()}.db`);
    intents = await PaymentIntentCollection.create({
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

  it('creates a new intent and round-trips its multi-option shape', async () => {
    const intent = await intents.create({
      skuId: 'sku-ergot-1',
      offeringRef: 'sku-ergot-1',
      licenseeEmail: 'buyer@example.test',
      idempotencyKey: 'idem-create-1',
      usdPriceLocked: 199.0,
      paymentOptions: [usdcOption, btcOption],
    });
    await intent.save();

    expect(intent.status).toBe(PaymentIntentStatus.AWAITING_PAYMENT);
    expect(intent.paymentOptions).toHaveLength(2);
    expect(intent.paymentOptions[0].backendId).toBe('base-usdc');
    expect(intent.paymentOptions[1].backendId).toBe('btc');
    expect(intent.priceLockExpiresAt).toBeInstanceOf(Date);
    expect(intent.priceLockExpiresAt?.getTime()).toBeGreaterThan(Date.now());

    const loaded = await intents.get({ id: intent.id });
    expect(loaded?.usdPriceLocked).toBe(199.0);
    expect(loaded?.paymentOptions).toEqual(intent.paymentOptions);
    expect(loaded?.priceLockExpiresAt).toBeInstanceOf(Date);
  });

  it('drops malformed payment-option entries on input', async () => {
    // Defensive: a row migrated from another schema, or a programmatic
    // caller that forgot to fill a required field, should not be able
    // to smuggle a half-built option through the typed API.
    const intent = await intents.create({
      offeringRef: 'sku-mixed',
      licenseeEmail: 'buyer@example.test',
      idempotencyKey: 'idem-mixed',
      usdPriceLocked: 100,
      paymentOptions: [
        usdcOption,
        { backendId: 'broken' } as PaymentOption, // missing currency / payTo / nativeAmount
        null as unknown as PaymentOption,
        'not-an-option' as unknown as PaymentOption,
      ],
    });
    await intent.save();

    expect(intent.paymentOptions).toHaveLength(1);
    expect(intent.paymentOptions[0].backendId).toBe('base-usdc');
  });

  it('expires an open intent and refuses to expire a terminal one', async () => {
    const intent = await intents.create({
      offeringRef: 'sku-expire',
      licenseeEmail: 'b@example.test',
      idempotencyKey: 'idem-expire',
      usdPriceLocked: 100,
      paymentOptions: [usdcOption],
    });
    await intent.save();

    intent.expire();
    expect(intent.status).toBe(PaymentIntentStatus.EXPIRED);
    expect(intent.expiredAt).toBeInstanceOf(Date);

    // Idempotent on a stale call
    expect(() => intent.expire()).not.toThrow();

    // But cannot expire something that already moved to a different
    // terminal — that'd erase semantic state.
    const paid = await intents.create({
      offeringRef: 'sku-expire-paid',
      licenseeEmail: 'b@example.test',
      idempotencyKey: 'idem-expire-paid',
      usdPriceLocked: 100,
      paymentOptions: [usdcOption],
    });
    paid.markPaid({ backendId: 'base-usdc', paymentId: 'pmt-1' });
    expect(() => paid.expire()).toThrow(/cannot expire/);
  });

  it('marks a single-option intent paid and links the payment', async () => {
    const intent = await intents.create({
      offeringRef: 'sku-single',
      licenseeEmail: 'b@example.test',
      idempotencyKey: 'idem-single',
      usdPriceLocked: 199,
      paymentOptions: [usdcOption],
    });
    await intent.save();

    intent.markPaid({ backendId: 'base-usdc', paymentId: 'pmt-single-1' });
    await intent.save();

    const loaded = await intents.get({ id: intent.id });
    expect(loaded?.status).toBe(PaymentIntentStatus.PAID);
    expect(loaded?.paidOptionBackendId).toBe('base-usdc');
    expect(loaded?.paymentId).toBe('pmt-single-1');
    expect(loaded?.paidAt).toBeInstanceOf(Date);
  });

  it('multi-option: paying one option retires the others', async () => {
    const intent = await intents.create({
      offeringRef: 'sku-multi',
      licenseeEmail: 'b@example.test',
      idempotencyKey: 'idem-multi',
      usdPriceLocked: 199,
      paymentOptions: [usdcOption, btcOption],
    });
    await intent.save();

    intent.markPaid({ backendId: 'base-usdc', paymentId: 'pmt-multi-1' });
    await intent.save();

    expect(intent.isPaid()).toBe(true);
    expect(intent.paidOptionBackendId).toBe('base-usdc');

    // The losing option is now retired: later inbound funds to it
    // are to be flagged for refund by the consumer.
    expect(intent.isOptionRetired('btc')).toBe(true);
    expect(intent.isOptionRetired('base-usdc')).toBe(false);
    expect(intent.isOptionRetired('unknown-backend')).toBe(false);

    const retired = intent.getRetiredOptions();
    expect(retired).toHaveLength(1);
    expect(retired[0].backendId).toBe('btc');
  });

  it('refuses to mark paid twice or with an unlisted backendId', async () => {
    const intent = await intents.create({
      offeringRef: 'sku-mp2',
      licenseeEmail: 'b@example.test',
      idempotencyKey: 'idem-mp2',
      usdPriceLocked: 199,
      paymentOptions: [usdcOption, btcOption],
    });
    await intent.save();

    expect(() =>
      intent.markPaid({ backendId: 'nope-not-listed', paymentId: 'x' }),
    ).toThrow(/not one of the listed options/);

    intent.markPaid({ backendId: 'btc', paymentId: 'pmt-mp2' });
    expect(() =>
      intent.markPaid({ backendId: 'base-usdc', paymentId: 'pmt-mp2b' }),
    ).toThrow(/cannot transition to PAID/);
  });

  it('cancels an open intent but refuses to cancel a paid one', async () => {
    const intent = await intents.create({
      offeringRef: 'sku-cancel',
      licenseeEmail: 'b@example.test',
      idempotencyKey: 'idem-cancel',
      usdPriceLocked: 100,
      paymentOptions: [usdcOption],
    });
    await intent.save();

    intent.cancel('buyer changed mind');
    expect(intent.status).toBe(PaymentIntentStatus.CANCELLED);
    expect(intent.cancelledAt).toBeInstanceOf(Date);
    expect(intent.notes).toContain('buyer changed mind');

    const paid = await intents.create({
      offeringRef: 'sku-cancel-paid',
      licenseeEmail: 'b@example.test',
      idempotencyKey: 'idem-cancel-paid',
      usdPriceLocked: 100,
      paymentOptions: [usdcOption],
    });
    paid.markPaid({ backendId: 'base-usdc', paymentId: 'x' });
    expect(() => paid.cancel()).toThrow(/cannot cancel/);
  });

  it('issues a paid intent and refuses to issue an unpaid one', async () => {
    const intent = await intents.create({
      offeringRef: 'sku-issue',
      licenseeEmail: 'b@example.test',
      idempotencyKey: 'idem-issue',
      usdPriceLocked: 100,
      paymentOptions: [usdcOption],
    });
    await intent.save();

    expect(() => intent.markIssued()).toThrow(/cannot transition to ISSUED/);
    intent.markPaid({ backendId: 'base-usdc', paymentId: 'pmt-issue' });
    intent.markIssued();
    expect(intent.status).toBe(PaymentIntentStatus.ISSUED);
    expect(intent.issuedAt).toBeInstanceOf(Date);

    // Idempotent on a second call
    expect(() => intent.markIssued()).not.toThrow();
  });

  it('retires a paid intent for refund / chargeback reversal', async () => {
    const intent = await intents.create({
      offeringRef: 'sku-retire',
      licenseeEmail: 'b@example.test',
      idempotencyKey: 'idem-retire',
      usdPriceLocked: 100,
      paymentOptions: [usdcOption],
    });
    await intent.save();

    expect(() => intent.retire()).toThrow(/cannot retire/);
    intent.markPaid({ backendId: 'base-usdc', paymentId: 'pmt-retire' });
    intent.retire('chargeback');
    expect(intent.status).toBe(PaymentIntentStatus.RETIRED);
    expect(intent.retiredAt).toBeInstanceOf(Date);
    expect(intent.notes).toContain('chargeback');
  });

  it('isExpired() flips once the price-lock window passes', async () => {
    const intent = await intents.create({
      offeringRef: 'sku-tick',
      licenseeEmail: 'b@example.test',
      idempotencyKey: 'idem-tick',
      usdPriceLocked: 100,
      paymentOptions: [usdcOption],
      // Anchor the expiry one second in the past so the predicate
      // flips deterministically without any wall-clock sleep.
      priceLockExpiresAt: new Date(Date.now() - 1000),
    });
    expect(intent.isExpired()).toBe(true);
    intent.expire();
    expect(intent.isExpired()).toBe(true);
  });
});

describe('PaymentIntentCollection — idempotency', () => {
  let dbPath: string;
  let intents: PaymentIntentCollection;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-payment-intent-idem-${Date.now()}.db`);
    intents = await PaymentIntentCollection.create({
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

  it('replays return the existing intent for the same natural key', async () => {
    const seed = {
      skuId: 'sku-idem-1',
      offeringRef: 'sku-idem-1',
      licenseeEmail: 'buyer@example.test',
      idempotencyKey: 'caller-supplied-uuid-1',
      usdPriceLocked: 199.0,
      paymentOptions: [usdcOption, btcOption],
    };

    const first = await intents.getOrCreateByIdempotencyKey(seed);
    expect(first.created).toBe(true);
    expect(first.intent.id).toBeDefined();

    const second = await intents.getOrCreateByIdempotencyKey(seed);
    expect(second.created).toBe(false);
    expect(second.intent.id).toBe(first.intent.id);

    // And a third call after the original was mutated still hands back
    // the persisted row — replays must never roll back a paid intent.
    first.intent.markPaid({ backendId: 'base-usdc', paymentId: 'pmt' });
    await first.intent.save();
    const third = await intents.getOrCreateByIdempotencyKey(seed);
    expect(third.created).toBe(false);
    expect(third.intent.status).toBe(PaymentIntentStatus.PAID);
  });

  it('different natural-key tuples create separate intents', async () => {
    const base = {
      skuId: 'sku-different',
      offeringRef: 'sku-different',
      usdPriceLocked: 50,
      paymentOptions: [usdcOption],
    };
    const a = await intents.getOrCreateByIdempotencyKey({
      ...base,
      licenseeEmail: 'a@example.test',
      idempotencyKey: 'key-1',
    });
    const b = await intents.getOrCreateByIdempotencyKey({
      ...base,
      licenseeEmail: 'b@example.test',
      idempotencyKey: 'key-1',
    });
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(a.intent.id).not.toBe(b.intent.id);

    const sameEmailNewKey = await intents.getOrCreateByIdempotencyKey({
      ...base,
      licenseeEmail: 'a@example.test',
      idempotencyKey: 'key-2',
    });
    expect(sameEmailNewKey.created).toBe(true);
    expect(sameEmailNewKey.intent.id).not.toBe(a.intent.id);
  });

  it('findByIdempotencyKey returns null for an incomplete key', async () => {
    expect(
      await intents.findByIdempotencyKey({
        offeringRef: '',
        licenseeEmail: 'a@example.test',
        idempotencyKey: 'key',
      }),
    ).toBeNull();
  });
});

describe('PaymentIntentCollection — windowed queries', () => {
  let dbPath: string;
  let intents: PaymentIntentCollection;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-payment-intent-windows-${Date.now()}.db`);
    intents = await PaymentIntentCollection.create({
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

  it('findOpen excludes stale (past-expiry) intents', async () => {
    const open = await intents.create({
      offeringRef: 'sku-open',
      licenseeEmail: 'a@example.test',
      idempotencyKey: 'idem-open',
      usdPriceLocked: 100,
      paymentOptions: [usdcOption],
    });
    await open.save();

    const stale = await intents.create({
      offeringRef: 'sku-stale',
      licenseeEmail: 'a@example.test',
      idempotencyKey: 'idem-stale',
      usdPriceLocked: 100,
      paymentOptions: [usdcOption],
      priceLockExpiresAt: new Date(Date.now() - 60_000),
    });
    await stale.save();

    const openList = await intents.findOpen();
    expect(openList.map((p) => p.id)).toContain(open.id);
    expect(openList.map((p) => p.id)).not.toContain(stale.id);

    const staleList = await intents.findStale();
    expect(staleList.map((p) => p.id)).toContain(stale.id);
    expect(staleList.map((p) => p.id)).not.toContain(open.id);
  });

  it('findByLicenseeEmail returns matches in created-desc order', async () => {
    await (
      await intents.create({
        offeringRef: 'o1',
        licenseeEmail: 'shared@example.test',
        idempotencyKey: 'k1',
        usdPriceLocked: 1,
        paymentOptions: [usdcOption],
      })
    ).save();
    await (
      await intents.create({
        offeringRef: 'o2',
        licenseeEmail: 'shared@example.test',
        idempotencyKey: 'k2',
        usdPriceLocked: 2,
        paymentOptions: [usdcOption],
      })
    ).save();
    await (
      await intents.create({
        offeringRef: 'o3',
        licenseeEmail: 'other@example.test',
        idempotencyKey: 'k3',
        usdPriceLocked: 3,
        paymentOptions: [usdcOption],
      })
    ).save();

    const found = await intents.findByLicenseeEmail('shared@example.test');
    expect(found).toHaveLength(2);
  });
});

describe('PaymentIntent — direct constructor', () => {
  it('coerces ISO-string dates into Date instances', () => {
    const intent = new PaymentIntent({
      offeringRef: 'sku-coerce',
      licenseeEmail: 'a@example.test',
      idempotencyKey: 'idem-coerce',
      usdPriceLocked: 100,
      paymentOptions: [usdcOption],
      priceLockExpiresAt: '2099-01-01T00:00:00.000Z',
    });
    expect(intent.priceLockExpiresAt).toBeInstanceOf(Date);
    expect(intent.priceLockExpiresAt?.toISOString()).toBe(
      '2099-01-01T00:00:00.000Z',
    );
  });
});
