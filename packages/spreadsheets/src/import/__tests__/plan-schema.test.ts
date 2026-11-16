import Ajv from 'ajv';
import { expect, it } from 'vitest';
import { IMPORT_PLAN_SCHEMA, type ImportPlan, validatePlan } from '../index.js';

const accepts = new Ajv({ strict: false }).compile(IMPORT_PLAN_SCHEMA);
it('accepts the validatePlan fixture shapes including expressions, references and optional members', () => {
  const plan: ImportPlan = {
    version: 1,
    tables: [
      {
        key: 'customers',
        label: 'Customers',
        source: {
          sheet: 'People',
          range: 'A3:B8',
          headerRow: 3,
          skipRows: [8],
          distinct: true,
        },
        lookupKey: ['name'],
        titleField: 'name',
        fields: [
          {
            key: 'name',
            label: 'Name',
            type: 'text',
            column: 1,
            required: true,
          },
          {
            key: 'status',
            label: 'Status',
            type: 'choice',
            column: 2,
            choices: ['Open', 'Closed'],
          },
        ],
      },
      {
        key: 'orders',
        label: 'Orders',
        source: { sheet: 'Orders', range: 'A1:E4', headerRow: 1 },
        fields: [
          {
            key: 'customer',
            label: 'Customer',
            type: 'reference',
            reference: { table: 'customers', by: ['name'], columns: [1] },
          },
          {
            key: 'price',
            label: 'Price',
            type: 'money',
            column: 2,
            money: { currency: 'CAD', scale: 2 },
          },
          { key: 'quantity', label: 'Quantity', type: 'integer', column: 3 },
          {
            key: 'total',
            label: 'Total',
            type: 'money',
            money: { currency: 'CAD', scale: 2 },
            cachedColumn: 4,
            calculated: {
              op: 'mul',
              left: { col: 'price' },
              right: { col: 'quantity' },
            },
          },
        ],
      },
    ],
    reports: [{ key: 'sales', label: 'Sales', spec: { source: 'orders' } }],
  };
  expect(accepts(validatePlan(plan)), JSON.stringify(accepts.errors)).toBe(
    true,
  );
  for (const type of [
    'text',
    'number',
    'integer',
    'boolean',
    'date',
  ] as const) {
    const single = {
      version: 1,
      tables: [
        {
          key: 'items',
          label: 'Items',
          source: { sheet: 'S', range: 'A1:A2', headerRow: 1 },
          fields: [{ key: 'value', label: 'Value', type, column: 1 }],
        },
      ],
    };
    expect(accepts(validatePlan(single))).toBe(true);
  }
});
it('rejects unknown shapes, sources and types before semantic validation', () => {
  for (const value of [
    null,
    {},
    { version: 2, tables: [] },
    { version: 1, tables: [], surprise: true },
    {
      version: 1,
      tables: [
        {
          key: 'items',
          label: 'Items',
          source: {},
          fields: [{ key: 'x', label: 'X', type: 'unknown' }],
        },
      ],
    },
  ])
    expect(accepts(value)).toBe(false);
});

it('accepts every published worked example and refuses the previous opaque-expression hole', async () => {
  const { IMPORT_PLAN_EXAMPLES, IMPORT_PLAN_GUIDE } = await import(
    '../index.js'
  );
  for (const example of IMPORT_PLAN_EXAMPLES) {
    expect(accepts(validatePlan(example)), JSON.stringify(accepts.errors)).toBe(
      true,
    );
  }
  expect(IMPORT_PLAN_GUIDE).toContain('cached values are imported');
  const plan = structuredClone(
    IMPORT_PLAN_EXAMPLES[0],
  ) as unknown as ImportPlan;
  for (const calculated of [
    'D5*E5',
    { op: '*', left: { col: 'unit_price' }, right: { col: 'qty' } },
    { op: 'mul', args: [{ col: 'unit_price' }, { col: 'qty' }] },
    { op: 'mul', left: { col: 'unit_price' } },
    { col: 'qty', extra: true },
    { op: 'case', branches: [], else: { value: 0 } },
  ]) {
    plan.tables[0].fields[2].calculated =
      calculated as ImportPlan['tables'][number]['fields'][number]['calculated'];
    expect(accepts(plan)).toBe(false);
    expect(() => validatePlan(plan)).toThrow();
  }
});
