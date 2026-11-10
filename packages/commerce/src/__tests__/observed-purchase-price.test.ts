import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { describe, expect, it } from 'vitest';
import { validateObservedPurchasePriceFacts } from '../observed-purchase-price.js';
import { proveObservedPurchasePrice } from './helpers/observed-purchase-price-suite.js';

describe('observed purchase prices', () => {
  it('retains unknown totals, exact identity and reviewed completion atomically', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    enableTenancy();
    try {
      await proveObservedPurchasePrice(db);
    } finally {
      disableTenancy();
      await db.close?.();
    }
  });
  it('keeps known zero distinct from unknown and never derives a tax rate', () => {
    const facts = {
      currency: 'CAD',
      netMinor: 0,
      taxMinor: null,
      grossMinor: null,
      detail: { kind: 'header-only' },
    };
    expect(validateObservedPurchasePriceFacts(facts)).toEqual(facts);
    for (const changed of [
      { netMinor: null },
      { taxMinor: undefined },
      { netMinor: -1 },
      { netMinor: 1.1 },
      { netMinor: Number.MAX_SAFE_INTEGER + 1 },
      { currency: 'ZZZ' },
      { netMinor: 10, taxMinor: 1, grossMinor: 10 },
      { detail: { kind: 'lines', lines: [] } },
    ])
      expect(() =>
        validateObservedPurchasePriceFacts({ ...facts, ...changed }),
      ).toThrow();
  });
});
