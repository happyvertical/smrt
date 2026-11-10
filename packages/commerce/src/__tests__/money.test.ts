import { describe, expect, it } from 'vitest';
import {
  calculateMoneyDocument,
  type MoneyDocumentResult,
  type MoneyLineInput,
  type MoneyValidationCode,
  MoneyValidationError,
  type ResolvableTaxCodeInput,
  resolveLineTaxCode,
} from '../money.js';

const gst = { taxComponentId: 'gst', percent: '5', compound: false } as const;
const pst = { taxComponentId: 'pst', percent: '7', compound: false } as const;
const gstCode = { id: 'gst', kind: 'taxable', components: [gst] } as const;
const gstPstCode = {
  id: 'gst-pst',
  kind: 'taxable',
  components: [gst, pst],
} as const;
const exemptCode = { id: 'exempt', kind: 'exempt', components: [] } as const;
const outCode = {
  id: 'out-of-scope',
  kind: 'out-of-scope',
  components: [],
} as const;

const exampleLines: readonly MoneyLineInput[] = [
  {
    id: '1',
    quantity: 10,
    unitPrice: 8500,
    discount: { kind: 'percent', rate: '10' },
    taxCode: gstCode,
  },
  {
    id: '2',
    quantity: 2,
    unitPrice: 4999,
    discount: { kind: 'amount', minor: 500 },
    taxCode: gstPstCode,
  },
  {
    id: '3',
    quantity: 12,
    unitPrice: 2000,
    discount: { kind: 'none' },
    taxCode: gstPstCode,
  },
  {
    id: '4',
    quantity: 1,
    unitPrice: 4500,
    discount: { kind: 'none' },
    taxCode: gstCode,
  },
];

function calculate(
  lines: readonly MoneyLineInput[],
  lineAmountType: 'exclusive' | 'inclusive' | 'none',
  roundingScope: 'line' | 'document',
): MoneyDocumentResult {
  return calculateMoneyDocument({
    currency: 'CAD',
    lineAmountType,
    roundingScope,
    lines,
  });
}

function expectCode(run: () => unknown, code: MoneyValidationCode): void {
  try {
    run();
    throw new Error('Expected validation error');
  } catch (cause) {
    expect(cause).toBeInstanceOf(MoneyValidationError);
    expect((cause as MoneyValidationError).code).toBe(code);
  }
}

describe('commercial money goldens', () => {
  it('exports the independent package entry', async () => {
    const api = await import('@happyvertical/smrt-commerce/money');
    expect(api.calculateMoneyDocument).toBeTypeOf('function');
    expect(api.resolveLineTaxCode).toBeTypeOf('function');
    expect(api.MoneyValidationError).toBeTypeOf('function');
  });

  it('matches example A exclusive under both scopes', () => {
    for (const scope of ['line', 'document'] as const) {
      const result = calculate(exampleLines, 'exclusive', scope);
      expect(result.lines).toEqual([
        {
          id: '1',
          grossMinor: 85000,
          discountMinor: 8500,
          amountMinor: 76500,
          components: [{ taxComponentId: 'gst', taxMinor: 3825 }],
          taxMinor: 3825,
          netMinor: 76500,
        },
        {
          id: '2',
          grossMinor: 9998,
          discountMinor: 500,
          amountMinor: 9498,
          components: [
            { taxComponentId: 'gst', taxMinor: 475 },
            { taxComponentId: 'pst', taxMinor: 665 },
          ],
          taxMinor: 1140,
          netMinor: 9498,
        },
        {
          id: '3',
          grossMinor: 24000,
          discountMinor: 0,
          amountMinor: 24000,
          components: [
            { taxComponentId: 'gst', taxMinor: 1200 },
            { taxComponentId: 'pst', taxMinor: 1680 },
          ],
          taxMinor: 2880,
          netMinor: 24000,
        },
        {
          id: '4',
          grossMinor: 4500,
          discountMinor: 0,
          amountMinor: 4500,
          components: [{ taxComponentId: 'gst', taxMinor: 225 }],
          taxMinor: 225,
          netMinor: 4500,
        },
      ]);
      expect(result).toMatchObject({
        subtotalMinor: 114498,
        discountTotalMinor: 9000,
        taxMinor: 8070,
        totalMinor: 122568,
      });
    }
  });

  it('matches example B inclusive and assigns the document GST cent by stable remainder', () => {
    const line = calculate(exampleLines, 'inclusive', 'line');
    expect(
      line.lines.map((row) => [row.id, row.taxMinor, row.netMinor]),
    ).toEqual([
      ['1', 3643, 72857],
      ['2', 1018, 8480],
      ['3', 2571, 21429],
      ['4', 214, 4286],
    ]);
    expect(line).toMatchObject({
      subtotalMinor: 107052,
      taxMinor: 7446,
      totalMinor: 114498,
    });
    const document = calculate(exampleLines, 'inclusive', 'document');
    expect(document.lines[2]).toMatchObject({
      components: [
        { taxComponentId: 'gst', taxMinor: 1072 },
        { taxComponentId: 'pst', taxMinor: 1500 },
      ],
      netMinor: 21428,
    });
    expect(document).toMatchObject({
      subtotalMinor: 107051,
      taxMinor: 7447,
      totalMinor: 114498,
    });
    expect(document.taxes).toEqual([
      {
        taxCodeId: 'gst',
        taxComponentId: 'gst',
        taxableMinor: 77143,
        taxMinor: 3857,
      },
      {
        taxCodeId: 'gst-pst',
        taxComponentId: 'gst',
        taxableMinor: 29908,
        taxMinor: 1496,
      },
      {
        taxCodeId: 'gst-pst',
        taxComponentId: 'pst',
        taxableMinor: 29908,
        taxMinor: 2094,
      },
    ]);
  });

  it('matches examples C and D and emits the non-taxable reporting row', () => {
    const exemptLines = exampleLines.map((line) => ({
      ...line,
      taxCode: exemptCode,
    }));
    for (const mode of ['exclusive', 'inclusive'] as const) {
      for (const scope of ['line', 'document'] as const) {
        const result = calculate(exemptLines, mode, scope);
        expect(result).toMatchObject({
          subtotalMinor: 114498,
          taxMinor: 0,
          totalMinor: 114498,
        });
        expect(result.taxes).toEqual([
          {
            taxCodeId: 'exempt',
            taxComponentId: null,
            taxableMinor: 114498,
            taxMinor: 0,
          },
        ]);
      }
    }
  });

  it('matches example E under every mode and scope', () => {
    const lines = ['a', 'b', 'c'].map((id) => ({
      id,
      quantity: 1,
      unitPrice: 10,
      discount: { kind: 'none' } as const,
      taxCode: gstPstCode,
    }));
    expect(calculate(lines, 'exclusive', 'line')).toMatchObject({
      subtotalMinor: 30,
      taxMinor: 6,
      totalMinor: 36,
    });
    expect(calculate(lines, 'exclusive', 'document')).toMatchObject({
      subtotalMinor: 30,
      taxMinor: 4,
      totalMinor: 34,
    });
    expect(calculate(lines, 'inclusive', 'line')).toMatchObject({
      subtotalMinor: 27,
      taxMinor: 3,
      totalMinor: 30,
    });
    expect(calculate(lines, 'inclusive', 'document')).toMatchObject({
      subtotalMinor: 27,
      taxMinor: 3,
      totalMinor: 30,
    });
  });

  it('covers shipping, none mode, currency labels, and negative half-unit credits', () => {
    const shipping = calculate(
      [
        ...exampleLines,
        {
          id: '5',
          quantity: 1,
          unitPrice: 1250,
          discount: { kind: 'none' },
          taxCode: gstCode,
        },
      ],
      'exclusive',
      'line',
    );
    expect(shipping).toMatchObject({
      subtotalMinor: 115748,
      taxMinor: 8133,
      totalMinor: 123881,
    });
    const none = calculate(
      exampleLines.map((line) => ({ ...line, taxCode: outCode })),
      'none',
      'document',
    );
    expect(none.taxes).toEqual([
      {
        taxCodeId: 'out-of-scope',
        taxComponentId: null,
        taxableMinor: 114498,
        taxMinor: 0,
      },
    ]);
    for (const currency of ['JPY', 'KWD']) {
      const result = calculateMoneyDocument({
        currency,
        lineAmountType: 'exclusive',
        roundingScope: 'line',
        lines: [
          {
            id: 'credit',
            quantity: 0.5,
            unitPrice: -25,
            discount: { kind: 'none' },
            taxCode: exemptCode,
          },
        ],
      });
      expect(result.lines[0].grossMinor).toBe(-13);
    }
  });

  it('represents an unassigned exclusive line without a synthetic tax code', () => {
    const result = calculate(
      [
        {
          id: 'unassigned',
          quantity: 2,
          unitPrice: 125,
          discount: { kind: 'none' },
          taxCode: null,
        },
      ],
      'exclusive',
      'document',
    );
    expect(result).toMatchObject({
      subtotalMinor: 250,
      taxMinor: 0,
      totalMinor: 250,
    });
    expect(result.lines[0]).toMatchObject({
      amountMinor: 250,
      components: [],
      taxMinor: 0,
      netMinor: 250,
    });
    expect(result.taxes).toEqual([
      {
        taxCodeId: null,
        taxComponentId: null,
        taxableMinor: 250,
        taxMinor: 0,
      },
    ]);
    expectCode(
      () =>
        calculate(
          [
            {
              id: 'missing-out-of-scope',
              quantity: 1,
              unitPrice: 100,
              discount: { kind: 'none' },
              taxCode: null,
            },
          ],
          'none',
          'line',
        ),
      'TAX_CODE_NOT_FOUND',
    );
  });
});

describe('validation and tax-code resolution', () => {
  const line = exampleLines[0];
  it('uses stable validation codes', () => {
    expectCode(
      () =>
        calculate(
          [
            {
              ...line,
              discount: { kind: 'percent', rate: '10', minor: 1 },
            } as unknown as MoneyLineInput,
          ],
          'exclusive',
          'line',
        ),
      'DISCOUNT_BOTH_FORMS',
    );
    expectCode(
      () =>
        calculate(
          [{ ...line, discount: { kind: 'amount', minor: -1 } }],
          'exclusive',
          'line',
        ),
      'DISCOUNT_SIGN',
    );
    expectCode(
      () =>
        calculate(
          [{ ...line, discount: { kind: 'amount', minor: 100000 } }],
          'exclusive',
          'line',
        ),
      'DISCOUNT_EXCEEDS_GROSS',
    );
    expectCode(
      () =>
        calculate(
          [
            {
              ...line,
              taxCode: { ...gstCode, components: [{ ...gst, percent: '101' }] },
            },
          ],
          'exclusive',
          'line',
        ),
      'PERCENT_OUT_OF_RANGE',
    );
    expectCode(
      () =>
        calculate(
          [{ ...line, taxCode: { ...gstCode, components: [gst, gst] } }],
          'exclusive',
          'line',
        ),
      'TAX_CODE_DUPLICATE_COMPONENT',
    );
    expectCode(
      () =>
        calculate(
          [{ ...line, taxCode: { ...exemptCode, components: [gst] } }],
          'exclusive',
          'line',
        ),
      'TAX_CODE_NON_TAXABLE_COMPONENTS',
    );
    expectCode(
      () =>
        calculate(
          [{ ...line, taxCode: { ...gstCode, components: [] } }],
          'exclusive',
          'line',
        ),
      'TAX_CODE_TAXABLE_EMPTY',
    );
    expectCode(
      () =>
        calculate(
          [{ ...line, unitPrice: Number.MAX_SAFE_INTEGER, quantity: 2 }],
          'exclusive',
          'line',
        ),
      'UNSAFE_MONEY',
    );
    expectCode(
      () =>
        calculateMoneyDocument({
          currency: 'AAA',
          lineAmountType: 'exclusive',
          roundingScope: 'line',
          lines: [line],
        }),
      'CURRENCY_MISMATCH',
    );
    expectCode(
      () => calculate([line, line], 'exclusive', 'line'),
      'INVALID_MONEY_INPUT',
    );
    expectCode(
      () =>
        calculate(
          [
            line,
            {
              ...line,
              id: 'conflict',
              taxCode: {
                ...gstCode,
                id: 'conflict',
                components: [{ ...gst, percent: '6' }],
              },
            },
          ],
          'exclusive',
          'line',
        ),
      'TAX_COMPONENT_RATE_CONFLICT',
    );
  });

  it('resolves precedence, none override, inactive state, and direction', () => {
    const code = (
      id: string,
      kind: ResolvableTaxCodeInput['kind'] = 'taxable',
    ): ResolvableTaxCodeInput => ({
      id,
      kind,
      components: kind === 'taxable' ? [gst] : [],
      active: true,
      appliesTo: 'both',
    });
    const codes = {
      line: code('line'),
      exempt: code('exempt', 'exempt'),
      product: code('product'),
      customer: code('customer'),
      app: code('app'),
      out: code('out', 'out-of-scope'),
      inactive: { ...code('inactive'), active: false },
      purchase: { ...code('purchase'), appliesTo: 'purchases' as const },
    };
    const context = {
      direction: 'sales' as const,
      codes,
      customerTaxExempt: true,
      exemptCodeId: 'exempt',
      productCodeId: 'product',
      partyCodeId: 'customer',
      appDefaultCodeId: 'app',
      outOfScopeCodeId: 'out',
    };
    expect(
      resolveLineTaxCode(
        { lineAmountType: 'exclusive', lineOverride: 'line' },
        context,
      ),
    ).toMatchObject({ source: 'line', taxCode: { id: 'line' } });
    expect(
      resolveLineTaxCode({ lineAmountType: 'exclusive' }, context),
    ).toMatchObject({ source: 'exempt-customer', taxCode: { id: 'exempt' } });
    expect(
      resolveLineTaxCode(
        { lineAmountType: 'none', lineOverride: 'line' },
        context,
      ),
    ).toMatchObject({ source: 'none', taxCode: { id: 'out' } });
    expectCode(
      () =>
        resolveLineTaxCode(
          { lineAmountType: 'exclusive', lineOverride: 'inactive' },
          context,
        ),
      'TAX_CODE_INACTIVE',
    );
    expectCode(
      () =>
        resolveLineTaxCode(
          { lineAmountType: 'exclusive', lineOverride: 'purchase' },
          context,
        ),
      'TAX_CODE_SCOPE',
    );
    expectCode(
      () =>
        resolveLineTaxCode(
          { lineAmountType: 'exclusive' },
          { ...context, exemptCodeId: null },
        ),
      'TAX_CODE_NOT_FOUND',
    );
    expectCode(
      () =>
        resolveLineTaxCode(
          { lineAmountType: 'none' },
          { ...context, outOfScopeCodeId: null },
        ),
      'TAX_CODE_NOT_FOUND',
    );
    expectCode(
      () =>
        resolveLineTaxCode(
          { lineAmountType: 'none' },
          { ...context, outOfScopeCodeId: 'line' },
        ),
      'TAX_CODE_KIND',
    );
    expectCode(
      () =>
        resolveLineTaxCode(
          { lineAmountType: 'exclusive', lineOverride: 'missing' },
          context,
        ),
      'TAX_CODE_NOT_FOUND',
    );
    expect(
      resolveLineTaxCode(
        { lineAmountType: 'exclusive' },
        {
          direction: 'sales',
          codes,
          customerTaxExempt: false,
        },
      ),
    ).toEqual({ taxCode: null, source: 'none' });
  });
});

describe('seeded properties', () => {
  it('holds exact identities, signed reversal, stable allocation, and idempotency for 10k cases', () => {
    let seed = 0x3932_2026;
    const next = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    for (let iteration = 0; iteration < 10_000; iteration++) {
      const count = 1 + (next() % 5);
      const sharedRate = `${next() % 26}.${String(next() % 1_000_000).padStart(6, '0')}`;
      const lines: MoneyLineInput[] = Array.from(
        { length: count },
        (_, index) => {
          const unitPrice = 1 + (next() % 100_000);
          return {
            id: `line-${String(index).padStart(2, '0')}`,
            quantity: (1 + (next() % 1000)) / 100,
            unitPrice,
            discount: { kind: 'percent', rate: String(next() % 51) },
            taxCode: {
              id: `code-${index % 2}`,
              kind: 'taxable',
              components: [
                {
                  taxComponentId: 'shared',
                  percent: sharedRate,
                  compound: false,
                },
              ],
            },
          };
        },
      );
      const mode = next() % 2 ? 'exclusive' : 'inclusive';
      const scope = next() % 2 ? 'line' : 'document';
      const result = calculate(lines, mode, scope);
      expect(result.subtotalMinor + result.taxMinor).toBe(result.totalMinor);
      expect(result.lines.reduce((sum, row) => sum + row.netMinor, 0)).toBe(
        result.subtotalMinor,
      );
      expect(result.lines.reduce((sum, row) => sum + row.taxMinor, 0)).toBe(
        result.taxMinor,
      );
      expect(result.taxes.reduce((sum, row) => sum + row.taxMinor, 0)).toBe(
        result.taxMinor,
      );
      if (mode === 'inclusive')
        expect(
          result.lines.reduce((sum, row) => sum + row.amountMinor, 0),
        ).toBe(result.totalMinor);
      expect(calculate(lines, mode, scope)).toEqual(result);
      const lineScope = calculate(lines, mode, 'line');
      const documentScope = calculate(lines, mode, 'document');
      for (const line of lineScope.lines) {
        const allocated = documentScope.lines.find((row) => row.id === line.id);
        expect(allocated).toBeDefined();
        expect(
          Math.abs((allocated?.taxMinor ?? 0) - line.taxMinor),
        ).toBeLessThanOrEqual(1);
      }
      const reversed = calculate(
        lines.map((row) => ({ ...row, unitPrice: -row.unitPrice })),
        mode,
        scope,
      );
      expect(reversed.subtotalMinor + result.subtotalMinor).toBe(0);
      expect(reversed.discountTotalMinor + result.discountTotalMinor).toBe(0);
      expect(reversed.taxMinor + result.taxMinor).toBe(0);
      expect(reversed.totalMinor + result.totalMinor).toBe(0);
      const reordered = calculate([...lines].reverse(), mode, scope);
      const byId = (document: MoneyDocumentResult) =>
        Object.fromEntries(document.lines.map((row) => [row.id, row]));
      expect(byId(reordered)).toEqual(byId(result));
    }
  });
});
