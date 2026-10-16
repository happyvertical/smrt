import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { describe, expect, it } from 'vitest';
import { validateReceivedPurchaseMoneyFacts } from '../received-purchase-money.js';
import {
  proveReceivedPurchaseMoney,
  receivedFacts,
} from './helpers/received-purchase-money-suite.js';

describe('received purchase monetary authority', () => {
  it('retains declared money, authorizes tenants, freezes, reports and rolls back on SQLite', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    enableTenancy();
    try {
      await proveReceivedPurchaseMoney(db);
    } finally {
      disableTenancy();
      await db.close?.();
    }
  });
  it('retains supplier-declared compound bases above net without inventing a rate', () => {
    const facts = validateReceivedPurchaseMoneyFacts({
      ...receivedFacts,
      taxComponents: [
        {
          sourceKey: 'compound',
          label: 'Declared tax',
          amountMinor: receivedFacts.taxMinor,
          taxableMinor: receivedFacts.netMinor + 500,
          netMinor: receivedFacts.netMinor,
          classification: null,
          recoverableMinor: null,
        },
      ],
    });
    expect(facts.taxComponents?.[0]).toMatchObject({
      taxableMinor: receivedFacts.netMinor + 500,
      netMinor: receivedFacts.netMinor,
    });
  });
  it('distinguishes unknown from known zero and refuses malformed source facts', () => {
    expect(
      validateReceivedPurchaseMoneyFacts(receivedFacts).taxComponents,
    ).toBeNull();
    expect(
      validateReceivedPurchaseMoneyFacts({
        ...receivedFacts,
        netMinor: 0,
        taxMinor: 0,
        grossMinor: 0,
        taxComponents: [],
      }).taxComponents,
    ).toEqual([]);
    for (const changed of [
      { grossMinor: 10538 },
      { taxMinor: -1 },
      { netMinor: Number.MAX_SAFE_INTEGER + 1 },
      { currency: 'ZZZ' },
      { taxComponents: undefined },
      { taxComponents: [] },
      { detail: { kind: 'invented' } },
      { detail: { kind: 'header-only', lines: [] } },
      {
        taxComponents: [
          {
            sourceKey: '1',
            label: 'Tax',
            amountMinor: 537,
            classification: 'guessed',
            recoverableMinor: null,
          },
        ],
      },
      {
        taxComponents: [
          {
            sourceKey: '1',
            label: 'Tax',
            amountMinor: 537,
            classification: null,
            recoverableMinor: 538,
          },
        ],
      },
      {
        detail: {
          kind: 'lines',
          lines: [
            {
              sourceKey: '1',
              description: 'Partial',
              netMinor: 1,
              taxMinor: 0,
              grossMinor: 1,
            },
          ],
        },
      },
    ])
      expect(() =>
        validateReceivedPurchaseMoneyFacts({ ...receivedFacts, ...changed }),
      ).toThrow();
  });
});
