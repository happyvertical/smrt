import { describe, expect, it } from 'vitest';
import {
  calculateOrderedCostBillingTax as calculate,
  type OrderedCostBillingTaxInput,
} from '../cost-billing.js';

const input: OrderedCostBillingTaxInput = {
  roundingScope: 'invoice',
  invoiceAllocation: 'signed-largest-remainder',
  lines: [
    { id: 'a', amountMinor: 10, category: 'both' },
    { id: 'b', amountMinor: 10, category: 'first' },
  ],
  categories: [
    { category: 'both', componentIds: ['first', 'second'] },
    { category: 'first', componentIds: ['first'] },
    { category: 'second', componentIds: ['second'] },
    { category: 'exempt', componentIds: [] },
  ],
  components: [
    { id: 'first', percent: '5', priorComponentIds: [] },
    { id: 'second', percent: '100', priorComponentIds: ['first'] },
  ],
};

/** Small independent rational oracle: exhaustively compare residual placements. */
function oracle(numerators: bigint[], denominator: bigint): bigint[] {
  const total = numerators.reduce((sum, value) => sum + value, 0n);
  const magnitude = total < 0n ? -total : total;
  let rounded = magnitude / denominator;
  if ((magnitude % denominator) * 2n >= denominator) rounded++;
  if (total < 0n) rounded = -rounded;
  const base = numerators.map((value) => value / denominator);
  const delta = rounded - base.reduce((sum, value) => sum + value, 0n);
  if (delta === 0n) return base;
  const sign = delta < 0n ? -1n : 1n;
  let best: { error: bigint; indices: string; values: bigint[] } | undefined;
  for (let mask = 0; mask < 2 ** numerators.length; mask++) {
    const selected = base.map((_, index) => (mask >> index) & 1);
    if (
      BigInt(selected.reduce((sum, value) => sum + value, 0)) !==
      delta * sign
    )
      continue;
    const values = base.map(
      (value, index) => value + BigInt(selected[index]) * sign,
    );
    const error = values.reduce((sum, value, index) => {
      const difference = value * denominator - numerators[index];
      return sum + difference * difference;
    }, 0n);
    const indices = selected
      .flatMap((yes, index) => (yes ? [index] : []))
      .join(',');
    if (
      !best ||
      error < best.error ||
      (error === best.error && indices < best.indices)
    )
      best = { error, indices, values };
  }
  if (!best) throw new Error('Oracle could not conserve tax');
  return best.values;
}

describe('ordered cost billing tax public contract', () => {
  it('allocates the invoice remainder before compounding only the selected subset', () => {
    expect(calculate(input)).toEqual({
      taxMinor: 12,
      components: [
        {
          id: 'first',
          taxMinor: 1,
          lines: [
            { id: 'a', basisMinor: 10, taxMinor: 1 },
            { id: 'b', basisMinor: 10, taxMinor: 0 },
          ],
        },
        {
          id: 'second',
          taxMinor: 11,
          lines: [{ id: 'a', basisMinor: 11, taxMinor: 11 }],
        },
      ],
    });
    const otherSubset = calculate({
      ...input,
      lines: [
        { ...input.lines[0], category: 'first' },
        { ...input.lines[1], category: 'both' },
      ],
    });
    expect(otherSubset.components[1].lines).toEqual([
      { id: 'b', basisMinor: 10, taxMinor: 10 },
    ]);
  });

  it('uses line rounding only when explicitly selected and compounds named prior taxes', () => {
    const { invoiceAllocation: _, ...rest } = input;
    expect(calculate({ ...rest, roundingScope: 'line' }).taxMinor).toBe(13);
    const result = calculate({
      ...input,
      components: [
        ...input.components,
        { id: 'third', percent: '100', priorComponentIds: ['first', 'second'] },
        { id: 'net', percent: '100', priorComponentIds: [] },
      ],
      categories: [
        { category: 'both', componentIds: ['third', 'net', 'second', 'first'] },
      ],
      lines: [input.lines[0]],
    });
    expect(result.components.map((component) => component.taxMinor)).toEqual([
      1, 11, 22, 10,
    ]);
    expect(result.components[2].lines[0].basisMinor).toBe(22);
  });

  it('allows explicit exemption, absent prior membership, unused valid policy and empty invoices', () => {
    const result = calculate({
      ...input,
      lines: [
        { id: 'a', amountMinor: 100, category: 'second' },
        { id: 'b', amountMinor: 100, category: 'exempt' },
      ],
    });
    expect(result.components).toEqual([
      { id: 'first', taxMinor: 0, lines: [] },
      {
        id: 'second',
        taxMinor: 100,
        lines: [{ id: 'a', basisMinor: 100, taxMinor: 100 }],
      },
    ]);
    expect(calculate({ ...input, lines: [] })).toEqual({
      taxMinor: 0,
      components: [
        { id: 'first', taxMinor: 0, lines: [] },
        { id: 'second', taxMinor: 0, lines: [] },
      ],
    });
    expect(
      calculate({ ...input, lines: [], components: [], categories: [] }),
    ).toEqual({ taxMinor: 0, components: [] });
  });

  it('is independent of input line/category membership order, preserves inputs and retries exactly', () => {
    const frozen = structuredClone(input);
    for (const line of frozen.lines) Object.freeze(line);
    for (const category of frozen.categories) {
      Object.freeze(category.componentIds);
      Object.freeze(category);
    }
    for (const component of frozen.components) {
      Object.freeze(component.priorComponentIds);
      Object.freeze(component);
    }
    Object.freeze(frozen.lines);
    Object.freeze(frozen.categories);
    Object.freeze(frozen.components);
    Object.freeze(frozen);
    const expected = calculate(frozen);
    expect(calculate(frozen)).toEqual(expected);
    expect(
      calculate({
        ...input,
        lines: [...input.lines].reverse(),
        categories: [...input.categories].reverse().map((category) => ({
          ...category,
          componentIds: [...category.componentIds].reverse(),
        })),
      }),
    ).toEqual(expected);
    expect(frozen).toEqual(input);
  });

  it('conserves mixed signed allocations and reverses every component basis and allocation', () => {
    for (const amounts of [
      [10, 10],
      [-10, -10],
      [16, -6],
      [16, -16],
      [18, -4, 19],
      [0, 0],
    ]) {
      for (const scope of ['line', 'invoice'] as const) {
        const { invoiceAllocation: _, ...rest } = input;
        const policy =
          scope === 'line' ? { ...rest, roundingScope: scope } : input;
        const lines = amounts.map((amountMinor, index) => ({
          id: String(index),
          amountMinor,
          category: 'both',
        }));
        const result = calculate({ ...policy, lines });
        const reversed = calculate({
          ...policy,
          lines: lines.map((line) => ({
            ...line,
            amountMinor: -line.amountMinor,
          })),
        });
        expect(reversed.taxMinor).toBe(0 - result.taxMinor);
        for (const [index, component] of result.components.entries()) {
          expect(
            component.lines.reduce((sum, line) => sum + line.taxMinor, 0),
          ).toBe(component.taxMinor);
          expect(reversed.components[index].taxMinor).toBe(
            0 - component.taxMinor,
          );
          expect(reversed.components[index].lines).toEqual(
            component.lines.map((line) => ({
              id: line.id,
              basisMinor: 0 - line.basisMinor,
              taxMinor: 0 - line.taxMinor,
            })),
          );
        }
      }
    }
  });

  it('matches an exhaustive rational allocation oracle across signed small boundaries', () => {
    for (let a = -12; a <= 12; a += 3) {
      for (let b = -12; b <= 12; b += 3) {
        for (const percent of [0, 5, 25, 50, 100, 175]) {
          const amounts = [a, b, 10];
          const actual = calculate({
            ...input,
            components: [
              { id: 'first', percent: String(percent), priorComponentIds: [] },
            ],
            categories: [{ category: 'first', componentIds: ['first'] }],
            lines: amounts.map((amountMinor, index) => ({
              id: String(index),
              amountMinor,
              category: 'first',
            })),
          });
          expect(
            actual.components[0].lines.map((line) => BigInt(line.taxMinor)),
          ).toEqual(
            oracle(
              amounts.map((amount) => BigInt(amount * percent)),
              100n,
            ),
          );
        }
      }
    }
  });

  it('breaks ties by code-unit ID order and ranks unequal signed remainders', () => {
    for (const sign of [1, -1]) {
      const result = calculate({
        ...input,
        lines: ['a', 'Z', '10'].map((id) => ({
          id,
          amountMinor: sign * 10,
          category: 'first',
        })),
      });
      expect(
        result.components[0].lines.map((line) => [line.id, line.taxMinor]),
      ).toEqual([
        ['10', sign],
        ['Z', sign],
        ['a', 0],
      ]);
      const unequal = calculate({
        ...input,
        lines: [
          { id: 'a', amountMinor: sign * 11, category: 'first' },
          { id: 'b', amountMinor: sign * 19, category: 'first' },
        ],
      });
      expect(unequal.components[0].lines.map((line) => line.taxMinor)).toEqual([
        sign,
        sign,
      ]);
      const singleResidual = calculate({
        ...input,
        lines: [
          { id: 'a', amountMinor: sign * 1, category: 'first' },
          { id: 'b', amountMinor: sign * 19, category: 'first' },
        ],
      });
      expect(
        singleResidual.components[0].lines.map((line) => line.taxMinor),
      ).toEqual([0, sign]);
    }
  });

  it('keeps six-place percentages exact and permits safe boundaries with huge intermediates', () => {
    for (const sign of [1, -1]) {
      const result = calculate({
        ...input,
        lines: [{ id: 'a', amountMinor: sign * 150000000, category: 'first' }],
        categories: [{ category: 'first', componentIds: ['first'] }],
        components: [
          { id: 'first', percent: '0.000001', priorComponentIds: [] },
        ],
      });
      expect(result.taxMinor).toBe(sign * 2);
      const boundary = calculate({
        ...input,
        lines: [
          {
            id: 'a',
            amountMinor: sign * Number.MAX_SAFE_INTEGER,
            category: 'first',
          },
        ],
        categories: [{ category: 'first', componentIds: ['first'] }],
        components: [{ id: 'first', percent: '100', priorComponentIds: [] }],
      });
      expect(boundary.taxMinor).toBe(sign * Number.MAX_SAFE_INTEGER);
    }
  });

  it('rejects invalid configuration even when the invoice has no lines', () => {
    const invalid = [
      { roundingScope: 'unknown' },
      { invoiceAllocation: undefined },
      { invoiceAllocation: 'unknown' },
      { roundingScope: 'line', invoiceAllocation: 'signed-largest-remainder' },
      { roundingScope: 'line', invoiceAllocation: undefined },
      { lines: null },
      { categories: null },
      { components: null },
      { components: [input.components[0], input.components[0]] },
      { components: [{ id: '', percent: '5', priorComponentIds: [] }] },
      { components: [{ id: 'first', percent: '5' }] },
      {
        components: [{ ...input.components[0], priorComponentIds: ['first'] }],
      },
      {
        components: [
          { ...input.components[0], priorComponentIds: ['unknown'] },
        ],
      },
      {
        components: [
          { ...input.components[0], priorComponentIds: ['second'] },
          input.components[1],
        ],
      },
      {
        components: [
          input.components[0],
          { ...input.components[1], priorComponentIds: ['first', 'first'] },
        ],
      },
      { categories: [input.categories[0], input.categories[0]] },
      { categories: [{ category: '', componentIds: [] }] },
      { categories: [{ category: 'unknown', componentIds: ['unknown'] }] },
      { categories: [{ category: 'dup', componentIds: ['first', 'first'] }] },
      { categories: [{ category: 'missing' }] },
      ...['-1', '1e2', '0.0000001', '100000.000001', '05', ' 5', null, 5].map(
        (percent) => ({
          components: [{ ...input.components[0], percent }],
        }),
      ),
    ];
    for (const override of invalid)
      expect(() =>
        calculate({
          ...input,
          lines: [],
          ...override,
        } as OrderedCostBillingTaxInput),
      ).toThrow();
  });

  it('rejects invalid lines and unsafe bases, allocations, component totals and invoice totals', () => {
    for (const lines of [
      [input.lines[0], input.lines[0]],
      [{ ...input.lines[0], id: '' }],
      [{ ...input.lines[0], category: 'unknown' }],
      ...[NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1].map(
        (amountMinor) => [{ ...input.lines[0], amountMinor }],
      ),
    ])
      expect(() => calculate({ ...input, lines })).toThrow();
    const max = Number.MAX_SAFE_INTEGER;
    const one = { category: 'all', componentIds: ['first'] };
    const tax = { id: 'first', percent: '100', priorComponentIds: [] };
    for (const sign of [1, -1]) {
      const line = { id: 'a', amountMinor: sign * max, category: 'all' };
      const base = {
        ...input,
        categories: [one],
        lines: [line],
        components: [tax],
      };
      expect(() =>
        calculate({ ...base, components: [{ ...tax, percent: '100000' }] }),
      ).toThrow(RangeError);
      expect(() =>
        calculate({ ...base, lines: [line, { ...line, id: 'b' }] }),
      ).toThrow(RangeError);
      // Component aggregate cancels, but its individual allocations are still unsafe.
      expect(() =>
        calculate({
          ...base,
          components: [{ ...tax, percent: '100000' }],
          lines: [line, { ...line, id: 'b', amountMinor: -line.amountMinor }],
        }),
      ).toThrow(RangeError);
      expect(() =>
        calculate({
          ...base,
          categories: [{ ...one, componentIds: ['first', 'second'] }],
          components: [
            tax,
            { id: 'second', percent: '0', priorComponentIds: ['first'] },
          ],
        }),
      ).toThrow(RangeError); // Unsafe compound basis even at zero rate.
      expect(() =>
        calculate({
          ...base,
          categories: [{ ...one, componentIds: ['first', 'second'] }],
          components: [
            tax,
            { id: 'second', percent: '100', priorComponentIds: [] },
          ],
        }),
      ).toThrow(RangeError); // Individually safe components, unsafe total.
    }
  });

  it('exposes the new calculator through the built independent entry point', async () => {
    const api = await import('@happyvertical/smrt-commerce/cost-billing');
    expect(api.calculateOrderedCostBillingTax(input)).toEqual(calculate(input));
  });
});
