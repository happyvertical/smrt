import { describe, expect, it } from 'vitest';
import {
  calculateCostBilling,
  calculateCostBillingTax,
  resolveCostMarkup,
} from '../cost-billing.js';

const markup = resolveCostMarkup([
  { source: 'agreement', policy: 'p1', version: 'v2', percent: '10' },
]);
const rules = [
  { category: 'standard', components: [{ id: 'tax', percent: '5' }] },
];
const lines = [
  { id: 'a', amountMinor: 10, category: 'standard' },
  { id: 'b', amountMinor: 10, category: 'standard' },
];

describe('public exact cost billing', () => {
  it('calculates explicit modes with principal included exactly once', () => {
    for (const [mode, principalMinor, feeMinor, totalMinor] of [
      ['reimbursement-plus-fee', 1000, 100, 1100],
      ['fee-only', 0, 100, 100],
      ['nonbillable', 0, 0, 0],
      ['fixed-contract', 0, 0, 0],
    ] as const) {
      expect(
        calculateCostBilling({ basisMinor: 1000, mode, markup }),
      ).toMatchObject({ principalMinor, feeMinor, totalMinor });
    }
  });
  it('selects ordered explicit zero without mutating or aliasing provenance', () => {
    const overrides = [
      { source: 'line' },
      { source: 'agreement', percent: '0', policy: 'p', version: 'v' },
      { source: 'fallback', percent: '15' },
    ];
    const result = resolveCostMarkup(overrides);
    expect(result).toEqual({ percent: '0', selectedIndex: 1, overrides });
    result.overrides[1].percent = '20';
    expect(overrides[1].percent).toBe('0');
    expect(() => resolveCostMarkup([{ source: 'none' }])).toThrow();
    expect(() =>
      resolveCostMarkup([
        { source: 'a', percent: '0' },
        { source: 'b', percent: 'bad' },
      ]),
    ).toThrow();
    expect(() => resolveCostMarkup([{ source: '', percent: '0' }])).toThrow();
    expect(() =>
      calculateCostBilling({
        basisMinor: 1,
        mode: 'fee-only',
        markup: { ...markup, percent: '99' },
      }),
    ).toThrow();
  });
  it.each([
    '1e2',
    '-1',
    ' 5',
    '5 ',
    '01',
    '.5',
    '1.',
    'NaN',
    'Infinity',
    '0.0000001',
    '100000.000001',
    5,
    null,
  ])('rejects malformed percent %s', (percent) => {
    expect(() =>
      resolveCostMarkup([{ source: 'test', percent: percent as string }]),
    ).toThrow();
  });
  it('uses exact bounded decimal multiplication and signed tie rounding', () => {
    const precise = resolveCostMarkup([
      { source: 'test', percent: '0.000001' },
    ]);
    expect(
      calculateCostBilling({
        basisMinor: 150000000,
        mode: 'fee-only',
        markup: precise,
      }).feeMinor,
    ).toBe(2);
    const half = resolveCostMarkup([{ source: 'test', percent: '50' }]);
    for (let basisMinor = 1; basisMinor < 1000; basisMinor += 7) {
      const positive = calculateCostBilling({
        basisMinor,
        mode: 'reimbursement-plus-fee',
        markup: half,
      });
      const negative = calculateCostBilling({
        basisMinor: -basisMinor,
        mode: 'reimbursement-plus-fee',
        markup: half,
      });
      expect(positive.totalMinor).toBe(basisMinor + Math.ceil(basisMinor / 2));
      expect(negative.totalMinor).toBe(-positive.totalMinor);
    }
  });
  it('rejects unsafe money, overflowing outputs and unknown modes', () => {
    for (const basisMinor of [
      0.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() =>
        calculateCostBilling({ basisMinor, mode: 'nonbillable', markup }),
      ).toThrow();
    }
    expect(() =>
      calculateCostBilling({
        basisMinor: Number.MAX_SAFE_INTEGER,
        mode: 'reimbursement-plus-fee',
        markup,
      }),
    ).toThrow();
    expect(() =>
      calculateCostBilling({ basisMinor: 1, mode: 'unknown' as never, markup }),
    ).toThrow();
    const zero = resolveCostMarkup([{ source: 'test', percent: '0' }]);
    expect(
      calculateCostBilling({
        basisMinor: Number.MAX_SAFE_INTEGER,
        mode: 'reimbursement-plus-fee',
        markup: zero,
      }).totalMinor,
    ).toBe(Number.MAX_SAFE_INTEGER);
  });
  it('distinguishes line and invoice tax rounding and reverses signed tax', () => {
    for (const [roundingScope, expected] of [
      ['line', 2],
      ['invoice', 1],
    ] as const) {
      expect(
        calculateCostBillingTax({ lines, rules, roundingScope }).taxMinor,
      ).toBe(expected);
      expect(
        calculateCostBillingTax({
          lines: lines.map((line) => ({
            ...line,
            amountMinor: -line.amountMinor,
          })),
          rules,
          roundingScope,
        }).taxMinor,
      ).toBe(-expected);
    }
  });
  it('maps multiple categories and additive components explicitly, including exemption', () => {
    const result = calculateCostBillingTax({
      roundingScope: 'invoice',
      lines: [
        { id: 'a', amountMinor: 100, category: 'both' },
        { id: 'b', amountMinor: 100, category: 'one' },
        { id: 'c', amountMinor: 1000, category: 'exempt' },
      ],
      rules: [
        {
          category: 'both',
          components: [
            { id: 'a', percent: '5' },
            { id: 'b', percent: '10' },
          ],
        },
        { category: 'one', components: [{ id: 'a', percent: '5.0' }] },
        { category: 'exempt', components: [] },
      ],
    });
    expect(result).toEqual({
      taxMinor: 20,
      components: [
        { id: 'a', taxMinor: 10 },
        { id: 'b', taxMinor: 10 },
      ],
    });
    expect(
      calculateCostBillingTax({
        lines: [],
        rules: [],
        roundingScope: 'invoice',
      }).taxMinor,
    ).toBe(0);
  });
  it('fails closed on ambiguous tax contracts and unsafe results', () => {
    const input = { lines, rules, roundingScope: 'line' as const };
    for (const invalid of [
      { ...input, rules: [] },
      { ...input, roundingScope: 'unknown' },
      { ...input, lines: [lines[0], lines[0]] },
      { ...input, rules: [rules[0], rules[0]] },
      {
        ...input,
        rules: [
          {
            category: 'standard',
            components: [
              { id: 'tax', percent: '5' },
              { id: 'tax', percent: '5' },
            ],
          },
        ],
      },
      {
        ...input,
        rules: [
          ...rules,
          { category: 'other', components: [{ id: 'tax', percent: '10' }] },
        ],
      },
      {
        ...input,
        lines: [{ ...lines[0], amountMinor: Number.MAX_SAFE_INTEGER }],
        rules: [
          {
            category: 'standard',
            components: [{ id: 'tax', percent: '100000' }],
          },
        ],
      },
    ])
      expect(() => calculateCostBillingTax(invalid as typeof input)).toThrow();
  });
  it('keeps inputs immutable and aggregates invoice components independently of line order', () => {
    const input = {
      lines: Array.from({ length: 80 }, (_, index) => ({
        id: String(index),
        amountMinor: (index % 2 === 0 ? 1 : -1) * (index * 37 + 5),
        category: 'standard',
      })),
      rules,
      roundingScope: 'invoice' as const,
    };
    const snapshot = JSON.stringify(input);
    const result = calculateCostBillingTax(input);
    expect(
      calculateCostBillingTax({ ...input, lines: [...input.lines].reverse() }),
    ).toEqual(result);
    const sum = input.lines.reduce(
      (total, line) => total + line.amountMinor,
      0,
    );
    expect(result).toEqual(
      calculateCostBillingTax({
        ...input,
        lines: [{ id: 'sum', amountMinor: sum, category: 'standard' }],
      }),
    );
    expect(JSON.stringify(input)).toBe(snapshot);
    const costInput = { basisMinor: -105, mode: 'fee-only' as const, markup };
    const costSnapshot = JSON.stringify(costInput);
    expect(calculateCostBilling(costInput).feeMinor).toBe(-11);
    expect(JSON.stringify(costInput)).toBe(costSnapshot);
    expect(
      resolveCostMarkup([{ source: 'boundary', percent: '100000' }]).percent,
    ).toBe('100000');
  });
  it('exports a built standalone package contract', async () => {
    const api = await import('@happyvertical/smrt-commerce/cost-billing');
    expect(
      api.calculateCostBilling({ basisMinor: 1000, mode: 'fee-only', markup })
        .totalMinor,
    ).toBe(100);
    expect(Object.keys(api).sort()).toEqual([
      'calculateCostBilling',
      'calculateCostBillingTax',
      'resolveCostMarkup',
    ]);
  });
});
