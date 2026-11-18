import type { ImportPlan } from '@happyvertical/smrt-spreadsheets/import';
import { expect, it } from 'vitest';
import {
  EMPTY_APP,
  isValidFieldName,
  isValidModelName,
  tableFor,
} from './definition.ts';
import { importNames } from './import-names.ts';

it('allocates deterministic readable suffixes for reserved, duplicate, long and digit-leading names', () => {
  const keys = [
    'orders',
    'order',
    'order__items',
    'order_items',
    'profile',
    'app',
    'approval',
    'order_s',
    '2026_sales',
    'a'.repeat(63),
    `${'a'.repeat(62)}b`,
  ];
  const fields = [
    'id',
    'save',
    'constructor',
    'unit_price',
    'unit__price',
    'workbook_row',
    'workbook_lookup',
    '2026_total',
    'a_b_c',
    'a'.repeat(63),
    `${'a'.repeat(62)}b`,
  ];
  const plan: ImportPlan = {
    version: 1,
    tables: keys.map((key) => ({
      key,
      label: key,
      source: { sheet: 'S', range: 'A1:A2', headerRow: 1 },
      fields: fields.map((key) => ({ key, label: key, type: 'text' })),
    })),
  };
  const existing = { ...EMPTY_APP, models: { Orders: { fields: {} } } };
  const names = importNames(plan, existing);
  expect(names).toEqual(importNames(plan, existing));
  expect(keys.map((key) => names.tables[key].model)).toEqual([
    'Orders2',
    'Order2',
    'OrderItems',
    'OrderItems2',
    'Profile2',
    'App2',
    'Approval2',
    'OrderS3',
    'Table2026Sales',
    `A${'a'.repeat(39)}`,
    `A${'a'.repeat(38)}2`,
  ]);
  const allocated = names.tables.orders.fields;
  expect(allocated).toMatchObject({
    id: 'id2',
    save: 'save2',
    constructor: 'constructor2',
    unit_price: 'unitPrice',
    unit__price: 'unitPrice2',
    workbook_row: 'workbookRow2',
    workbook_lookup: 'workbookLookup2',
    '2026_total': 'field2026Total',
    a_b_c: 'aBvalueCvalue',
  });
  const models = Object.values(names.tables).map((t) => t.model);
  expect(models.every(isValidModelName)).toBe(true);
  expect(new Set(models.map((name) => name.toLowerCase())).size).toBe(
    models.length,
  );
  expect(new Set(models.map((name) => tableFor(name).toLowerCase())).size).toBe(
    models.length,
  );
  expect(
    Object.values(allocated).every(
      (name) => name.length <= 40 && isValidFieldName(name),
    ),
  ).toBe(true);
  expect(new Set(Object.values(allocated)).size).toBe(fields.length);
});
