/**
 * Tests for {@link Vendor.payoutAddresses} — the per-currency payout
 * destination map introduced for the marketplace payout flow but generally
 * useful for any aggregator that pays vendors in mixed currencies.
 *
 * Verifies that:
 *
 * - the field defaults to an empty map and round-trips through save/load
 * - the map accepts both object input and a pre-serialized JSON string
 * - `getPayoutAddress(currency)` returns `undefined` for missing entries
 *   (caller decides whether that's a hard error or a "skip" signal)
 * - `setPayoutAddress` / `clearPayoutAddress` are convenience mutators
 * - malformed string input is tolerated as an empty map (no throw)
 * - non-string values inside the map are dropped to preserve the typed
 *   `Record<string, string>` invariant downstream
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VendorCollection } from '../collections/VendorCollection.js';

describe('Vendor.payoutAddresses', () => {
  let dbPath: string;
  let vendors: VendorCollection;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-vendor-payout-${Date.now()}.db`);
    vendors = await VendorCollection.create({
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

  it('defaults to an empty map for backwards compatibility', async () => {
    const vendor = await vendors.create({ profileId: 'p-default' });
    await vendor.save();

    expect(vendor.payoutAddresses).toEqual({});

    const loaded = await vendors.get({ id: vendor.id! });
    expect(loaded?.payoutAddresses).toEqual({});
  });

  it('round-trips a multi-currency map through save/load', async () => {
    const addresses = {
      'USDC-base': '0xabc0000000000000000000000000000000000001',
      BTC: 'bc1qexampleexampleexampleexampleexample0',
      'USD-stripe': 'acct_stripe_connect_12345',
    };

    const vendor = await vendors.create({
      profileId: 'p-multi',
      payoutAddresses: addresses,
    });
    await vendor.save();

    const loaded = await vendors.get({ id: vendor.id! });
    expect(loaded?.payoutAddresses).toEqual(addresses);
    expect(loaded?.getPayoutAddress('USDC-base')).toBe(addresses['USDC-base']);
    expect(loaded?.getPayoutAddress('BTC')).toBe(addresses.BTC);
    expect(loaded?.getPayoutAddress('USD-stripe')).toBe(
      addresses['USD-stripe'],
    );
  });

  it('returns undefined for missing currency entries', async () => {
    const vendor = await vendors.create({
      profileId: 'p-partial',
      payoutAddresses: { 'USDC-base': '0xabc' },
    });
    await vendor.save();

    const loaded = await vendors.get({ id: vendor.id! });
    expect(loaded?.getPayoutAddress('USDC-base')).toBe('0xabc');
    expect(loaded?.getPayoutAddress('BTC')).toBeUndefined();
    expect(loaded?.getPayoutAddress('USDC-solana')).toBeUndefined();
  });

  it('accepts a pre-serialized JSON string as input', async () => {
    const raw = JSON.stringify({ 'USDC-base': '0xdef' });
    const vendor = await vendors.create({
      profileId: 'p-raw-string',
      payoutAddresses: raw,
    });
    await vendor.save();

    const loaded = await vendors.get({ id: vendor.id! });
    expect(loaded?.getPayoutAddress('USDC-base')).toBe('0xdef');
    expect(loaded?.payoutAddresses).toEqual({ 'USDC-base': '0xdef' });
  });

  it('treats malformed string input as an empty map without throwing', async () => {
    const vendor = await vendors.create({
      profileId: 'p-bad-json',
      payoutAddresses: 'not-valid-json{',
    });
    await vendor.save();

    expect(vendor.payoutAddresses).toEqual({});

    const loaded = await vendors.get({ id: vendor.id! });
    expect(loaded?.payoutAddresses).toEqual({});
  });

  it('drops non-string values inside the input map', async () => {
    const vendor = await vendors.create({
      profileId: 'p-mixed',
      payoutAddresses: {
        BTC: 'bc1qok',
        // The constructor coerces input through `normalizePayoutAddresses`
        // and drops these so consumers always see `Record<string, string>`.
        bogusObject: { nested: 'value' } as unknown as string,
        bogusNumber: 42 as unknown as string,
      },
    });
    await vendor.save();

    const loaded = await vendors.get({ id: vendor.id! });
    expect(loaded?.payoutAddresses).toEqual({ BTC: 'bc1qok' });
    expect(loaded?.getPayoutAddress('bogusObject')).toBeUndefined();
    expect(loaded?.getPayoutAddress('bogusNumber')).toBeUndefined();
  });

  it('supports setPayoutAddress and clearPayoutAddress mutators', async () => {
    const vendor = await vendors.create({
      profileId: 'p-mutate',
      payoutAddresses: { BTC: 'bc1qoriginal' },
    });
    await vendor.save();

    vendor.setPayoutAddress('BTC', 'bc1qreplacement');
    vendor.setPayoutAddress('USDC-base', '0xnewchain');
    await vendor.save();

    let loaded = await vendors.get({ id: vendor.id! });
    expect(loaded?.getPayoutAddress('BTC')).toBe('bc1qreplacement');
    expect(loaded?.getPayoutAddress('USDC-base')).toBe('0xnewchain');

    loaded?.clearPayoutAddress('BTC');
    await loaded?.save();

    loaded = await vendors.get({ id: vendor.id! });
    expect(loaded?.getPayoutAddress('BTC')).toBeUndefined();
    expect(loaded?.getPayoutAddress('USDC-base')).toBe('0xnewchain');
  });
});
