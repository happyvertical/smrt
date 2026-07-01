/**
 * Tests for the {@link PaymentInstrument} model — a saved payment method
 * ("card on file"):
 *
 * - stores only references + non-sensitive display metadata
 * - query by customer / by provider payment-method id
 * - single-default enforcement via setDefaultForCustomer
 * - active vs removed filtering
 * - lifecycle status helpers (markExpired / markRemoved)
 *
 * Uses real in-memory SQLite (no mocks of database operations).
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PaymentInstrumentCollection } from '../collections/PaymentInstrumentCollection.js';
import type { PaymentInstrument } from '../models/PaymentInstrument.js';
import { PaymentInstrumentStatus } from '../types/index.js';

describe('PaymentInstrument', () => {
  let dbPath: string;
  let instruments: PaymentInstrumentCollection;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-payment-instrument-${Date.now()}.db`);
    instruments = await PaymentInstrumentCollection.create({
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

  async function saveInstrument(
    overrides: Record<string, unknown> = {},
  ): Promise<PaymentInstrument> {
    const instrument = await instruments.create({
      customerId: 'cust-1',
      backendId: 'stripe',
      providerCustomerId: 'cus_123',
      providerPaymentMethodId: 'pm_123',
      brand: 'visa',
      last4: '4242',
      expMonth: 12,
      expYear: 2030,
      ...overrides,
    });
    await instrument.save();
    return instrument;
  }

  it('saves a card-on-file with only references and display metadata', async () => {
    const instrument = await saveInstrument();

    expect(instrument.id).toBeTruthy();
    expect(instrument.isActive()).toBe(true);

    const loaded = await instruments.get({ id: instrument.id });
    expect(loaded).toMatchObject({
      customerId: 'cust-1',
      backendId: 'stripe',
      providerCustomerId: 'cus_123',
      providerPaymentMethodId: 'pm_123',
      type: 'card',
      brand: 'visa',
      last4: '4242',
      expMonth: 12,
      expYear: 2030,
      status: PaymentInstrumentStatus.ACTIVE,
    });
  });

  it('finds instruments by customer and by provider payment-method id', async () => {
    await saveInstrument({ providerPaymentMethodId: 'pm_a' });
    await saveInstrument({ providerPaymentMethodId: 'pm_b' });

    const byCustomer = await instruments.findByCustomer('cust-1');
    expect(byCustomer).toHaveLength(2);

    const byPm = await instruments.findByProviderPaymentMethodId('pm_b');
    expect(byPm?.providerPaymentMethodId).toBe('pm_b');
  });

  it('setDefaultForCustomer keeps a single default', async () => {
    const a = await saveInstrument({
      providerPaymentMethodId: 'pm_a',
      isDefault: true,
    });
    const b = await saveInstrument({ providerPaymentMethodId: 'pm_b' });

    await instruments.setDefaultForCustomer('cust-1', b.id);

    const def = await instruments.findDefaultForCustomer('cust-1');
    expect(def?.id).toBe(b.id);

    const reloadedA = await instruments.get({ id: a.id });
    expect(reloadedA?.isDefault).toBe(false);
  });

  it('findActiveByCustomer excludes removed instruments', async () => {
    const a = await saveInstrument({ providerPaymentMethodId: 'pm_a' });
    await saveInstrument({ providerPaymentMethodId: 'pm_b' });

    a.markRemoved();
    await a.save();

    const active = await instruments.findActiveByCustomer('cust-1');
    expect(active).toHaveLength(1);
    expect(active[0]?.providerPaymentMethodId).toBe('pm_b');
  });

  it('lifecycle helpers move the status and remove clears the default', async () => {
    const instrument = await saveInstrument({ isDefault: true });

    instrument.markExpired();
    expect(instrument.isExpired()).toBe(true);

    instrument.markRemoved();
    expect(instrument.isRemoved()).toBe(true);
    expect(instrument.isDefault).toBe(false);

    // `removed` is terminal — markExpired does not revive it.
    instrument.markExpired();
    expect(instrument.isRemoved()).toBe(true);
  });
});
