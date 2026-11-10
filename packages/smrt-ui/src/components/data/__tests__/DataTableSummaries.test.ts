/**
 * Column summaries (`DataTable` `summaries`): the pure aggregates and the
 * footer row they build.
 */
import { describe, expect, it } from 'vitest';
import {
  averageDataTableColumn,
  buildDataTableSummaryRow,
  formatDataTableSummary,
  isNumericSummary,
  sumDataTableColumn,
  summarizeDataTableColumn,
} from '../DataTableSummaries.js';
import type { DataTableColumn } from '../types.js';

interface Line {
  id: string;
  item: string;
  qty: number | string | null;
  amount: number | null;
}

const rows: Line[] = [
  { id: 'a', item: 'Labour', qty: 2, amount: 54000 },
  { id: 'b', item: 'Shingles', qty: '1.5', amount: 12345 },
  { id: 'c', item: 'Note', qty: null, amount: null },
];
const item: DataTableColumn<Line> = { id: 'item', label: 'Item' };
const qty: DataTableColumn<Line> = { id: 'qty', label: 'Qty' };
const amount: DataTableColumn<Line> = { id: 'amount', label: 'Amount' };

describe('summary aggregates', () => {
  it('sums integer minor units exactly and skips non-numbers', () => {
    expect(sumDataTableColumn(rows, amount)).toBe(66345);
    expect(sumDataTableColumn(rows, qty)).toBe(3.5);
    expect(sumDataTableColumn(rows, item)).toBeNull();
    expect(sumDataTableColumn([], amount)).toBeNull();
  });

  it('refuses an integer sum past the safe-integer range', () => {
    const big = [
      { id: 'x', item: '', qty: 0, amount: Number.MAX_SAFE_INTEGER },
      { id: 'y', item: '', qty: 0, amount: 1 },
    ];
    expect(sumDataTableColumn(big, amount)).toBeNull();
  });

  it('sums a fractional value followed by an integer', () => {
    const fractionalFirst = [
      { id: 'x', item: '', qty: 1.5, amount: 0 },
      { id: 'y', item: '', qty: 2, amount: 0 },
    ];
    expect(sumDataTableColumn(fractionalFirst, qty)).toBe(3.5);
  });

  it('averages numeric values and counts rows', () => {
    expect(averageDataTableColumn(rows, amount)).toBe(33172.5);
    expect(averageDataTableColumn(rows, item)).toBeNull();
    expect(summarizeDataTableColumn(rows, item, 'count')).toBe(3);
    expect(
      summarizeDataTableColumn(rows, item, (r) => `${r.length} lines`),
    ).toBe('3 lines');
  });

  it('marks sum and avg as numeric', () => {
    expect(isNumericSummary('sum')).toBe(true);
    expect(isNumericSummary('avg')).toBe(true);
    expect(isNumericSummary('count')).toBe(false);
    expect(isNumericSummary(() => '')).toBe(false);
  });

  it('formats with Intl by default', () => {
    expect(
      formatDataTableSummary(1234.5, {
        kind: 'sum',
        columnId: 'q',
        locale: 'en',
      }),
    ).toBe('1,234.5');
  });
});

describe('buildDataTableSummaryRow', () => {
  it('builds one footer row; money stays minor units until summaryFormat', () => {
    const seen: number[] = [];
    const money: DataTableColumn<Line> = {
      ...amount,
      summaryFormat: (value) => {
        seen.push(value);
        return `$${(value / 100).toFixed(2)}`;
      },
    };
    const row = buildDataTableSummaryRow(
      rows,
      [item, qty, money],
      { item: 'count', qty: 'sum', amount: 'sum' },
      { label: 'Total', locale: 'en' },
    );
    expect(seen).toEqual([66345]);
    expect(row).toEqual({
      id: 'summary',
      kind: 'footer',
      label: 'Total',
      values: { item: '3', qty: '3.5', amount: '$663.45' },
    });
  });

  it('is null without summaries for a visible column', () => {
    expect(
      buildDataTableSummaryRow(rows, [item], undefined, { label: 'T' }),
    ).toBeNull();
    expect(
      buildDataTableSummaryRow(
        rows,
        [{ ...amount, hidden: true }],
        { amount: 'sum' },
        { label: 'T' },
      ),
    ).toBeNull();
  });

  it('leaves an empty cell when an aggregate has no numbers', () => {
    const row = buildDataTableSummaryRow(
      rows,
      [item],
      { item: 'sum' },
      {
        label: 'T',
      },
    );
    expect(row?.values).toEqual({ item: '' });
  });
});
