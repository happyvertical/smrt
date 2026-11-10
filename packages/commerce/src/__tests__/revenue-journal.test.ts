import { describe, expect, it } from 'vitest';
import { MoneyValidationError } from '../money.js';
import {
  buildRevenueJournalEntries,
  type RevenueJournalDocumentInput,
  type RevenueJournalLineInput,
  type RevenueJournalTaxInput,
} from '../revenue-journal.js';

const options = {
  arAccountId: 'ar',
  revenueAccountId: 'revenue-default',
  taxAccountId: 'tax-fallback',
  bookCurrency: 'CAD',
} as const;

function document(
  lineAmountType: RevenueJournalDocumentInput['lineAmountType'],
  subtotalMinor: number,
  taxMinor: number,
  totalMinor: number,
  providerTaxMinor = 0,
): RevenueJournalDocumentInput {
  return {
    id: 'invoice-1',
    number: 'INV-1',
    currency: 'CAD',
    lineAmountType,
    subtotalMinor,
    taxMinor,
    totalMinor,
    providerTaxMinor,
  };
}

function lines(
  amounts: readonly number[],
  taxes: readonly number[],
): RevenueJournalLineInput[] {
  const accounts = [
    'revenue-services',
    'revenue-goods',
    'revenue-software',
    'revenue-books',
  ];
  return amounts.map((amountMinor, index) => ({
    id: String(index + 1),
    amountMinor,
    taxMinor: taxes[index] ?? 0,
    revenueAccountId: accounts[index] ?? 'revenue-default',
  }));
}

function tax(
  component: 'gst' | 'pst',
  taxMinor: number,
  code = 'gst-pst',
): RevenueJournalTaxInput {
  return {
    currency: 'CAD',
    taxCodeId: code,
    taxCodeCode: code.toUpperCase(),
    taxComponentId: component,
    liabilityAccountId: `tax-${component}`,
    taxMinor,
  };
}

function amountsByAccount(
  entries: ReturnType<typeof buildRevenueJournalEntries>['entries'],
): Record<string, { debit?: number; credit?: number }> {
  return Object.fromEntries(
    entries.map(({ accountId, debit, credit }) => [
      accountId,
      { debit, credit },
    ]),
  );
}

function expectBalanced(
  entries: ReturnType<typeof buildRevenueJournalEntries>['entries'],
): void {
  expect(entries.reduce((sum, row) => sum + (row.debit ?? 0), 0)).toBe(
    entries.reduce((sum, row) => sum + (row.credit ?? 0), 0),
  );
  for (const row of entries) {
    expect(row.debit ?? row.credit).toBeGreaterThan(0);
    expect(row.debit !== undefined && row.credit !== undefined).toBe(false);
  }
}

describe('buildRevenueJournalEntries worked examples', () => {
  it('posts example A for both rounding scopes with line and component accounts', () => {
    for (const _scope of ['line', 'document'] as const) {
      const result = buildRevenueJournalEntries(
        document('exclusive', 114_498, 8_070, 122_568),
        lines([76_500, 9_498, 24_000, 4_500], [3_825, 1_140, 2_880, 225]),
        [tax('gst', 4_050, 'gst'), tax('gst', 1_675), tax('pst', 2_345)],
        options,
      );
      expect(amountsByAccount(result.entries)).toEqual({
        ar: { debit: 122_568, credit: undefined },
        'revenue-books': { debit: undefined, credit: 4_500 },
        'revenue-goods': { debit: undefined, credit: 9_498 },
        'revenue-services': { debit: undefined, credit: 76_500 },
        'revenue-software': { debit: undefined, credit: 24_000 },
        'tax-gst': { debit: undefined, credit: 5_725 },
        'tax-pst': { debit: undefined, credit: 2_345 },
      });
      expectBalanced(result.entries);
    }
  });

  it('posts example B line/document scopes and identical exclusive twins', () => {
    const cases = [
      {
        subtotal: 107_052,
        taxTotal: 7_446,
        lineTax: [3_643, 1_018, 2_571, 214],
        gst: 5_352,
        pst: 2_094,
      },
      {
        subtotal: 107_051,
        taxTotal: 7_447,
        lineTax: [3_643, 1_018, 2_572, 214],
        gst: 5_353,
        pst: 2_094,
      },
    ] as const;
    for (const value of cases) {
      const inclusive = buildRevenueJournalEntries(
        document('inclusive', value.subtotal, value.taxTotal, 114_498),
        lines([76_500, 9_498, 24_000, 4_500], value.lineTax),
        [tax('gst', value.gst), tax('pst', value.pst)],
        options,
      );
      const net = [76_500, 9_498, 24_000, 4_500].map(
        (amount, index) => amount - value.lineTax[index],
      );
      const exclusive = buildRevenueJournalEntries(
        document('exclusive', value.subtotal, value.taxTotal, 114_498),
        lines(net, value.lineTax),
        [tax('gst', value.gst), tax('pst', value.pst)],
        options,
      );
      expect(inclusive).toEqual(exclusive);
      expectBalanced(inclusive.entries);
    }
  });

  it('posts examples C and D under both scopes while skipping non-taxable rows', () => {
    const zeroTaxRow: RevenueJournalTaxInput = {
      currency: 'CAD',
      taxCodeId: 'exempt',
      taxCodeCode: 'EXEMPT',
      taxComponentId: null,
      liabilityAccountId: null,
      taxMinor: 0,
    };
    for (const mode of ['exclusive', 'inclusive'] as const) {
      for (const _scope of ['line', 'document'] as const) {
        const result = buildRevenueJournalEntries(
          document(mode, 114_498, 0, 114_498),
          lines([76_500, 9_498, 24_000, 4_500], [0, 0, 0, 0]),
          [zeroTaxRow],
          options,
        );
        expect(
          result.entries.some((row) => row.accountId.startsWith('tax-')),
        ).toBe(false);
        expectBalanced(result.entries);
      }
    }
  });

  it.each([
    ['exclusive-line', 'exclusive', 30, 6, 36, [10, 10, 10], [2, 2, 2], 3, 3],
    [
      'exclusive-document',
      'exclusive',
      30,
      4,
      34,
      [10, 10, 10],
      [2, 2, 0],
      2,
      2,
    ],
    ['inclusive-line', 'inclusive', 27, 3, 30, [10, 10, 10], [1, 1, 1], 0, 3],
    [
      'inclusive-document',
      'inclusive',
      27,
      3,
      30,
      [10, 10, 10],
      [2, 1, 0],
      1,
      2,
    ],
  ] as const)('posts example E %s exactly', (_name, mode, subtotal, taxTotal, total, amounts, lineTaxes, gst, pst) => {
    const result = buildRevenueJournalEntries(
      document(mode, subtotal, taxTotal, total),
      lines(amounts, lineTaxes),
      [tax('gst', gst), tax('pst', pst)],
      options,
    );
    const grouped = amountsByAccount(result.entries);
    expect(grouped.ar).toEqual({ debit: total, credit: undefined });
    if (gst === 0) expect(grouped['tax-gst']).toBeUndefined();
    else expect(grouped['tax-gst']).toEqual({ debit: undefined, credit: gst });
    expect(grouped['tax-pst']).toEqual({ debit: undefined, credit: pst });
    expectBalanced(result.entries);
  });
});

describe('buildRevenueJournalEntries snapshot and direction invariants', () => {
  it('uses stored component accounts, falls back for an unmapped component, and posts provider tax once', () => {
    const liveCode = { liabilityAccountId: 'tax-gst' };
    const storedRows: RevenueJournalTaxInput[] = [
      { ...tax('gst', 5), liabilityAccountId: liveCode.liabilityAccountId },
      // A component frozen without a liability account posts to the
      // caller's fallback tax account.
      {
        currency: 'CAD',
        taxCodeId: 'pst-code',
        taxCodeCode: 'pst',
        taxComponentId: 'pst',
        liabilityAccountId: null,
        taxMinor: 7,
      },
    ];
    liveCode.liabilityAccountId = 'changed-after-issue';
    const result = buildRevenueJournalEntries(
      document('exclusive', 100, 15, 115, 3),
      [{ id: 'line', amountMinor: 100, taxMinor: 12 }],
      storedRows,
      options,
    );
    expect(
      result.entries.filter((row) => row.memo.startsWith('Provider tax')),
    ).toEqual([
      {
        accountId: 'tax-fallback',
        credit: 3,
        currency: 'CAD',
        memo: 'Provider tax: INV-1',
      },
    ]);
    // The unmapped component (7) and the provider tax (3) both land on the
    // fallback account.
    expect(
      result.entries
        .filter((row) => row.accountId === 'tax-fallback')
        .reduce((sum, row) => sum + (row.credit ?? 0), 0),
    ).toBe(10);
    expect(result.entries.some((row) => row.accountId === 'tax-gst')).toBe(
      true,
    );
    expect(
      result.entries.some(
        (row) => row.accountId === liveCode.liabilityAccountId,
      ),
    ).toBe(false);
  });

  it('normalizes signed credit documents and exact reversals without negative fields', () => {
    const source = buildRevenueJournalEntries(
      document('exclusive', -90, -5, -95),
      [{ id: 'credit', amountMinor: -90, taxMinor: -5 }],
      [tax('gst', -5)],
      options,
    );
    expect(amountsByAccount(source.entries)).toEqual({
      ar: { debit: undefined, credit: 95 },
      'revenue-default': { debit: 90, credit: undefined },
      'tax-gst': { debit: 5, credit: undefined },
    });
    const reversal = buildRevenueJournalEntries(
      document('exclusive', -90, -5, -95),
      [{ id: 'credit', amountMinor: -90, taxMinor: -5 }],
      [tax('gst', -5)],
      { ...options, direction: -1 },
    );
    expect(reversal.entries).toEqual(
      source.entries.map((row) => ({
        accountId: row.accountId,
        ...(row.debit === undefined
          ? { debit: row.credit }
          : { credit: row.debit }),
        currency: row.currency,
        memo: row.memo,
      })),
    );
    expectBalanced(source.entries);
    expectBalanced(reversal.entries);
  });

  it('groups signed line nets by override or fallback account', () => {
    const result = buildRevenueJournalEntries(
      document('exclusive', 80, 0, 80),
      [
        { id: 'a', amountMinor: 100, taxMinor: 0, revenueAccountId: 'rev-a' },
        { id: 'b', amountMinor: -20, taxMinor: 0, revenueAccountId: 'rev-a' },
        { id: 'zero', amountMinor: 0, taxMinor: 0 },
      ],
      [],
      options,
    );
    expect(amountsByAccount(result.entries)).toEqual({
      ar: { debit: 80, credit: undefined },
      'rev-a': { debit: undefined, credit: 80 },
    });
  });
});

describe('buildRevenueJournalEntries validation', () => {
  function expectCode(run: () => unknown, code: string): void {
    try {
      run();
      throw new Error('Expected validation error');
    } catch (cause) {
      expect(cause).toBeInstanceOf(MoneyValidationError);
      expect((cause as MoneyValidationError).code).toBe(code);
    }
  }

  it('rejects currency mismatch, nonzero null components, and unsafe values', () => {
    expectCode(
      () =>
        buildRevenueJournalEntries(document('exclusive', 0, 0, 0), [], [], {
          ...options,
          bookCurrency: 'USD',
        }),
      'CURRENCY_MISMATCH',
    );
    expectCode(
      () =>
        buildRevenueJournalEntries(
          document('exclusive', 0, 1, 1),
          [{ id: 'line', amountMinor: 0, taxMinor: 1 }],
          [
            {
              currency: 'CAD',
              taxCodeId: 'broken',
              taxCodeCode: 'BROKEN',
              taxComponentId: null,
              liabilityAccountId: null,
              taxMinor: 1,
            },
          ],
          options,
        ),
      'INVALID_MONEY_INPUT',
    );
    expectCode(
      () =>
        buildRevenueJournalEntries(
          document(
            'exclusive',
            Number.MAX_SAFE_INTEGER,
            1,
            Number.MAX_SAFE_INTEGER,
          ),
          [],
          [],
          options,
        ),
      'INVALID_MONEY_INPUT',
    );
  });
});
