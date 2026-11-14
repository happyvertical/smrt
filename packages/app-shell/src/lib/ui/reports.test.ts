import { reportCsv } from '@happyvertical/smrt-reports/display';
import { expect, it } from 'vitest';
import { description, preview } from '../../test/draft-fixtures.ts';
import { report, result } from '../../test/report-fixtures.ts';
import { publishGroups, publishLines } from './publish.ts';
import { reportCell, reportChanges, reportWords } from './reports.ts';

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
  expect(reportWords(r, models)).toContain('Total of Total (Quantity × Price)');
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
