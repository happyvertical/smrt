import { describe, expect, it } from 'vitest';
import { checkPlan, planLoad, runImport } from '../index.js';
import { createSqliteReferenceTarget } from '../testing.js';
import { planOf, sheetOf, workbookOf } from './helpers.js';

// Orders sheet: one row per order line; regions are extracted into a lookup table.
const plan = planOf([
  {
    key: 'orders',
    label: 'Orders',
    source: { sheet: 'Orders', range: 'A1:D6', headerRow: 1 },
    lookupKey: ['number'],
    fields: [
      {
        key: 'number',
        label: 'Number',
        type: 'integer',
        column: 1,
        required: true,
      },
      {
        key: 'customer',
        label: 'Customer',
        type: 'reference',
        required: true,
        reference: { table: 'customers', by: ['name'], columns: [2] },
      },
      {
        key: 'region',
        label: 'Region',
        type: 'reference',
        reference: { table: 'regions', by: ['name'], columns: [4] },
      },
      { key: 'total', label: 'Total', type: 'integer', column: 3 },
    ],
  },
  {
    key: 'customers',
    label: 'Customers',
    source: { sheet: 'Customers', range: 'A1:B5', headerRow: 1 },
    lookupKey: ['name'],
    fields: [
      { key: 'name', label: 'Name', type: 'text', column: 1, required: true },
      { key: 'email', label: 'Email', type: 'text', column: 2 },
    ],
  },
  {
    key: 'regions',
    label: 'Regions',
    source: { sheet: 'Orders', range: 'A1:D6', headerRow: 1, distinct: true },
    lookupKey: ['name'],
    fields: [
      { key: 'name', label: 'Region', type: 'text', column: 4, required: true },
    ],
  },
]);

const workbook = () =>
  workbookOf(
    sheetOf('Orders', [
      ['Number', 'Customer', 'Total', 'Region'],
      [1001, 'Ada', 50, 'North'],
      [1002, 'Grace', 75, 'South'],
      [1003, 'Ada', 20, 'North'],
      [1004, 'Linus', 5, 'West'],
      [1005, 'Grace', 10, 'South'],
    ]),
    sheetOf('Customers', [
      ['Name', 'Email'],
      ['Ada', 'ada@example.test'],
      ['Grace', 'grace@example.test'],
      ['Linus', null],
    ]),
  );

describe('related tables', () => {
  it('orders tables with referenced ones first and de-duplicates a distinct table', () => {
    const load = planLoad(plan, workbook());
    expect(load.order).toEqual(['customers', 'regions', 'orders']);
    const batches = [...load.batches()];
    expect(batches.map((b) => b.table)).toEqual([
      'customers',
      'regions',
      'orders',
    ]);
    expect(batches[1].records).toEqual([
      { sourceRow: 2, values: { name: 'North' }, references: {} },
      { sourceRow: 3, values: { name: 'South' }, references: {} },
      { sourceRow: 5, values: { name: 'West' }, references: {} },
    ]);
    expect(batches[2].records[0]).toEqual({
      sourceRow: 2,
      values: { number: 1001, total: 50 },
      references: {
        customer: { table: 'customers', key: ['Ada'] },
        region: { table: 'regions', key: ['North'] },
      },
    });
    const facts = checkPlan(plan, workbook()).facts;
    expect(facts.tables.regions).toEqual({
      read: 5,
      skipped: 0,
      rejected: 0,
      planned: 3,
    });
  });

  it('loads references by lookup key and proves the counts and sums', async () => {
    const target = await createSqliteReferenceTarget();
    try {
      const result = await runImport({
        plan,
        workbook: workbook(),
        target,
        batchSize: 2,
      });
      expect(result.findings).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.loaded).toEqual({ customers: 3, regions: 3, orders: 5 });
      const joined = await target.db.query(
        'SELECT o."number" AS n, c."name" AS customer, r."name" AS region FROM "orders" o JOIN "customers" c ON c."_row_id" = o."customer" JOIN "regions" r ON r."_row_id" = o."region" ORDER BY o."number"',
      );
      expect(joined.rows.map((r) => [r.n, r.customer, r.region])).toEqual([
        [1001, 'Ada', 'North'],
        [1002, 'Grace', 'South'],
        [1003, 'Ada', 'North'],
        [1004, 'Linus', 'West'],
        [1005, 'Grace', 'South'],
      ]);
    } finally {
      await target.close();
    }
  });
});
