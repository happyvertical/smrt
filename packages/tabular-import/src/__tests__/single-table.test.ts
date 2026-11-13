import { getSpreadsheets } from '@happyvertical/spreadsheets';
import { describe, expect, it } from 'vitest';
import { checkPlan, planLoad, runImport, validatePlan } from '../index.js';
import { createSqliteReferenceTarget } from '../testing.js';
import { day, planOf, sheetOf, workbookOf } from './helpers.js';

const plan = planOf([
  {
    key: 'items',
    label: 'Items',
    source: { sheet: 'Items', range: 'A1:G8', headerRow: 1, skipRows: [7] },
    lookupKey: ['name'],
    titleField: 'name',
    fields: [
      { key: 'name', label: 'Name', type: 'text', column: 1, required: true },
      { key: 'qty', label: 'Qty', type: 'integer', column: 2 },
      { key: 'weight', label: 'Weight', type: 'number', column: 3 },
      { key: 'added', label: 'Added', type: 'date', column: 4 },
      { key: 'active', label: 'Active', type: 'boolean', column: 5 },
      {
        key: 'status',
        label: 'Status',
        type: 'choice',
        column: 6,
        choices: ['new', 'used'],
      },
      {
        key: 'price',
        label: 'Price',
        type: 'money',
        column: 7,
        money: { currency: 'USD', scale: 2 },
      },
    ],
  },
]);

const workbook = () =>
  workbookOf(
    sheetOf('Items', [
      ['Name', 'Qty', 'Weight', 'Added', 'Active', 'Status', 'Price'],
      ['Anvil', 3, 12.5, day('2024-03-01'), true, 'new', 19.99],
      ['Bolt', 100, 0.1, day('2024-03-02'), 'yes', ' used ', 0.05],
      ['Cog', 0, 7, day('2024-03-03'), false, 'new', 1200],
      [null, null, null, null, null, null, null],
      ['Dowel', null, null, null, null, null, null],
      ['Total', 103, 19.6, null, null, null, 1220.04],
      [],
    ]),
  );

describe('single table', () => {
  it('validates, checks and plans exact records', () => {
    const wb = workbook();
    const checked = checkPlan(validatePlan(plan), wb);
    expect(checked.findings).toEqual([]);
    expect(checked.ok).toBe(true);
    expect(checked.facts.tables.items).toEqual({
      read: 6,
      skipped: 2,
      rejected: 0,
      planned: 4,
    });
    expect(checked.facts.sums.items).toEqual({
      qty: 103,
      weight: 19.6,
      price: 122004,
    });

    const batches = [...planLoad(plan, wb, { batchSize: 3 }).batches()];
    expect(batches.map((b) => [b.table, b.index, b.records.length])).toEqual([
      ['items', 0, 3],
      ['items', 1, 1],
    ]);
    expect(batches.flatMap((b) => b.records)).toEqual([
      {
        sourceRow: 2,
        values: {
          name: 'Anvil',
          qty: 3,
          weight: 12.5,
          added: '2024-03-01',
          active: true,
          status: 'new',
          price: 1999,
        },
        references: {},
      },
      {
        sourceRow: 3,
        values: {
          name: 'Bolt',
          qty: 100,
          weight: 0.1,
          added: '2024-03-02',
          active: true,
          status: 'used',
          price: 5,
        },
        references: {},
      },
      {
        sourceRow: 4,
        values: {
          name: 'Cog',
          qty: 0,
          weight: 7,
          added: '2024-03-03',
          active: false,
          status: 'new',
          price: 120000,
        },
        references: {},
      },
      {
        sourceRow: 6,
        values: {
          name: 'Dowel',
          qty: null,
          weight: null,
          added: null,
          active: null,
          status: null,
          price: null,
        },
        references: {},
      },
    ]);
  });

  it('loads and reads back exactly what the workbook held', async () => {
    const target = await createSqliteReferenceTarget();
    try {
      const result = await runImport({ plan, workbook: workbook(), target });
      expect(result.findings).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.loaded).toEqual({ items: 4 });

      const rows: unknown[] = [];
      for await (const row of target.values('items', [
        'name',
        'qty',
        'weight',
        'added',
        'active',
        'status',
        'price',
      ])) {
        rows.push(row);
      }
      expect(rows).toEqual([
        {
          sourceRow: 2,
          values: {
            name: 'Anvil',
            qty: 3,
            weight: 12.5,
            added: '2024-03-01',
            active: true,
            status: 'new',
            price: 1999,
          },
        },
        {
          sourceRow: 3,
          values: {
            name: 'Bolt',
            qty: 100,
            weight: 0.1,
            added: '2024-03-02',
            active: true,
            status: 'used',
            price: 5,
          },
        },
        {
          sourceRow: 4,
          values: {
            name: 'Cog',
            qty: 0,
            weight: 7,
            added: '2024-03-03',
            active: false,
            status: 'new',
            price: 120000,
          },
        },
        {
          sourceRow: 6,
          values: {
            name: 'Dowel',
            qty: null,
            weight: null,
            added: null,
            active: null,
            status: null,
            price: null,
          },
        },
      ]);
      expect(await target.sum('items', 'price')).toBe(122004);
    } finally {
      await target.close();
    }
  });

  it('survives an xlsx round trip through the SDK adapter', async () => {
    const adapter = await getSpreadsheets({ type: 'xlsx' });
    const bytes = await adapter.write(workbook());
    const reread = await adapter.read(bytes);
    const direct = checkPlan(plan, workbook());
    const viaFile = checkPlan(plan, reread);
    expect(viaFile.findings).toEqual([]);
    expect(viaFile.facts).toEqual(direct.facts);
    expect([...planLoad(plan, reread).batches()]).toEqual([
      ...planLoad(plan, workbook()).batches(),
    ]);

    const target = await createSqliteReferenceTarget();
    try {
      const result = await runImport({ plan, workbook: reread, target });
      expect(result.ok).toBe(true);
      expect(result.loaded).toEqual({ items: 4 });
    } finally {
      await target.close();
    }
  });

  it('keeps identifier-looking text intact through a csv round trip', async () => {
    const csv = await getSpreadsheets({ type: 'csv', sheetName: 'Codes' });
    const bytes = new TextEncoder().encode(
      'Code,Count\n007,3\n1234567890123456789,4\n',
    );
    const wb = await csv.read(bytes);
    const codes = planOf([
      {
        key: 'codes',
        label: 'Codes',
        source: { sheet: 'Codes', range: 'A1:B3', headerRow: 1 },
        fields: [
          { key: 'code', label: 'Code', type: 'text', column: 1 },
          { key: 'count', label: 'Count', type: 'integer', column: 2 },
        ],
      },
    ]);
    const batches = [...planLoad(codes, wb).batches()];
    expect(batches[0].records.map((r) => r.values)).toEqual([
      { code: '007', count: 3 },
      { code: '1234567890123456789', count: 4 },
    ]);
  });
});
