import { expect, it } from 'vitest';
import { versionSummary } from './command-summary.ts';

const definition = {
  models: {
    InternalOrders: {
      label: 'Orders',
      fields: {
        rawPrice: { type: 'money' as const, label: 'Unit price' },
        rawQty: { type: 'integer' as const, label: 'Quantity' },
        rawTotal: {
          type: 'money' as const,
          label: 'Total',
          calculated: {
            op: 'mul' as const,
            left: { col: 'rawPrice' },
            right: { col: 'rawQty' },
          },
        },
        rawLookup: { type: 'text' as const, label: 'Workbook lookup' },
        rawRenamed: { type: 'text' as const, label: 'Workbook lookup' },
      },
    },
  },
  reports: {
    rawSales: { label: 'Sales by status' },
    rawRenamedSales: { label: 'Sales by status' },
  },
};

it.each([
  ['define InternalOrders', 'Add model: Orders'],
  ['remove model InternalOrders', 'Remove model: Orders'],
  ['add InternalOrders.rawLookup', 'Add field: Workbook lookup in Orders'],
  [
    'remove InternalOrders.rawLookup',
    'Remove field: Workbook lookup in Orders',
  ],
  ['hide InternalOrders.rawLookup', 'Hide field: Workbook lookup in Orders'],
  [
    'rename InternalOrders.rawLookup -> rawRenamed',
    'Change field link: Workbook lookup in Orders',
  ],
  [
    'change InternalOrders.rawLookup to text',
    'Change field type: Workbook lookup in Orders',
  ],
  [
    'set calculation InternalOrders.rawTotal',
    'Change calculation: Total in Orders = Unit price × Quantity',
  ],
  ['load 42 InternalOrders records', 'Load 42 records into Orders'],
  [
    'merge 2 InternalOrders records into private-record-id',
    'Merge 2 records in Orders',
  ],
  [
    'extract InternalOrders.rawLookup into NewModel',
    'Make linked records from Workbook lookup in Orders',
  ],
  ['define report rawSales', 'Change report: Sales by status'],
  ['remove report rawSales', 'Remove report: Sales by status'],
  [
    'rename report rawSales -> rawRenamedSales',
    'Change report link: Sales by status',
  ],
  ['add method InternalOrders.rawMethod', 'Add code to Orders'],
  ['replace method InternalOrders.rawMethod', 'Change code in Orders'],
  ['enable profiles', 'Enable recipe: Profiles'],
  ['import template', 'Import app template'],
  ['clean up: keep the last 20 changes undoable', 'Clean up older changes'],
  ['undo 2 changes', 'Undo changes'],
  [
    'undo: hide InternalOrders.rawLookup',
    'Undo: hide field: Workbook lookup in Orders',
  ],
  ['published 20 changes', 'Publish draft'],
  ['unknown command with private-record-id', 'Change your app'],
])('formats %s for History and announcements without internal paths', (raw, expected) => {
  const actual = versionSummary(raw, definition, definition);
  expect(actual).toBe(expected);
  expect(actual).not.toMatch(/InternalOrders|raw[A-Z]|private-record-id/);
});
