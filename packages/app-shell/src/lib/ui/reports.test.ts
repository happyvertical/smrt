import { reportCsv } from '@happyvertical/smrt-reports/display';
import { expect, it } from 'vitest';
import { description, preview } from '../../test/draft-fixtures.ts';
import { report, result } from '../../test/report-fixtures.ts';
import { publishGroups, publishLines } from './publish.ts';
import {
  keyColumns,
  reportCell,
  reportChanges,
  reportWords,
} from './reports.ts';

it('formats CSV exactly as displayed, with reference labels and formula-safe strings', () => {
  const data = {
    ...result,
    rows: [{ customer: 'c1', customerLabel: '=2+3', total: 3 }],
  };
  expect(reportCsv(data, reportCell)).toBe("Customer,Count\r\n'=2+3,3\r\n");
});
it('describes the spec and reuses formula words for calculated measures', () => {
  const models = description().models;
  models.Customer.fields.total = {
    type: 'money',
    label: 'Total',
    calculated: {
      op: 'mul',
      left: { col: 'quantity' },
      right: { col: 'price' },
    },
  };
  models.Customer.fields.quantity = { type: 'integer', label: 'Quantity' };
  models.Customer.fields.price = { type: 'money', label: 'Price' };
  const r = {
    ...report,
    spec: {
      ...report.spec,
      measures: [{ fn: 'sum' as const, field: 'total', as: 'total' }],
    },
  };
  expect(reportWords(r, models)).toContain('Sum of Total from');
  expect(reportWords(r, models)).toContain('Total is Quantity × Price.');
});
it('names added, changed, renamed and removed reports in review', () => {
  const changes = [
    ...reportChanges({}, { sales: report }),
    ...reportChanges(
      { sales: report },
      { sales: { ...report, description: 'changed' } },
    ),
    ...reportChanges(
      { sales: report },
      { newSales: report },
      'rename report sales -> newSales',
    ),
    ...reportChanges({ sales: report }, {}),
  ];
  const p = { ...preview, reportChanges: changes };
  expect(publishLines(p).join(' ')).toContain(
    'Added report Sales by customer.',
  );
  expect(publishGroups(p).flatMap((g) => g.items)).toEqual(
    expect.arrayContaining(changes.map((c) => c.text)),
  );
  expect(changes.map((c) => c.text).join(' ')).toContain(
    'Changed the link of report Sales by customer.',
  );
});

it('uses labels on both sides when a key rename also changes the visible name', () => {
  expect(
    reportChanges(
      { sales: report },
      { draftSummary: { ...report, label: 'Customer totals' } },
      'rename report sales -> draftSummary',
    ),
  ).toEqual([
    {
      kind: 'changed',
      text: 'Renamed report Sales by customer to Customer totals.',
    },
  ]);
});

const wide = {
  ...result,
  columns: [
    {
      id: 'customer',
      label: 'Customer',
      role: 'dimension' as const,
      type: 'string' as const,
    },
    {
      id: 'town',
      label: 'Town',
      role: 'dimension' as const,
      type: 'string' as const,
    },
    {
      id: 'spent',
      label: 'Money spent',
      role: 'measure' as const,
      type: 'integer' as const,
    },
    {
      id: 'avg',
      label: 'Average order',
      role: 'measure' as const,
      type: 'integer' as const,
    },
    {
      id: 'orders',
      label: 'Order count',
      role: 'measure' as const,
      type: 'integer' as const,
    },
    {
      id: 'last',
      label: 'Last order',
      role: 'measure' as const,
      type: 'integer' as const,
    },
  ],
  rows: [
    { customer: 'Maple', town: 'E', spent: 1, avg: 2, orders: 3, last: 4 },
  ],
  chart: { type: 'bar' as const, x: 'customer', y: ['spent', 'orders'] },
};
it('keeps the columns the report charts for the chat and counts the rest', () => {
  const key = keyColumns(wide);
  expect(key.result.columns.map((c) => c.id)).toEqual([
    'customer',
    'spent',
    'orders',
  ]);
  expect(key.hidden).toBe(3);
  expect(key.result.chart).toEqual({ type: 'table' });
  expect(key.result.rows).toBe(wide.rows);
});
it('shows the first column plus the ones the owner asked for, and counts the rest (#5608)', () => {
  const key = keyColumns(
    wide,
    3,
    'Top customers by money spent, with their order count and their town',
  );
  // four are asked for: the first three are shown, the rest counted
  expect(key.result.columns.map((c) => c.id)).toEqual([
    'customer',
    'town',
    'spent',
  ]);
  expect(key.hidden).toBe(3);
  const email = {
    ...wide,
    columns: [
      ...wide.columns.slice(0, 1),
      {
        id: 'email',
        label: 'Email',
        role: 'dimension' as const,
        type: 'string' as const,
      },
      ...wide.columns.slice(2),
    ],
  };
  const shown = keyColumns(email, 3, 'with their order count and their email');
  expect(shown.result.columns.map((c) => c.id)).toEqual([
    'customer',
    'email',
    'orders',
  ]);
  expect(shown.hidden).toBe(3);
  expect(shown.result.columns.length + shown.hidden).toBe(email.columns.length);
});
it('matches a plural label to a singular request and the reverse, and ignores a missing request (#5608)', () => {
  const plural = {
    ...wide,
    columns: wide.columns.map((c) =>
      c.id === 'orders' ? { ...c, label: 'Orders' } : c,
    ),
  };
  expect(
    keyColumns(plural, 3, 'show the order').result.columns.map((c) => c.id),
  ).toContain('orders');
  expect(keyColumns(wide, 3).result.columns.map((c) => c.id)).toEqual([
    'customer',
    'spent',
    'orders',
  ]);
});
it('falls back to the first columns, and shows a small report whole', () => {
  const plain = { ...wide, chart: { type: 'table' as const } };
  expect(keyColumns(plain).result.columns.map((c) => c.id)).toEqual([
    'customer',
    'town',
    'spent',
  ]);
  expect(keyColumns(result).hidden).toBe(0);
  expect(keyColumns(result).result.columns).toEqual(result.columns);
});
