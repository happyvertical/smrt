import { describe, expect, it } from 'vitest';
import { calculateOrderedCostBillingTax } from '../cost-billing.js';
import {
  calculateMoneyDocument,
  type MoneyLineInput,
  type TaxRoundingScope,
} from '../money.js';

const a = { taxComponentId: 'a', percent: '5', compound: false };
const b = { taxComponentId: 'b', percent: '7', compound: true };
const line = (
  id: string,
  amount: number,
  components = [a, b],
): MoneyLineInput => ({
  id,
  quantity: 1,
  unitPrice: amount,
  discount: { kind: 'none' },
  taxCode: {
    id: components.map((p) => p.taxComponentId).join('-'),
    kind: 'taxable',
    components,
  },
});
const calc = (
  lines: MoneyLineInput[],
  scope: TaxRoundingScope = 'line',
  type: 'exclusive' | 'inclusive' = 'exclusive',
) =>
  calculateMoneyDocument({
    currency: 'CAD',
    lineAmountType: type,
    roundingScope: scope,
    lines,
  });
describe('ordered compound money (#4065)', () => {
  it('preserves category subsets and actual taxable bases without inflating net', () => {
    const result = calc([
      line('work', 10000),
      line('exempt-from-a', 1000, [b]),
    ]);
    expect(result).toMatchObject({
      subtotalMinor: 11000,
      taxMinor: 1305,
      totalMinor: 12305,
    });
    expect(result.taxes).toContainEqual({
      taxCodeId: 'a-b',
      taxComponentId: 'b',
      taxableMinor: 10500,
      netMinor: 10000,
      taxMinor: 735,
    });
  });
  it('uses prior allocated pennies before computing a later component', () => {
    const result = calc(
      [line('a', 10, [a, { ...b, percent: '100' }]), line('b', 10, [a])],
      'document',
    );
    expect(result.taxMinor).toBe(12);
    expect(result.lines[0].components[1]).toMatchObject({
      taxableMinor: 11,
      taxMinor: 11,
      compound: true,
    });
    expect(
      calc(
        [line('b', 10, [a]), line('a', 10, [a, { ...b, percent: '100' }])],
        'document',
      ).taxes,
    ).toEqual(result.taxes);
  });
  it('matches the established ordered calculator across signed subsets', () => {
    for (const scope of ['line', 'document'] as const)
      for (const sign of [1, -1]) {
        const source = [
          line('a', sign * 10),
          line('b', sign * 10007),
          line('c', sign * 319, [b]),
        ];
        const expected = calculateOrderedCostBillingTax({
          ...(scope === 'line'
            ? { roundingScope: 'line' as const }
            : {
                roundingScope: 'invoice' as const,
                invoiceAllocation: 'signed-largest-remainder' as const,
              }),
          components: [
            { id: 'a', percent: '5', priorComponentIds: [] },
            { id: 'b', percent: '7', priorComponentIds: ['a'] },
          ],
          categories: [
            { category: 'both', componentIds: ['a', 'b'] },
            { category: 'b', componentIds: ['b'] },
          ],
          lines: source.map((p) => ({
            id: p.id,
            amountMinor: p.unitPrice,
            category: p.id === 'c' ? 'b' : 'both',
          })),
        });
        const actual = calc(source, scope);
        expect(actual.taxMinor).toBe(expected.taxMinor);
        for (const component of expected.components)
          for (const entry of component.lines)
            expect(
              actual.lines
                .find((p) => p.id === entry.id)
                ?.components.find((p) => p.taxComponentId === component.id)
                ?.taxMinor,
            ).toBe(entry.taxMinor);
      }
  });
  it('extracts inclusive ordered factors and conserves signed discounted gross', () => {
    for (const scope of ['line', 'document'] as const) {
      expect(calc([line('a', 11235)], scope, 'inclusive')).toMatchObject({
        subtotalMinor: 10000,
        taxMinor: 1235,
        totalMinor: 11235,
      });
      for (const amount of [1, 2, 9, 10, 11, 101, 11235]) {
        const positive = calc(
          [
            { ...line('a', amount), discount: { kind: 'percent', rate: '10' } },
            line('b', 19, [b]),
          ],
          scope,
          'inclusive',
        );
        const negative = calc(
          [
            {
              ...line('a', -amount),
              discount: { kind: 'percent', rate: '10' },
            },
            line('b', -19, [b]),
          ],
          scope,
          'inclusive',
        );
        expect(negative.totalMinor).toBe(-positive.totalMinor);
        expect(negative.taxMinor).toBe(-positive.taxMinor);
        expect(negative.subtotalMinor).toBe(-positive.subtotalMinor);
        expect(positive.subtotalMinor + positive.taxMinor).toBe(
          positive.totalMinor,
        );
        for (let i = 0; i < positive.lines.length; i++)
          expect(
            negative.lines[i].components.map((p) => p.taxMinor || 0),
          ).toEqual(positive.lines[i].components.map((p) => -p.taxMinor || 0));
      }
    }
  });
  it('uses explicit net for inclusive amount credits and rejects cycles/overflow', () => {
    expect(
      calc(
        [{ ...line('a', 1), netAmountMinor: 10000 }],
        'document',
        'inclusive',
      ),
    ).toMatchObject({
      subtotalMinor: 10000,
      taxMinor: 1235,
      totalMinor: 11235,
    });
    expect(() =>
      calc([line('a', 10), line('b', 10, [b, { ...a, compound: true }])]),
    ).toThrow('contradictory');
    expect(() => calc([line('a', Number.MAX_SAFE_INTEGER)])).toThrow();
  });
});
